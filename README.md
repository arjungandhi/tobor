<!-- PROJECT LOGO -->
<br />
<div align="center">
<h3 align="center">tobor</h3>

  <p align="center">
    a personal assistant bot for Matrix
  </p>
</div>

# About

tobor is an event-driven personal assistant daemon that provides natural language access to personal tools and data via Matrix messaging. It reads events from a Unix domain socket, runs them through an LLM agent with configurable tools, and sends responses via `messages send`.

# Usage

```bash
# Start tobor
messages listen | socat - UNIX-CONNECT:/run/tobor.sock &
tobor | messages send
```

# Configuration

Config lives at `~/.config/tobor/config.yaml` (overridable via `TOBOR_DIR` env var).

```yaml
socket_path: /run/tobor.sock
work_dir: ~/.local/share/tobor
log_retention_days: 90
context_token_budget: 8000
idle_timeout: 30m
max_turns: 10
auth_sender: "@user:matrix.org"
default_room: "!abc:matrix.org"
anthropic_api_key: sk-...             # or set ANTHROPIC_API_KEY
```

tobor expects the following in `work_dir`:
- `soul.md` — personality and values, injected into the system prompt
- `style.md` — communication style guidelines, injected into the system prompt
- `log.jsonl.gz` — event log
- `tools/` — tool definitions (markdown with YAML frontmatter, one file per tool)

# Architecture

```
messages listen ──▶ messages-to-tobor ──┐
                                        │
systemd timers / cron ──────────────────┼──▶ /run/tobor.sock ──▶ tobor ──▶ messages send
                                        │
future sources ─────────────────────────┘
```

See [design_doc.md](design_doc.md) for full architecture and design details.
