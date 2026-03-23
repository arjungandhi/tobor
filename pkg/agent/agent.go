package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

		switch resp.StopReason {
		case "end_turn":
			return resp.Text, nil

		case "tool_use":
			results, err := a.dispatchTools(ctx, resp.ToolCalls)
			if err != nil {
				return "", err
			}
			// record the assistant turn with its tool calls in history
			messages = append(messages, llm.Message{
				Role:    "assistant",
				Content: resp.Text, // may be empty
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
		return llm.ToolResult{
			ID:      call.ID,
			Content: fmt.Sprintf("error: unknown tool %q", call.Name),
		}, nil
	}

	out, err := t.Call(ctx, json.RawMessage(call.Input))
	if err != nil {
		// return error as tool result content so the LLM can reason about it
		return llm.ToolResult{
			ID:      call.ID,
			Content: fmt.Sprintf("error: %s", err),
		}, nil
	}
	return llm.ToolResult{ID: call.ID, Content: out}, nil
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
