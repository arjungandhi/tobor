package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	SocketPath         string        `yaml:"socket_path"`
	WorkDir            string        `yaml:"work_dir"`
	LogRetentionDays   int           `yaml:"log_retention_days"`
	ContextTokenBudget int           `yaml:"context_token_budget"`
	IdleTimeout        time.Duration `yaml:"idle_timeout"`
	MaxTurns           int           `yaml:"max_turns"`
	AuthSender         string        `yaml:"auth_sender"`
	DefaultRoom        string        `yaml:"default_room"`
	LLMBackend         string        `yaml:"llm_backend"` // "anthropic" or "ollama"
	AnthropicAPIKey    string        `yaml:"anthropic_api_key"`
	OllamaURL          string        `yaml:"ollama_url"`
	OllamaModel        string        `yaml:"ollama_model"`
}

func Load() (*Config, error) {
	dir := os.Getenv("TOBOR_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("get home dir: %w", err)
		}
		dir = filepath.Join(home, ".config", "tobor")
	}

	cfg := defaults()

	path := filepath.Join(dir, "config.yaml")
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if err == nil {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}

	// env var overrides
	if v := os.Getenv("ANTHROPIC_API_KEY"); v != "" {
		cfg.AnthropicAPIKey = v
	}
	if v := os.Getenv("OLLAMA_URL"); v != "" {
		cfg.OllamaURL = v
	}
	if v := os.Getenv("OLLAMA_MODEL"); v != "" {
		cfg.OllamaModel = v
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func defaults() *Config {
	home, _ := os.UserHomeDir()
	return &Config{
		SocketPath:         "/run/tobor.sock",
		WorkDir:            filepath.Join(home, ".local", "share", "tobor"),
		LogRetentionDays:   90,
		ContextTokenBudget: 8000,
		IdleTimeout:        30 * time.Minute,
		MaxTurns:           10,
		LLMBackend:         "anthropic",
	}
}

func (c *Config) validate() error {
	switch c.LLMBackend {
	case "anthropic":
		if c.AnthropicAPIKey == "" {
			return fmt.Errorf("anthropic_api_key is required (or set ANTHROPIC_API_KEY)")
		}
	case "ollama":
		// ollama_url and ollama_model have sensible defaults, no required fields
	default:
		return fmt.Errorf("llm_backend must be \"anthropic\" or \"ollama\", got %q", c.LLMBackend)
	}
	if c.AuthSender == "" {
		return fmt.Errorf("auth_sender is required")
	}
	if c.DefaultRoom == "" {
		return fmt.Errorf("default_room is required")
	}
	return nil
}
