package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ReadFileTool reads a file by relative path within a base directory.
type ReadFileTool struct {
	baseDir string
}

func NewReadFileTool(baseDir string) *ReadFileTool {
	return &ReadFileTool{baseDir: baseDir}
}

func (r *ReadFileTool) Name() string { return "read_file" }

func (r *ReadFileTool) Description() string {
	return "Read the contents of a file by relative path within the work directory."
}

func (r *ReadFileTool) Schema() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {
				"type": "string",
				"description": "Relative path to the file within the work directory"
			}
		},
		"required": ["path"]
	}`)
}

func (r *ReadFileTool) Call(ctx context.Context, params json.RawMessage) (string, error) {
	var p struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return "", fmt.Errorf("invalid params: %w", err)
	}

	if p.Path == "" {
		return "", fmt.Errorf("path is required")
	}

	// Resolve and verify the path stays within baseDir.
	abs := filepath.Join(r.baseDir, p.Path)
	abs, err := filepath.Abs(abs)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}

	base, err := filepath.Abs(r.baseDir)
	if err != nil {
		return "", fmt.Errorf("resolve base: %w", err)
	}

	if !strings.HasPrefix(abs, base+string(filepath.Separator)) && abs != base {
		return "", fmt.Errorf("path escapes work directory")
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	return string(data), nil
}
