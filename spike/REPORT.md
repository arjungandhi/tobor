# Build step 1 spike: pi-durable 1.5.1 report

All runs: `ANTHROPIC_API_KEY=… npx tsx spike/<script>.ts` from the repo root, model `anthropic/claude-haiku-4-5`,
SQLite storage under `spike/out/` (git-ignored, together with logs and fixtures).

## 1. Prompt round-trip on SQLite (`spike/exp1-prompt.ts`)

Opens `openNodeSqliteStorage`, creates an ownerless conversation, `configure({model, cwd})`, submits
`"Reply with exactly: pong"`, waits, and reads the answer.

```
conversation.id: 2
submission.id: 9
settled: {"conversationId":2,"type":"input","status":"done","entry":8,"id":9,"answer":12}
AssistantEntry via tx.entry: {"model":[{"role":"assistant","content":[{"type":"text","text":"pong"}],"api":"anthropic-messages",
  "provider":"anthropic","model":"claude-haiku-4-5","usage":{...,"cost":{...,"total":0.00126,"totalFromProvider":false}},
  "stopReason":"stop",...,"thinkingLevel":"off"}],"kind":"pi.assistant","id":12,"conversationId":2,"byTaskId":10}
assistant text: "pong"
entries page kinds: [{"id":8,"kind":"pi.user"},{"id":11,"kind":"pi.system"},{"id":12,"kind":"pi.assistant"}] next: undefined
usage: {"models":{"anthropic/claude-haiku-4-5":{...}},"tools":{}}
closed: {"kind":"closed"}
```

- `SettledSubmissionRecord` (done) = `{conversationId, type:"input", status:"done", entry, id, answer}`. `entry` is the
  `pi.user` entry id; `answer` is the `pi.assistant` entry id.
- Read the answer with `conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx)`. The text is
  `entry.model[0].content.filter(c => c.type === "text").map(c => c.text).join("")` (`assistantText` in
  `spike/common.ts`).
- `conversation.entries({order:"ascending"}, limit, cursor, ctx)` returns `{items, next}`. The first run's
  `pi.system` entry carries the tool definitions (`toolsAdded`).
- `harness.usage(ctx)` is keyed by `provider/model`. With the default system prompt plus CodingTools, a one-word answer
  costs about 1.2k input tokens.

## 2. bash tool round-trip + watch fixture (`spike/exp2-bash.ts`)

Prompt: "Run `echo hello-from-bash` with the bash tool and tell me the output." Every watch listener call is recorded
to `spike/out/fixtures/bash-run.*`.

```
listener arity: 2 call keys: [ 'kind', 'value', 'ops', 'retired' ] ctx.abortSignal: undefined
settled: {"conversationId":2,"type":"input","status":"done","entry":8,"id":9,"answer":16}
pi.live.tools slot [pending]: {"callId":"toolu_01G2…","name":"bash","taskId":13,"status":"pending"}
pi.live.tools slot [running]: {"callId":"toolu_01G2…","name":"bash","taskId":13,"status":"running","output":"hello-from-bash\n"}
pi.live.tools slot [done]:    {"callId":"toolu_01G2…","name":"bash","taskId":13,"status":"done","entry":14}
entry kinds: pi.user 8, pi.system 11, pi.assistant 12 (toolUse), pi.tool-result 14, pi.assistant 16 (stop)
pi.assistant 12 content: [{"type":"toolCall","id":"toolu_01G2…","name":"bash","arguments":{"command":"echo hello-from-bash"}}]
pi.tool-result entry: {"model":[{"role":"toolResult","toolCallId":"toolu_01G2…","toolName":"bash",
  "content":[{"type":"text","text":"hello-from-bash\n"}],"isError":false,"durationMs":6,"timestamp":…}],
  "data":{"diagnostics":[]},"kind":"pi.tool-result","id":14,"conversationId":2,"byTaskId":13}
watch.value top-level keys: [ 'conversation', 'entries', 'docs' ] docs: [ 'pi.agent','pi.live','pi.inbox','pi.provider','pi.usage' ]
```

- Tool slot: `{callId, name, taskId, status: pending|running|done, output?, entry?}`. `entry` links the slot to its
  `pi.tool-result` entry once it is done. `taskId` is the ToolTask (it equals the result entry's `byTaskId`).
- Tool result entry: `model[0]` is a `ToolResultMessage` `{role:"toolResult", toolCallId, toolName, content[], isError,
  durationMs, timestamp}`, and `data.diagnostics` is `ToolDiagnostic[]`. Errors are rendered into the text as
  `<harness>\n[error] …\n</harness>`.
- **The agent `cwd` must be absolute.** With `configure({cwd: "spike/out"})` and an env built with that cwd, the bash
  tool resolved it a second time (`…/tobor/spike/out/spike/out`) and failed with
  "Working directory does not exist" (`exp2-relative-cwd.log`). `common.ts` now passes `OUT_ABS`.
- Watch listener: `(call, ctx)`, where `call = {kind:"value", value, ops, retired}`. The `ctx` given to the listener
  had no `abortSignal`.

## 3. Streaming ops encoding + replay (`spike/exp2-bash.ts stream-run …`, `spike/replay-fixture.ts`)

Prompt: run `for i in 1 2 3 4 5; do echo line-$i; sleep 0.4; done`, then explain in three sentences.

```
listener calls: 26
op kinds seen (first element of each op): {"s":19,"p":5,"a":14,"d":5}
pi.live.tools slot [running]: {…,"status":"running","output":"line-1\nline-2\nline-3\nline-4\nline-5\n"}
$ npx tsx spike/replay-fixture.ts bash-run   → bash-run: 12 calls replayed, 0 mismatches, final equal: true
$ npx tsx spike/replay-fixture.ts stream-run → stream-run: 26 calls replayed, 0 mismatches, final equal: true
```

Op encoding (chord `@earendil-works/chord/delta` `Op`), with paths as arrays from the view root:

| op | shape | example |
|---|---|---|
| `s` set | `["s", path, value]` | `["s", ["docs","pi.live","run"], {"taskId":10,"inputs":[9],"turns":0,"first":8}]` |
| `p` splice | `["p", path, index, deleteCount, items[]]` | `["p", ["entries"], 0, 0, [{…pi.user entry…}]]` |
| `a` string append | `["a", path, text]` | `["a", ["docs","pi.live","generation","message","content",0,"arguments","command"], "1 2 3 4 5; do …"]` |
| `d` delete | `["d", path]` | `["d", ["docs","pi.live","generation"]]` |

- `applyImmutable(replica, ops)` from `@earendil-works/chord/delta`, starting from `watch.value`, reproduces every
  delivered `value` exactly. Shipping `watch.value` and then `ops` over a WebSocket works as a replica protocol.
- Text deltas and tool-call argument deltas arrive as `a` ops into `docs["pi.live"].generation.message`. Tool output
  arrives in `docs["pi.live"].tools[i].output`, throttled (`progress.outputIntervalMs`). In this run all five lines
  showed up in one `running` slot snapshot.
- When a run ends, `pi.live.generation` and `run` are removed with `d` ops, and the final entries are spliced into
  `entries` with `p` ops.
