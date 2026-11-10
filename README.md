# tobor

A self-hosted remote agent harness. Each host runs one tobor node: a Node process embedding
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) as its agent loop and serving an
HTTP+WS API. Clients (the TUI first) start, watch, steer, approve, abort and schedule durable sessions on that host.
Tools: hashline `read`/`edit`, `write`, `bash`, artifacts, schedules, `todo`, director workers (`.tobor/agents/*.md`:
`worker` sonnet, `fast`/`scout` haiku, `reviewer` sonnet) and MCP servers. The node has no auth: bind it to a private
network (e.g. Tailscale). Design: [`design_doc_v3.md`](design_doc_v3.md).

## Quickstart

Requires Node ≥ 22.19 and git; Chrome/Chromium enables artifact PDFs.

```
npm install && npm run build && npm link   # puts `tobor` (dist/cli.js) on PATH
export TOBOR_HOME=~/.local/share/tobor     # or --home DIR on every command
tobor init                   # $TOBOR_HOME, the .tobor/ git repo (config.yml, agents/, skills/), node.json
$EDITOR $TOBOR_HOME/.tobor/config.yml     # roots: directories sessions may start in
tobor login anthropic        # Claude Pro/Max OAuth; or put ANTHROPIC_API_KEY=… in $TOBOR_HOME/agent.env
tobor node                   # API on 127.0.0.1:7879, artifacts on :7880
tobor tui 127.0.0.1:7879     # terminal client
tobor backup <file>          # VACUUM INTO a copy of tobor.sqlite
```

Worker models: a `task` item's `model` wins, then `agents.model_overrides.<agent>` in config.yml, then the agent
file's `model`, then `defaults.worker_model`, else the director's model.

## systemd (user unit)

One template unit runs any number of nodes, each with its own `TOBOR_HOME` and ports (set in that home's `.tobor/config.yml`):
copy `contrib/tobor@.service` to `~/.config/systemd/user/`, write `~/.config/tobor/nodes/<name>.env` per node
(see `contrib/nodes/example.env`), then `systemctl --user enable --now tobor@<name>`
(plus `loginctl enable-linger $USER` to run without a login session).

## Development

```
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run build                # tsc → dist/, then copies artifact themes/vendor and the init skeleton
npm run dev:node -- --home /tmp/tobor-dev
ANTHROPIC_API_KEY=… node --import tsx test/integration/smoke.ts   # real-model end-to-end smoke (after build)
```
