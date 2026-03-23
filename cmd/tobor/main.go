package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/arjungandhi/tobor/pkg/agent"
	"github.com/arjungandhi/tobor/pkg/config"
	"github.com/arjungandhi/tobor/pkg/llm"
	"github.com/arjungandhi/tobor/pkg/memory"
	"github.com/arjungandhi/tobor/pkg/socket"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.WorkDir, 0o700); err != nil {
		slog.Error("create work_dir", "err", err)
		os.Exit(1)
	}

	system, err := loadSystem(cfg.WorkDir)
	if err != nil {
		slog.Error("load system prompt", "err", err)
		os.Exit(1)
	}

	eventLog := memory.NewEventLog(filepath.Join(cfg.WorkDir, "log.jsonl.gz"))
	if err := eventLog.Prune(cfg.LogRetentionDays); err != nil {
		slog.Warn("prune log", "err", err)
	}

	shortMem := memory.NewShortTerm(cfg.ContextTokenBudget, cfg.IdleTimeout)
	llmClient := llm.NewAnthropic(cfg.AnthropicAPIKey)
	ag := agent.New(llmClient, system, cfg.MaxTurns /* tools will be added here */)

	// per-room mutexes to serialize goroutines within a room
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

			slog.Info("processing event", "type", ev.Type, "room", ev.RoomID, "sender", ev.Sender)

			response, err := ag.Run(ctx, history, ev.Text)
			if err != nil {
				slog.Error("agent run failed", "room", ev.RoomID, "err", err)
				return
			}

			slog.Info("agent responded", "room", ev.RoomID, "response_len", len(response))

			// print to stdout — piped to `messages send` by the caller
			out := struct {
				RoomID string `json:"room_id"`
				Text   string `json:"text"`
			}{RoomID: ev.RoomID, Text: response}
			if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
				slog.Error("encode response", "err", err)
			}

			// update conversation history
			shortMem.Append(ev.RoomID,
				llm.Message{Role: "user", Content: ev.Text},
				llm.Message{Role: "assistant", Content: response},
			)

			// write log entry
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
	if err := listener.Listen(handler); err != nil {
		slog.Error("socket listener failed", "err", err)
		os.Exit(1)
	}
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
