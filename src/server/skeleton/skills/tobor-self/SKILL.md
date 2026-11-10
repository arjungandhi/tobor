---
name: tobor-self
description: How tobor's own .tobor/ directory is laid out and the rules for editing it (agents, skills, rules, config).
---
# Editing tobor itself

tobor keeps its agent data in two places with the same layout:

- **Node:** `$TOBOR_HOME/.tobor/`, a git repo owned by the node. Every change is committed automatically
  (`agent: <summary>` for your edits).
- **Project:** `<git root>/.tobor/` inside a repo. It belongs to that repo; the node never commits it.

| Path | Level | Purpose |
|---|---|---|
| `AGENTS.md` | node, project | Context loaded into every session (project after node) |
| `RULES.md` | node, project | Sticky rules |
| `SYSTEM.md` | node | Optional full replacement of the preamble |
| `APPEND_SYSTEM.md` | node, project | Optional text appended after the preamble |
| `config.yml` | node; project (whitelist) | Settings |
| `mcp.json` | node, project | MCP servers |
| `skills/<name>/SKILL.md` | node, project | Skills; frontmatter `name`, `description` |
| `agents/<name>.md` | node, project | Worker agent definitions; project shadows node by name |
| `design-systems/<name>/` | node, project | Artifact themes (must contain `tokens.css`) |

## Agent definitions

```markdown
---
name: my-agent            # lowercase, digits, - and _
description: one line used to pick the agent
model: anthropic/claude-haiku-5-5   # optional, provider/modelId
thinking: low             # optional: off minimal low medium high xhigh max
tools: [read, bash]       # optional; names or mcp__<server>__* globs; omitted = full worker set
max_turns: 40             # optional
approval: inherit         # inherit (default) or auto
---
Instructions the worker gets as its system prompt.
```

## Rules for self-edits

- Use the normal `read`/`edit`/`write` tools; the session's approval mode applies as for any file.
- Every change is validated: `config.yml` schema, SKILL and agent frontmatter, `mcp.json` shape. An invalid change
  is reverted to the last commit and reported as a tool error.
- Changes apply without restart: prompt sections on the next request, `agents/` on the next `task`, `mcp.json`
  reconnects its servers.
- Operator-only keys are rejected whatever the mode: `config.yml` `defaults.approval_mode`, `mcp.approval`,
  `roots`, `allowed_origins`, `allowed_hosts`, `listen`. Ask the operator to change those.
- A project `config.yml` may only set `defaults.model`, `defaults.thinking`, `defaults.mode`, `artifacts.theme`
  and `mcp.servers`; anything else is ignored.
- Never put secrets in `.tobor/`; credentials live in the node's env file and auth store.
