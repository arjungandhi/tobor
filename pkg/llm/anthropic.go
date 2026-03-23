package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

const defaultModel = anthropic.ModelClaudeSonnet4_6

type AnthropicLLM struct {
	client anthropic.Client
	model  anthropic.Model
}

func NewAnthropic(apiKey string) *AnthropicLLM {
	client := anthropic.NewClient(option.WithAPIKey(apiKey))
	return &AnthropicLLM{client: client, model: defaultModel}
}

func (a *AnthropicLLM) Complete(ctx context.Context, req Request) (Response, error) {
	msgs := buildMessages(req)
	tools := buildTools(req.Tools)

	params := anthropic.MessageNewParams{
		Model:     a.model,
		MaxTokens: 8096,
		System: []anthropic.TextBlockParam{
			{Text: req.System},
		},
		Messages: msgs,
		Tools:    tools,
	}

	slog.Debug("llm request", "model", string(a.model), "messages", len(msgs), "tools", len(tools))
	start := time.Now()

	resp, err := a.client.Messages.New(ctx, params)
	if err != nil {
		return Response{}, fmt.Errorf("anthropic: %w", err)
	}

	r := parseResponse(resp)
	slog.Debug("llm response",
		"model", string(a.model),
		"stop_reason", r.StopReason,
		"input_tokens", r.InputTokens,
		"output_tokens", r.OutputTokens,
		"latency_ms", time.Since(start).Milliseconds(),
	)
	return r, nil
}

func buildMessages(req Request) []anthropic.MessageParam {
	var msgs []anthropic.MessageParam

	for _, m := range req.Messages {
		switch m.Role {
		case "user":
			if len(m.ToolResults) > 0 {
				var blocks []anthropic.ContentBlockParamUnion
				for _, tr := range m.ToolResults {
					blocks = append(blocks, anthropic.NewToolResultBlock(tr.ID, tr.Content, false))
				}
				msgs = append(msgs, anthropic.NewUserMessage(blocks...))
			} else {
				msgs = append(msgs, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Content)))
			}
		case "tobor":
			var blocks []anthropic.ContentBlockParamUnion
			if m.Content != "" {
				blocks = append(blocks, anthropic.NewTextBlock(m.Content))
			}
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, anthropic.NewToolUseBlock(tc.ID, json.RawMessage(tc.Input), tc.Name))
			}
			if len(blocks) > 0 {
				msgs = append(msgs, anthropic.NewAssistantMessage(blocks...))
			}
		}
	}

	return msgs
}

func buildTools(defs []ToolDef) []anthropic.ToolUnionParam {
	tools := make([]anthropic.ToolUnionParam, 0, len(defs))
	for _, d := range defs {
		var schema struct {
			Properties any      `json:"properties"`
			Required   []string `json:"required"`
		}
		if len(d.Schema) > 0 {
			_ = json.Unmarshal(d.Schema, &schema)
		}
		t := anthropic.ToolParam{
			Name:        d.Name,
			Description: anthropic.String(d.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: schema.Properties,
				Required:   schema.Required,
			},
		}
		tools = append(tools, anthropic.ToolUnionParam{OfTool: &t})
	}
	return tools
}

func parseResponse(resp *anthropic.Message) Response {
	var r Response
	r.StopReason = string(resp.StopReason)
	r.InputTokens = int(resp.Usage.InputTokens)
	r.OutputTokens = int(resp.Usage.OutputTokens)

	for _, block := range resp.Content {
		switch v := block.AsAny().(type) {
		case anthropic.TextBlock:
			r.Text += v.Text
		case anthropic.ToolUseBlock:
			r.ToolCalls = append(r.ToolCalls, ToolCall{
				ID:    v.ID,
				Name:  v.Name,
				Input: v.Input,
			})
		}
	}
	return r
}
