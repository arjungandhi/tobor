package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ShellTool executes a shell command with parameter substitution.
type ShellTool struct {
	name        string
	description string
	schema      json.RawMessage
	cmd         []string
}

func (s *ShellTool) Name() string            { return s.name }
func (s *ShellTool) Description() string     { return s.description }
func (s *ShellTool) Schema() json.RawMessage { return s.schema }

func (s *ShellTool) Call(ctx context.Context, params json.RawMessage) (string, error) {
	var p map[string]string
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return "", fmt.Errorf("invalid params: %w", err)
		}
	}

	args := make([]string, len(s.cmd))
	for i, arg := range s.cmd {
		for k, v := range p {
			arg = strings.ReplaceAll(arg, "{"+k+"}", v)
		}
		args[i] = arg
	}

	slog.Debug("shell exec", "tool", s.name, "cmd", args)
	start := time.Now()

	out, err := exec.CommandContext(ctx, args[0], args[1:]...).Output()
	dur := time.Since(start)

	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			slog.Warn("shell exec failed",
				"tool", s.name,
				"exit_code", exitErr.ExitCode(),
				"duration_ms", dur.Milliseconds(),
				"stderr", strings.TrimSpace(string(exitErr.Stderr)),
			)
		} else {
			slog.Warn("shell exec failed", "tool", s.name, "err", err, "duration_ms", dur.Milliseconds())
		}
		return "", fmt.Errorf("%s: %w", s.name, err)
	}

	result := strings.TrimSpace(string(out))
	slog.Debug("shell exec ok", "tool", s.name, "duration_ms", dur.Milliseconds(), "output_len", len(result))
	return result, nil
}

// toolFile is the parsed structure of a tool markdown file's frontmatter.
type toolFile struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Requires    struct {
		Bins []string `yaml:"bins"`
	} `yaml:"requires"`
	Cmd    []string            `yaml:"cmd"`
	Params map[string]paramDef `yaml:"params"`
}

type paramDef struct {
	Type        string `yaml:"type"`
	Description string `yaml:"description"`
	Optional    bool   `yaml:"optional"`
}

// LoadDir loads all *.md tool definitions from dir, skipping tools whose
// required binaries are not on PATH.
func LoadDir(dir string) ([]Tool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read tools dir: %w", err)
	}

	var tools []Tool
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}

		t, err := loadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("load tool %s: %w", e.Name(), err)
		}
		if t != nil {
			tools = append(tools, t)
		}
	}
	return tools, nil
}

func loadFile(path string) (*ShellTool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	front, body, err := parseFrontmatter(data)
	if err != nil {
		return nil, err
	}

	var def toolFile
	if err := yaml.Unmarshal(front, &def); err != nil {
		return nil, fmt.Errorf("parse frontmatter: %w", err)
	}

	// skip if required binaries are missing
	for _, bin := range def.Requires.Bins {
		if _, err := exec.LookPath(bin); err != nil {
			return nil, nil
		}
	}

	description := def.Description
	if body != "" {
		description += "\n\n" + body
	}

	schema, err := buildSchema(def.Params)
	if err != nil {
		return nil, fmt.Errorf("build schema: %w", err)
	}

	return &ShellTool{
		name:        def.Name,
		description: description,
		schema:      schema,
		cmd:         def.Cmd,
	}, nil
}

func parseFrontmatter(data []byte) (front []byte, body string, err error) {
	const delim = "---"
	if !bytes.HasPrefix(data, []byte(delim)) {
		return nil, "", fmt.Errorf("missing frontmatter delimiter")
	}
	rest := data[len(delim):]
	idx := bytes.Index(rest, []byte("\n"+delim))
	if idx < 0 {
		return nil, "", fmt.Errorf("unclosed frontmatter")
	}
	front = rest[:idx]
	body = strings.TrimSpace(string(rest[idx+len("\n"+delim):]))
	return front, body, nil
}

func buildSchema(params map[string]paramDef) (json.RawMessage, error) {
	if len(params) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`), nil
	}

	type prop struct {
		Type        string `json:"type"`
		Description string `json:"description,omitempty"`
	}

	props := make(map[string]prop, len(params))
	required := make([]string, 0, len(params))
	for name, p := range params {
		props[name] = prop{Type: p.Type, Description: p.Description}
		if !p.Optional {
			required = append(required, name)
		}
	}

	schema := struct {
		Type       string          `json:"type"`
		Properties map[string]prop `json:"properties"`
		Required   []string        `json:"required"`
	}{
		Type:       "object",
		Properties: props,
		Required:   required,
	}

	out, err := json.Marshal(schema)
	return json.RawMessage(out), err
}
