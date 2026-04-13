package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReadFileTool_ReadValid(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "hello.txt"), []byte("hello world"), 0o644); err != nil {
		t.Fatal(err)
	}

	tool := NewReadFileTool(dir)
	params, _ := json.Marshal(map[string]string{"path": "docs/hello.txt"})
	out, err := tool.Call(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "hello world" {
		t.Fatalf("got %q, want %q", out, "hello world")
	}
}

func TestReadFileTool_MissingFile(t *testing.T) {
	dir := t.TempDir()
	tool := NewReadFileTool(dir)
	params, _ := json.Marshal(map[string]string{"path": "nope.txt"})
	_, err := tool.Call(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestReadFileTool_PathTraversal(t *testing.T) {
	dir := t.TempDir()
	tool := NewReadFileTool(dir)
	params, _ := json.Marshal(map[string]string{"path": "../../etc/passwd"})
	_, err := tool.Call(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestReadFileTool_EmptyPath(t *testing.T) {
	dir := t.TempDir()
	tool := NewReadFileTool(dir)
	params, _ := json.Marshal(map[string]string{"path": ""})
	_, err := tool.Call(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestReadFileTool_Metadata(t *testing.T) {
	tool := NewReadFileTool("/tmp")
	if tool.Name() != "read_file" {
		t.Fatalf("got name %q", tool.Name())
	}
	if tool.Description() == "" {
		t.Fatal("empty description")
	}
	if len(tool.Schema()) == 0 {
		t.Fatal("empty schema")
	}
}
