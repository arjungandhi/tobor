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
tobor workspace add personal 127.0.0.1:7879   # name the node (client config, see below)
tobor                        # terminal client (TUI): workspace picker; `tobor personal` opens it directly
tobor backup <file>          # VACUUM INTO a copy of tobor.sqlite
```

Worker models: a `task` item's `model` wins, then `agents.model_overrides.<agent>` in config.yml, then the agent
file's `model`, then `defaults.worker_model`, else the director's model.

Web access: agents get `web_search` and `fetch_url` (search providers and fetch handling adapted from
[oh-my-pi](https://github.com/can1357/oh-my-pi)). Search works without keys (Exa's public MCP endpoint, then
DuckDuckGo); keys in `agent.env` (`BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`) put those providers first.
In `.tobor/config.yml`:

```yaml
search:
  provider: auto        # auto | brave | tavily | searxng | exa | duckduckgo | none
  # url: https://searx.example.org   # required for searxng
  # api_key_env: MY_BRAVE_KEY       # env var for a named provider's key
  max_results: 10
fetch:
  allow_private: false  # refuse loopback/private/link-local hosts
  max_chars: 20000
  timeout_ms: 20000
  remote_reader: true   # use r.jina.ai for JavaScript-only pages
```

## Client (TUI) config

The TUI and `tobor workspace` read `$XDG_CONFIG_HOME/tobor/config.yml` (default `~/.config/tobor/config.yml`); edits
from the CLI or the settings screen keep its comments and unknown keys:

```yaml
workspaces:
  personal: { host: 127.0.0.1, port: 7879 }
  work:     { host: 127.0.0.1, port: 7881 }
default: personal     # preselected in the picker
confirm_auto: true    # ask before switching to auto approval
editor: nvim          # /files editor (else $VISUAL, $EDITOR, vi)
pdf_dir: ~/Downloads  # artifact PDFs
```

`tobor <name>` opens a workspace, else `TOBOR_WORKSPACE`, else a picker showing each workspace's reachability; with
no workspaces a first-run wizard adds one. `tobor host:port` connects to an unsaved node and offers to save it.
`Ctrl+T` switches workspace; settings (`Ctrl+,`) → Workspaces adds, renames, re-addresses, removes and sets the
default. `tobor workspace list|add <name> <host:port>|remove <name>|use <name>` does the same from the shell (`use`
sets `default`). Runtime state (last open session per workspace) lives in `$XDG_STATE_HOME/tobor/state.json`. An old
`tui.json` is migrated once and renamed `tui.json.migrated`.

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
