# tobor

A small, self-hosted remote agent harness. Each host runs one tobor node: a Node process that embeds
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.1 as its agent loop and
serves an HTTP+WS API. Clients (the TUI first; web and Android later) start, watch, steer, approve, abort and schedule
agent sessions on that host. Sessions are durable conversations in one SQLite file, so they survive restarts and
client disconnects. Design: [`design_doc_v3.md`](design_doc_v3.md).

- **Tools:** hashline `read`/`edit`, `write`, `bash`, artifacts, schedules, `todo`, plus MCP servers.
- **Director mode:** the session agent plans and dispatches background workers defined in `.tobor/agents/*.md`.
- **Approvals:** `ask` mode gates mutating tools; pending approvals persist and show in every client.
- **Artifacts:** published HTML revisions on a separate origin, PDF export, retro-log theme.
- **No auth in the node:** bind it to a private network (e.g. Tailscale). One install per host, no hub.

## Layout

```
$TOBOR_HOME/                 # --home → TOBOR_HOME → ~/.local/share/tobor
├── tobor.sqlite             # pi-durable state and tobor docs
├── auth.json                # credentials (0600)
├── agent.env                # env_file: API keys, MCP tokens
├── node.json                # system conversation id, ntfy topic
├── .tobor/                  # git repo: AGENTS.md RULES.md config.yml mcp.json agents/ skills/ design-systems/
└── artifacts/               # feed.jsonl, store/, pdf/
```

## Usage

Requires Node ≥ 22.19.

```
tobor init                   # create $TOBOR_HOME and the .tobor repo
tobor login anthropic        # Claude Pro/Max OAuth (prints a URL, paste the code)
tobor node                   # run the node (API :7879, artifacts :7880)
tobor tui [host:port]        # terminal client
tobor backup <file>          # VACUUM INTO a copy of tobor.sqlite
```

## Development

```
npm install
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run build                # tsc -p tsconfig.build.json → dist/
npm run dev:node -- --home /tmp/tobor-dev
npm run dev:tui -- localhost:7879
```
