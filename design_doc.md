# tobor design doc

tobor is a personal assistant bot that provides natural language access to personal tools and data via Matrix messaging.

## Core Concept

tobor is an event-driven daemon with a single input: a Unix domain socket at `/run/tobor.sock`. All event sources write to this socket. tobor reads events, runs them through an LLM agent with tools, and sends responses via `messages send`.

## Architecture

```
messages listen ──▶ messages-to-tobor ──┐
                                        │
systemd timers / cron ──────────────────┼──▶ /run/tobor.sock ──▶ tobor ──▶ messages send
                                        │
future sources ─────────────────────────┘
```

tobor itself:

```
/run/tobor.sock
      │
      ▼
 epoll loop
      │
      ▼
 LLM Agent ◀─── system prompt (soul.md + style.md)
      │    ◀─── conversation history (short-term memory)
      │    ◀─── event log
      │
 tool dispatch
 (metrics, ...)
      │
      ▼
 messages send
```

## Components

### tobor daemon

The core process. Runs an epoll loop reading JSON events from `/run/tobor.sock` and dispatches each event to a goroutine for processing. Each goroutine runs the LLM agent loop and writes responses to stdout (piped to `messages send`). Per-room ordering is preserved by serializing goroutines within the same room.

### Event producers

Any process that writes a JSON event to `/run/tobor.sock`. The socket is the single integration point — tobor has no knowledge of where events originate.

Built-in producers:
- **messages-to-tobor** — bridges `messages listen` to the socket. As simple as `messages listen | socat - UNIX-CONNECT:/run/tobor.sock`
- **systemd timers / cron** — periodic jobs that write events to the socket (future)
- **`at` jobs** — one-off deferred events that write back to the socket when they fire (future)

### LLM Agent

Receives an event, decides which tools to call, and produces a response. The agent is stateless per-invocation; context comes from memory (see below).

The LLM backend is abstracted behind an interface so implementations can be swapped out. Initial implementation uses Claude; local models (Ollama, llama.cpp) are a future option.

```go
type LLM interface {
    Complete(ctx context.Context, req Request) (Response, error)
}

type Request struct {
    System   string
    Messages []Message
    Tools    []Tool
}

type Response struct {
    Text      string
    ToolCalls []ToolCall
}
```

The agent loop:
1. Send event + conversation history + tools to LLM
2. If response contains tool calls, dispatch them and append results
3. Repeat until LLM returns a text response
4. Send response via `messages send`
5. Write entry to event log

### Tools

Thin Go wrappers implementing a common `Tool` interface:

```go
type Tool interface {
    Name() string
    Description() string
    Schema() json.RawMessage
    Call(ctx context.Context, params json.RawMessage) (string, error)
}
```

Initial tools:
- `metrics` - wraps `arjungandhi/metrics`

### Memory

**Short-term (conversation context)**
Per-room message history stored in process memory. Injected into the LLM context for each request. A room's history is evicted after 30 minutes of inactivity (configurable via `idle_timeout`). Allows follow-up questions ("what time is that meeting?") to work correctly.

History is trimmed to a configurable token budget (default 8000 tokens) by dropping oldest messages from the front before each LLM request. Token count is estimated as `len(text) / 4`. This keeps context window usage bounded without requiring summarization.

**Event log**
A gzip-compressed JSONL file (`log.jsonl.gz` in `work_dir`). One entry written after each agent invocation. Appends use gzip multi-stream: each write opens the file in append mode and writes a new gzip stream. Standard gzip decoders concatenate streams transparently, so the file reads as a single JSONL stream.

```json
{
  "timestamp": "2026-03-22T10:00:00Z",
  "event_type": "message",
  "room_id": "!abc:matrix.org",
  "input": "what's on my calendar today?",
  "tools_called": ["calendar"],
  "response": "You have standup at 10am and lunch with Sarah at noon."
}
```

Used for debugging agent behavior. Entries older than `log_retention_days` are pruned at startup.

## Event Schema

All events written to `/run/tobor.sock` share a common JSON format:

```json
{
  "type": "message | reminder | poll",
  "room_id": "!abc:matrix.org",
  "sender": "@user:matrix.org",
  "text": "what's on my calendar today?",
  "timestamp": "2026-03-17T10:00:00Z"
}
```

- `message` — an incoming Matrix message, requires a reply
- `reminder` — a scheduled event, tobor decides what to send
- `poll` — a periodic check (e.g. "are there any urgent calendar events?")

## Running

```bash
# Start tobor
messages listen | socat - UNIX-CONNECT:/run/tobor.sock &
tobor | messages send
```

Or as systemd services with tobor managing its own socket.

## Config

Config lives at `~/.config/tobor/config.yaml` (overridable via `TOBOR_DIR` env var). Secrets like the API key can also be set via env var (`ANTHROPIC_API_KEY`).

tobor keeps its data files in `work_dir`. Within that directory it expects:
- `soul.md` — tobor's personality and values, injected into the system prompt
- `style.md` — communication style guidelines, injected into the system prompt
- `log.jsonl.gz` — event log

```yaml
socket_path: /run/tobor.sock
work_dir: ~/.local/share/tobor             # tobor data directory
log_retention_days: 90                     # prune entries older than this on startup
context_token_budget: 8000                   # max tokens allocated to conversation history per request
idle_timeout: 30m                            # evict room history after this period of inactivity
auth_sender: "@user:matrix.org"              # only respond to this Matrix ID
default_room: "!abc:matrix.org"              # room for proactive messages
anthropic_api_key: sk-...                    # or set ANTHROPIC_API_KEY
```

## Repo Layout

```
tobor/
├── cmd/tobor/main.go        # wire everything together
├── pkg/
│   ├── config/
│   │   └── config.go        # config loading, defaults, validation
│   ├── agent/               # LLM agent loop + tool dispatch
│   ├── llm/
│   │   ├── llm.go           # LLM interface
│   │   └── anthropic.go     # Claude implementation
│   ├── memory/
│   │   ├── short.go         # per-room conversation history (token-budget sliding window)
│   │   └── log.go           # append-only event log (gzip JSONL)
│   ├── tools/
│   │   ├── tool.go          # Tool interface
│   │   └── metrics.go       # wraps arjungandhi/metrics
│   └── socket/              # unix domain socket listener
└── go.mod
```
