package llm

import (
	"context"
	"encoding/json"
	"fmt"

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

	resp, err := a.client.Messages.New(ctx, params)
	if err != nil {
		return Response{}, fmt.Errorf("anthropic: %w", err)
	}

	return parseResponse(resp), nil
}

func buildMessages(req Request) []anthropic.MessageParam {
	var msgs []anthropic.MessageParam

	for _, m := range req.Messages {
		switch m.Role {
		case "user":
			msgs = append(msgs, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Content)))
		case "assistant":
			msgs = append(msgs, anthropic.NewAssistantMessage(anthropic.NewTextBlock(m.Content)))
		}
	}

	// append tool results from the previous turn as a user message
	if len(req.ToolResults) > 0 {
		var blocks []anthropic.ContentBlockParamUnion
		for _, tr := range req.ToolResults {
			blocks = append(blocks, anthropic.NewToolResultBlock(tr.ID, tr.Content, false))
		}
		msgs = append(msgs, anthropic.NewUserMessage(blocks...))
	}

	return msgs
}

func buildTools(defs []ToolDef) []anthropic.ToolUnionParam {
	tools := make([]anthropic.ToolUnionParam, 0, len(defs))
	for _, d := range defs {
		var schema map[string]any
		if len(d.Schema) > 0 {
			_ = json.Unmarshal(d.Schema, &schema)
		}
		t := anthropic.ToolParam{
			Name:        d.Name,
			Description: anthropic.String(d.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: schema["properties"],
				ExtraFields: map[string]any{
					"type":     schema["type"],
					"required": schema["required"],
				},
			},
		}
		tools = append(tools, anthropic.ToolUnionParam{OfTool: &t})
	}
	return tools
}

func parseResponse(resp *anthropic.Message) Response {
	var r Response
	r.StopReason = string(resp.StopReason)

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
