package tools

import (
	"context"
	"encoding/json"
)

type Tool interface {
	Name() string
	Description() string
	Schema() json.RawMessage
	Call(ctx context.Context, params json.RawMessage) (string, error)
}
