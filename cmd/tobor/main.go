package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/arjungandhi/tobor/pkg/agent"
	"github.com/arjungandhi/tobor/pkg/config"
	"github.com/arjungandhi/tobor/pkg/llm"
	"github.com/arjungandhi/tobor/pkg/memory"
	"github.com/arjungandhi/tobor/pkg/socket"
	"github.com/arjungandhi/tobor/pkg/tools"
	"github.com/spf13/cobra"
)

func main() {
	level := slog.LevelInfo
	if strings.EqualFold(os.Getenv("TOBOR_LOG_LEVEL"), "debug") {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	root := &cobra.Command{
		Use:   "tobor",
		Short: "Tobor personal assistant daemon",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServe(cfg)
		},
	}

	var evType, roomID, sender, text string
	sendCmd := &cobra.Command{
		Use:   "send",
		Short: "Send an event to tobor via the socket",
		RunE: func(cmd *cobra.Command, args []string) error {
			if roomID == "" {
				roomID = cfg.DefaultRoom
			}
			if sender == "" {
				sender = cfg.AuthSender
			}
			if evType == "" {
				evType = "message"
			}
			return runSend(cfg.SocketPath, evType, sender, roomID, text)
		},
	}
	sendCmd.Flags().StringVar(&evType, "type", "", "event type (default: message)")
	sendCmd.Flags().StringVar(&roomID, "room", "", "room ID (default: config default_room)")
	sendCmd.Flags().StringVar(&sender, "sender", "", "sender ID (default: config auth_sender)")
	sendCmd.Flags().StringVar(&text, "text", "", "message text")

	root.AddCommand(sendCmd)

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func runServe(cfg *config.Config) error {
	if err := os.MkdirAll(cfg.WorkDir, 0o700); err != nil {
		return fmt.Errorf("create work_dir: %w", err)
	}

	system, err := loadSystem(cfg.WorkDir)
	if err != nil {
		return fmt.Errorf("load system prompt: %w", err)
	}

	eventLog := memory.NewEventLog(filepath.Join(cfg.WorkDir, "log.jsonl.gz"))
	if err := eventLog.Prune(cfg.LogRetentionDays); err != nil {
		slog.Warn("prune log", "err", err)
	}

	toolList, err := tools.LoadDir(filepath.Join(cfg.WorkDir, "tools"))
	if err != nil {
		return fmt.Errorf("load tools: %w", err)
	}
	slog.Info("loaded tools", "count", len(toolList))

	shortMem := memory.NewShortTerm(cfg.ContextTokenBudget, cfg.IdleTimeout)
	llmClient := llm.NewAnthropic(cfg.AnthropicAPIKey)
	ag := agent.New(llmClient, system, cfg.MaxTurns, toolList...)

	var roomMu sync.Map

	listener := socket.New(cfg.SocketPath)
	handler := func(ev socket.Event) {
		if ev.Sender != cfg.AuthSender {
			slog.Debug("dropped event from unauthorized sender", "sender", ev.Sender)
			return
		}

		mu, _ := roomMu.LoadOrStore(ev.RoomID, &sync.Mutex{})
		go func() {
			mu.(*sync.Mutex).Lock()
			defer mu.(*sync.Mutex).Unlock()

			ctx := context.Background()
			history := shortMem.Get(ev.RoomID)

			slog.Info("processing event",
				"type", ev.Type,
				"room", ev.RoomID,
				"sender", ev.Sender,
				"text_len", len(ev.Text),
				"history_msgs", len(history),
			)

			start := time.Now()
			response, err := ag.Run(ctx, history, ev.Text)
			if err != nil {
				slog.Error("agent run failed", "room", ev.RoomID, "err", err, "duration_ms", time.Since(start).Milliseconds())
				errOut := struct {
					RoomID string `json:"room_id"`
					Text   string `json:"text"`
				}{RoomID: ev.RoomID, Text: fmt.Sprintf("error processing message: %v", err)}
				if encErr := json.NewEncoder(os.Stdout).Encode(errOut); encErr != nil {
					slog.Error("encode error response", "err", encErr)
				}
				return
			}

			slog.Info("agent responded",
				"room", ev.RoomID,
				"response_len", len(response),
				"duration_ms", time.Since(start).Milliseconds(),
			)

			out := struct {
				RoomID string `json:"room_id"`
				Text   string `json:"text"`
			}{RoomID: ev.RoomID, Text: response}
			if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
				slog.Error("encode response", "err", err)
			}

			shortMem.Append(ev.RoomID,
				llm.Message{Role: "user", Content: ev.Text},
				llm.Message{Role: "assistant", Content: response},
			)

			if err := eventLog.Append(memory.LogEntry{
				Timestamp: ev.Timestamp,
				EventType: ev.Type,
				RoomID:    ev.RoomID,
				Input:     ev.Text,
				Response:  response,
			}); err != nil {
				slog.Warn("failed to write log entry", "err", err)
			}
		}()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		slog.Info("shutting down")
		os.Remove(cfg.SocketPath)
		os.Exit(0)
	}()

	slog.Info("tobor listening", "socket", cfg.SocketPath)
	return listener.Listen(handler)
}

func runSend(socketPath, evType, sender, roomID, text string) error {
	ev := socket.Event{
		Type:      evType,
		RoomID:    roomID,
		Sender:    sender,
		Text:      text,
		Timestamp: time.Now(),
	}

	data, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	data = append(data, '\n')

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return fmt.Errorf("connect to socket %s: %w", socketPath, err)
	}
	defer conn.Close()

	_, err = conn.Write(data)
	return err
}

func loadSystem(workDir string) (string, error) {
	var parts []string
	for _, name := range []string{"soul.md", "style.md"} {
		data, err := os.ReadFile(filepath.Join(workDir, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", err
		}
		parts = append(parts, string(data))
	}
	return strings.Join(parts, "\n\n"), nil
}
