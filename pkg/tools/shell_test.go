package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestParseFrontmatter(t *testing.T) {
	input := []byte("---\nname: test\n---\nbody text")
	front, body, err := parseFrontmatter(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(front) != "\nname: test" {
		t.Errorf("unexpected front: %q", string(front))
	}
	if body != "body text" {
		t.Errorf("unexpected body: %q", body)
	}
}

func TestParseFrontmatterNoDelimiter(t *testing.T) {
	_, _, err := parseFrontmatter([]byte("no frontmatter here"))
	if err == nil {
		t.Error("expected error for missing delimiter")
	}
}

func TestParseFrontmatterUnclosed(t *testing.T) {
	_, _, err := parseFrontmatter([]byte("---\nname: test\n"))
	if err == nil {
		t.Error("expected error for unclosed frontmatter")
	}
}

func TestParseFrontmatterEmptyBody(t *testing.T) {
	_, body, err := parseFrontmatter([]byte("---\nname: test\n---\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if body != "" {
		t.Errorf("expected empty body, got %q", body)
	}
}

func TestBuildSchemaNoParams(t *testing.T) {
	schema, err := buildSchema(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(schema, &m); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if m["type"] != "object" {
		t.Errorf("expected type=object, got %v", m["type"])
	}
}

func TestBuildSchemaWithParams(t *testing.T) {
	params := map[string]paramDef{
		"query": {Type: "string", Description: "search query"},
		"limit": {Type: "integer", Optional: true},
	}
	schema, err := buildSchema(params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var m struct {
		Type       string                     `json:"type"`
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	}
	if err := json.Unmarshal(schema, &m); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if _, ok := m.Properties["query"]; !ok {
		t.Error("expected query property")
	}
	if _, ok := m.Properties["limit"]; !ok {
		t.Error("expected limit property")
	}
	// only non-optional params should be required
	found := false
	for _, r := range m.Required {
		if r == "query" {
			found = true
		}
		if r == "limit" {
			t.Error("optional param limit should not be required")
		}
	}
	if !found {
		t.Error("expected query in required")
	}
}

func TestShellToolCall(t *testing.T) {
	tool := &ShellTool{
		name: "echo",
		cmd:  []string{"echo", "hello"},
	}
	out, err := tool.Call(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "hello" {
		t.Errorf("expected 'hello', got %q", out)
	}
}

func TestShellToolCallWithParams(t *testing.T) {
	tool := &ShellTool{
		name: "greet",
		cmd:  []string{"echo", "hello {name}"},
	}
	params, _ := json.Marshal(map[string]string{"name": "world"})
	out, err := tool.Call(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "hello world" {
		t.Errorf("expected 'hello world', got %q", out)
	}
}

func TestShellToolCallOmitsOptionalFlag(t *testing.T) {
	tool := &ShellTool{
		name: "add",
		cmd:  []string{"echo", "add", "{name}", "{value}", "-d", "{day}"},
	}
	params, _ := json.Marshal(map[string]string{"name": "weight", "value": "180"})
	out, err := tool.Call(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// "-d" and "{day}" should both be absent
	if out != "add weight 180" {
		t.Errorf("expected 'add weight 180', got %q", out)
	}
}

func TestLoadDirMissingDir(t *testing.T) {
	tools, err := LoadDir("/tmp/tobor-nonexistent-tools-dir")
	if err != nil {
		t.Fatalf("expected nil error for missing dir, got %v", err)
	}
	if tools != nil {
		t.Errorf("expected nil tools, got %v", tools)
	}
}

func TestLoadDirValidTool(t *testing.T) {
	dir := t.TempDir()
	content := `---
name: greet
description: says hello
cmd:
  - echo
  - hello
---
`
	if err := os.WriteFile(filepath.Join(dir, "greet.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	tools, err := LoadDir(dir)
	if err != nil {
		t.Fatalf("LoadDir: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name() != "greet" {
		t.Errorf("expected name 'greet', got %q", tools[0].Name())
	}
}

func TestLoadDirSkipsMissingBinary(t *testing.T) {
	dir := t.TempDir()
	content := `---
name: missing
description: requires nonexistent binary
requires:
  bins:
    - tobor-definitely-not-a-real-binary
cmd:
  - tobor-definitely-not-a-real-binary
---
`
	if err := os.WriteFile(filepath.Join(dir, "missing.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	tools, err := LoadDir(dir)
	if err != nil {
		t.Fatalf("LoadDir: %v", err)
	}
	if len(tools) != 0 {
		t.Errorf("expected tool to be skipped, got %d tools", len(tools))
	}
}
