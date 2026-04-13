package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

const defaultOllamaModel = "qwen2.5:7b"

type OllamaLLM struct {
	baseURL string
	model   string
	client  *http.Client
}

func NewOllama(baseURL, model string) *OllamaLLM {
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	if model == "" {
		model = defaultOllamaModel
	}
	return &OllamaLLM{
		baseURL: baseURL,
		model:   model,
		client:  &http.Client{Timeout: 5 * time.Minute},
	}
}

// Ollama request/response types

type ollamaRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Tools    []ollamaTool    `json:"tools,omitempty"`
	Stream   bool            `json:"stream"`
}

type ollamaMessage struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls []ollamaToolCall `json:"tool_calls,omitempty"`
	ToolName  string           `json:"tool_name,omitempty"`
}

type ollamaToolCall struct {
	Function ollamaFunction `json:"function"`
}

type ollamaFunction struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type ollamaTool struct {
	Type     string             `json:"type"`
	Function ollamaToolFunction `json:"function"`
}

type ollamaToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type ollamaResponse struct {
	Message         ollamaMessage `json:"message"`
	Done            bool          `json:"done"`
	DoneReason      string        `json:"done_reason"`
	PromptEvalCount int           `json:"prompt_eval_count"`
	EvalCount       int           `json:"eval_count"`
}

func (o *OllamaLLM) Complete(ctx context.Context, req Request) (Response, error) {
	msgs := buildOllamaMessages(req)
	tools := buildOllamaTools(req.Tools)

	body := ollamaRequest{
		Model:    o.model,
		Messages: msgs,
		Tools:    tools,
		Stream:   false,
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return Response{}, fmt.Errorf("ollama: marshal request: %w", err)
	}

	slog.Debug("llm request", "model", o.model, "messages", len(msgs), "tools", len(tools))
	start := time.Now()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return Response{}, fmt.Errorf("ollama: create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	httpResp, err := o.client.Do(httpReq)
	if err != nil {
		return Response{}, fmt.Errorf("ollama: %w", err)
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return Response{}, fmt.Errorf("ollama: read response: %w", err)
	}

	if httpResp.StatusCode != http.StatusOK {
		return Response{}, fmt.Errorf("ollama: HTTP %d: %s", httpResp.StatusCode, respBody)
	}

	var oResp ollamaResponse
	if err := json.Unmarshal(respBody, &oResp); err != nil {
		return Response{}, fmt.Errorf("ollama: unmarshal response: %w", err)
	}

	r := parseOllamaResponse(oResp)
	slog.Debug("llm response",
		"model", o.model,
		"stop_reason", r.StopReason,
		"input_tokens", r.InputTokens,
		"output_tokens", r.OutputTokens,
		"latency_ms", time.Since(start).Milliseconds(),
	)
	return r, nil
}

func buildOllamaMessages(req Request) []ollamaMessage {
	var msgs []ollamaMessage

	// System message as the first message.
	if req.System != "" {
		msgs = append(msgs, ollamaMessage{
			Role:    "system",
			Content: req.System,
		})
	}

	for _, m := range req.Messages {
		switch m.Role {
		case "user":
			if len(m.ToolResults) > 0 {
				for _, tr := range m.ToolResults {
					msgs = append(msgs, ollamaMessage{
						Role:     "tool",
						Content:  tr.Content,
						ToolName: tr.ID, // ID carries the tool name for Ollama
					})
				}
			} else {
				msgs = append(msgs, ollamaMessage{
					Role:    "user",
					Content: m.Content,
				})
			}
		case "tobor":
			msg := ollamaMessage{
				Role:    "assistant",
				Content: m.Content,
			}
			for _, tc := range m.ToolCalls {
				msg.ToolCalls = append(msg.ToolCalls, ollamaToolCall{
					Function: ollamaFunction{
						Name:      tc.Name,
						Arguments: tc.Input,
					},
				})
			}
			msgs = append(msgs, msg)
		}
	}

	return msgs
}

func buildOllamaTools(defs []ToolDef) []ollamaTool {
	tools := make([]ollamaTool, 0, len(defs))
	for _, d := range defs {
		schema := d.Schema
		if len(schema) == 0 {
			schema = []byte(`{"type":"object","properties":{}}`)
		}
		tools = append(tools, ollamaTool{
			Type: "function",
			Function: ollamaToolFunction{
				Name:        d.Name,
				Description: d.Description,
				Parameters:  schema,
			},
		})
	}
	return tools
}

func parseOllamaResponse(resp ollamaResponse) Response {
	r := Response{
		Text:         resp.Message.Content,
		InputTokens:  resp.PromptEvalCount,
		OutputTokens: resp.EvalCount,
	}

	if len(resp.Message.ToolCalls) > 0 {
		r.StopReason = "tool_use"
		for _, tc := range resp.Message.ToolCalls {
			input, _ := json.Marshal(tc.Function.Arguments)
			r.ToolCalls = append(r.ToolCalls, ToolCall{
				ID:    tc.Function.Name, // Ollama has no tool call IDs; use name
				Name:  tc.Function.Name,
				Input: input,
			})
		}
	} else {
		r.StopReason = "end_turn"
	}

	return r
}
