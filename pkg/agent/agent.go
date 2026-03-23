package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/arjungandhi/tobor/pkg/llm"
	"github.com/arjungandhi/tobor/pkg/tools"
)

var ErrMaxTurns = errors.New("agent: max turns reached")

type Agent struct {
	llm      llm.LLM
	tools    map[string]tools.Tool
	system   string
	maxTurns int
}

func New(l llm.LLM, system string, maxTurns int, ts ...tools.Tool) *Agent {
	tm := make(map[string]tools.Tool, len(ts))
	for _, t := range ts {
		tm[t.Name()] = t
	}
	return &Agent{llm: l, tools: tm, system: system, maxTurns: maxTurns}
}

// Run processes a conversation (history + new user message) and returns the
// assistant's final text response.
func (a *Agent) Run(ctx context.Context, history []llm.Message, userMsg string) (string, error) {
	messages := make([]llm.Message, len(history))
	copy(messages, history)
	messages = append(messages, llm.Message{Role: "user", Content: userMsg})

	toolDefs := a.toolDefs()
	var pendingResults []llm.ToolResult

	for turn := 0; turn < a.maxTurns; turn++ {
		slog.Debug("agent turn", "turn", turn+1, "max_turns", a.maxTurns, "messages", len(messages))

		req := llm.Request{
			System:      a.system,
			Messages:    messages,
			ToolResults: pendingResults,
			Tools:       toolDefs,
		}
		pendingResults = nil

		resp, err := a.llm.Complete(ctx, req)
		if err != nil {
			return "", err
		}

		slog.Debug("agent turn result",
			"turn", turn+1,
			"stop_reason", resp.StopReason,
			"tool_calls", len(resp.ToolCalls),
			"input_tokens", resp.InputTokens,
			"output_tokens", resp.OutputTokens,
		)

		switch resp.StopReason {
		case "end_turn":
			slog.Debug("agent complete", "turns_used", turn+1)
			return resp.Text, nil

		case "tool_use":
			names := make([]string, len(resp.ToolCalls))
			for i, tc := range resp.ToolCalls {
				names[i] = tc.Name
			}
			slog.Info("agent dispatching tools", "turn", turn+1, "tools", names)

			results, err := a.dispatchTools(ctx, resp.ToolCalls)
			if err != nil {
				return "", err
			}
			// record the assistant turn with its tool calls in history
			messages = append(messages, llm.Message{
				Role:      "assistant",
				Content:   resp.Text,
				ToolCalls: resp.ToolCalls,
			})
			pendingResults = results

		case "max_tokens":
			return "", fmt.Errorf("agent: LLM hit max_tokens limit")

		default:
			return "", fmt.Errorf("agent: unexpected stop_reason %q", resp.StopReason)
		}
	}

	return "", ErrMaxTurns
}

// dispatchTools runs all tool calls concurrently and collects results.
func (a *Agent) dispatchTools(ctx context.Context, calls []llm.ToolCall) ([]llm.ToolResult, error) {
	results := make([]llm.ToolResult, len(calls))
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for i, call := range calls {
		wg.Add(1)
		go func(i int, call llm.ToolCall) {
			defer wg.Done()
			result, err := a.callTool(ctx, call)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = err
			}
			results[i] = result
		}(i, call)
	}
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

func (a *Agent) callTool(ctx context.Context, call llm.ToolCall) (llm.ToolResult, error) {
	t, ok := a.tools[call.Name]
	if !ok {
		slog.Warn("unknown tool", "tool", call.Name)
		return llm.ToolResult{
			ID:      call.ID,
			Content: fmt.Sprintf("error: unknown tool %q", call.Name),
		}, nil
	}

	slog.Info("tool call", "tool", call.Name, "input", truncate(string(call.Input), 200))
	out, err := t.Call(ctx, json.RawMessage(call.Input))
	if err != nil {
		slog.Warn("tool call failed", "tool", call.Name, "err", err)
		// return error as tool result content so the LLM can reason about it
		return llm.ToolResult{
			ID:      call.ID,
			Content: fmt.Sprintf("error: %s", err),
		}, nil
	}
	slog.Info("tool result", "tool", call.Name, "output", truncate(out, 200))
	return llm.ToolResult{ID: call.ID, Content: out}, nil
}

// truncate shortens s to at most n bytes, appending "…" if truncated.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (a *Agent) toolDefs() []llm.ToolDef {
	defs := make([]llm.ToolDef, 0, len(a.tools))
	for _, t := range a.tools {
		defs = append(defs, llm.ToolDef{
			Name:        t.Name(),
			Description: t.Description(),
			Schema:      t.Schema(),
		})
	}
	return defs
}
