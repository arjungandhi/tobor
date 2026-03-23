package llm

import "context"

type Message struct {
	Role    string // "user" | "assistant"
	Content string
}

type ToolCall struct {
	ID    string
	Name  string
	Input []byte // raw JSON
}

type ToolResult struct {
	ID      string
	Content string
}

type Request struct {
	System      string
	Messages    []Message
	ToolResults []ToolResult // results from previous turn's tool calls
	Tools       []ToolDef
}

type ToolDef struct {
	Name        string
	Description string
	Schema      []byte // raw JSON schema
}

type Response struct {
	Text       string
	ToolCalls  []ToolCall
	StopReason string // "end_turn" | "tool_use" | "max_tokens"
}

type LLM interface {
	Complete(ctx context.Context, req Request) (Response, error)
}
