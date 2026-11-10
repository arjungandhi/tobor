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

## 4. Approval hook: await, crash, restart limit, abort, approve (`spike/hook-parent.ts`, `spike/hook-child.ts`)

`node --import tsx spike/hook-parent.ts`. The parent drives the child as one node process, so SIGKILL hits the
Harness itself (`npx tsx` would fork a grandchild). The child installs `hook(ToolTask, {beforeTool, afterTool})`. For
`bash` it prints `PENDING <callId>` and polls every 200 ms until `spike/out/approve` exists or `context.abortSignal`
aborts. Settings: `{ restartLimit: 2 }`. Prompt: "Use the bash tool to run `echo approved-run`, then reply with its
output only."

**Cancellation on the chord `Context`** is `context.abortSignal: AbortSignal | undefined`. Chord's `Context` has
`abortSignal`, `telemetry`, and `value(key)`, and `withCancel`/`withAbortSignal` derive children. The hook's context
always has a signal (`HOOK_CTX {"hasAbortSignal":true,"aborted":false}`).

(a) Submit, wait for PENDING, SIGKILL:
```
[a] HOOK_CTX {"hasAbortSignal":true,"aborted":false}
[a] PENDING toolu_019M… taskId=13
[a] SIGKILL -> {"code":null,"signal":"SIGKILL"}
```
(b) Restart with `resume()` and no prompt. **PENDING prints again**: the hook reruns, because intent is recorded only
after `beforeTool`.
```
[b1] INSPECT before-resume {"scheduling":"paused","tasks":[{"id":13,"kind":"pi.tool","status":"pending","restarts":1,…},
     {"id":10,"kind":"pi.generation","status":"waiting","inspection":{"kind":"waiting","on":[13]}}],"submissions":[{"id":9,"status":"placed"}]}
[b1] RESUMED
[b1] PENDING toolu_019M… taskId=13          (same callId, same task)
[b1] SIGKILL
```
(c) The second reopen reaches the limit (`restarts: 2` = `restartLimit`). The hook does not run again; the tool ends
itself:
```
[b2] INSPECT before-resume {…"restarts":2…}
[b2] AFTER_TOOL {"isError":true,"output":[],"diagnostics":[{"severity":"error","code":"restart_limit",
     "message":"Tool bash was interrupted 2 times in a row; it is not run again"}]}
[b2] REPORT {"kind":"task_interrupted","task":{"id":13,"kind":"pi.tool","conversationId":2},"reason":"restart_limit","restarts":2,…}
[b2] SETTLED {"status":"done","answer":16}           ← the run continued; the model apologised
[b2] PI_LIVE {}                                       ← no runFailure: the tool failed, not the run
[b2] ENTRY pi.tool-result: "<harness>\n[error] Tool bash was interrupted 2 times in a row; it is not run again\n</harness>"
     data.diagnostics[0].code = "restart_limit"
```
(d) Fresh run; the child calls `conversation.abort(ctx)` in-process while the hook waits:
```
[d] LIVE_TOOLS_WHILE_PENDING [{"callId":"toolu_01UH…","name":"bash","taskId":13,"status":"pending"}]
[d] INSPECT before-abort {… {"id":13,"kind":"pi.tool","status":"running"} …}
[d] ABORT_CALL
[d] HOOK_SIGNAL_ABORT {"reason":"AbortError: This operation was aborted"}
[d] HOOK_DECISION "cancelled"
[d] AFTER_TOOL {… "code":"blocked","message":"Tool call blocked: Cancelled while awaiting approval"}
[d] AFTER_TOOL {… "code":"aborted","message":"Tool bash was aborted"}
[d] ABORT_OUTCOME {"outcome":"resolved","ms":59}    (82 ms in the first run)
[d] SETTLED {"status":"unanswered","reason":"aborted"}
[d] PI_LIVE {"runFailure":{"taskId":10,"inputs":[9],"reason":"aborted","first":8}}
[d] ENTRY pi.tool-result: "<harness>\n[error] Tool bash was aborted\n</harness>"  (code "aborted")
```
(e) Fresh run; the parent creates the approve file while the hook is pending:
```
[e] PENDING toolu_01DA… taskId=13
[e] HOOK_DECISION "approved"
[e] AFTER_TOOL {"isError":false,"output":[{"type":"text","text":"approved-run\n"}]}
[e] HOOK_SIGNAL_ABORT {"reason":"Error: Task 13 invocation has ended"}
[e] SETTLED {"status":"done","answer":16}; tool-result entry text "approved-run\n"; final answer "approved-run"
```

Conclusions:
- An awaiting `beforeTool` works as an in-memory approval gate: it holds the run, and abort cancels it promptly through
  `context.abortSignal`.
- It is **not durable**. A crash reruns the hook, which is fine for re-asking. But every crash while waiting counts
  toward `restartLimit`, because waiting commits nothing. A daemon that restarts `restartLimit` times (default 5) with
  an approval outstanding turns the call into a `restart_limit` error result.
- The hook's context is aborted when the task invocation ends, including after a normal approve. Listeners attached to
  it must not outlive the hook.
- While the hook waits, the `pi.live.tools` slot says `pending`, the same as a call that has not started, while the
  ToolTask is `running`. The UI cannot tell "awaiting approval" from the live doc alone; tobor must publish its own
  approval state (a doc).
- After an abort, the stored result is `aborted`; the hook's `block` result only reaches `afterTool`.

## 5. Subagent conversation from a tool (`spike/subagent.ts`)

`node --import tsx spike/subagent.ts <mode>`. `spawn` creates the child conversation and submits to it.
`wait_for({submissionId})` awaits `harness.submission(id).wait(context)` and returns the child's answer text.
The child prompt is "run `sleep 5; echo child-done`". The task graph is sampled from `harness.inspect()` every 200 ms
and printed as `id:kind@c<conversation>:<state>(owner)`.

**fg**: inside `api.commit`, `tx.createConversation({ownership:{kind:"task", taskId: api.taskId}})` plus
`configure(tx, id, {model, cwd, instructions})`. After the commit, `api.conversation(id).submit(draft, ctx)`:
```
+ 1379ms TOOL spawn start {"taskId":13}
+ 1383ms TOOL spawn return {"conversationId":14,"submissionId":21}
+ 1445ms GRAPH 10:pi.generation@c2:waiting[13]  13:pi.tool@c2:completing(owner=10)  22:pi.generation@c14:running
+ 2250ms GRAPH … 13:pi.tool@c2:completing  22:pi.generation@c14:waiting[26]  26:pi.tool@c14:running(owner=22)
+ 7277ms GRAPH … 13:pi.tool@c2:completing  28:pi.generation@c14:running
+ 7880ms GRAPH 30:pi.generation@c2:running        ← parent resumes only after the child answered
+ 8536ms TOOL wait_for start / settled {"status":"done","answer":29}   (instant)
+ 9016ms PARENT settled done, answer "child-done"
CHILD conversation record {"id":14,"owner":{"conversationId":2,"taskId":13}}
```
- **Yes, the spawn tool task sits in `completing` for the whole child run, and the parent's generation waits on it.**
  The parent cannot do anything else meanwhile, and `wait_for` becomes pointless: by the time it is called, the child
  is done. A task-owned child is a synchronous subagent.
- In the child conversation, the tasks are conversation-owned (no `owner`). The conversation record carries
  `owner: {conversationId, taskId}`.

**abort** (fg, then `parent.abort(ctx)` while the child's bash runs):
```
+ 2593ms PARENT abort call
+ 2604ms PARENT abort resolved {"ms":11}
+ 2605ms CHILD submission status after parent abort {"status":"unanswered","reason":"aborted"}
+ 2654ms GRAPH (no live tasks)
```
- **Bottom-up abort reaches the task-owned child.** Its running bash, its generation, and its input are all aborted,
  and `abort()` resolved in 11 ms.

**bg**: `spawn` calls `api.createTask(Holder, {prompt}, {ownership:{kind:"conversation"}, background:true}, ctx)`.
`Holder` is a two-phase `defineTask`: `create` makes the conversation owned by itself and configures it; `submit`
calls `handle.submit(tx, {…requestId:"holder"})` and commits `terminal` with `{conversationId, submissionId}`.
`spawn` polls `api.getTask(holderId)` until it is `completing`/`terminal` and reads the outcome.
```
+ 1237ms GRAPH 10:pi.generation@c2:waiting[13]  13:pi.tool@c2:running  14:spike.subagent-holder@c2:completing(conv-owned,bg)  23:pi.generation@c15:running
+ 1256ms TOOL spawn return {"conversationId":15,"submissionId":22}
+ 1438ms GRAPH 14:…holder:completing(bg)  23:pi.generation@c15:running  26:pi.generation@c2:running   ← parent continues
+ 2078ms TOOL wait_for start
+ 7595ms TOOL wait_for settled {"requestId":"holder","status":"done","answer":33}
+ 8093ms PARENT settled done, answer "child-done"
```
- **Yes, a background task can own the child.** The holder's `terminal` is held as `completing` until the child's
  work drains, which keeps the child conversation alive and owned. The spawn tool returns at once, the parent keeps
  running, and `wait_for` really waits.

**bg-abort** (bg, then `parent.abort(ctx)` while the child's bash runs and the parent sits in `wait_for`):
```
+ 2797ms PARENT abort call
+ 2805ms PARENT abort resolved {"ms":8}
+ 2805ms CHILD submission status after parent abort {"status":"placed"}
+ 3105ms PARENT settled {"status":"unanswered","reason":"aborted"}
+ 7710ms CHILD settled {"status":"done","answer":34}      ← child ran on to completion
```
- The background boundary works as documented. A plain `parent.abort()` aborts the parent's `wait_for` (an in-memory
  `submission.wait` cancelled through its context) and leaves the background child running. Stopping the child needs
  `abort(ctx, {background:true})` or `harness.abortTask(holderId)` [INFERENCE: not run].
- `wait_for` is an in-memory wait inside a non-replay-safe tool. After a crash it would be interrupted. A durable wait
  needs a task that `waiting`-joins the holder (`{status:"waiting", on:[holderId]}`) [INFERENCE: not run].

## 6. Exports and types check (installed 1.5.1 `.d.ts`, plus a runtime import probe)

Package exports of pi-durable: `.`, `./env`, `./env/node`, `./codemode`, `./tool-search`, `./tools`, `./images`,
`./images/node`, `./images/cloudflare`, `./storage/{memory,indexeddb,jsonl,jsonl/node,store,sqlite,sqlite/cloudflare,sqlite/node}`,
`./testing`. There are no wildcard subpaths.

| Symbol | Status / signature |
|---|---|
| `withFileMutationQueue` | **Not importable.** Declared in `dist/tools/file-mutation-queue.d.ts`: `withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>, context: Context): Promise<T>`, which serializes per env id plus canonical path within the process. It is not re-exported from `.` or `./tools`, and the deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. |
| `createReadTool` | `./tools`: `(options?: { images?: ImageProcessor }) => ToolRegistration<{path, offset?, limit?}, ReadToolDetails>`. `ReadToolDetails = { truncation?: … }`. |
| `createEditTool` | `./tools`: `() => ToolRegistration<{path, edits: {oldText, newText}[]}, EditToolDetails>`, where `EditToolDetails = {diff, patch, firstChangedLine?}`. No options. |
| `createWriteTool` | `./tools`: `() => ToolRegistration<{path, content}>`. No options. |
| `createBashTool` | `./tools`: `(options?: { commandPrefix?: string; prepare?: BashPrepare }) => ToolRegistration<{command, timeout?}>`. `BashPrepare = (execution: {command, cwd, env: Record<string,string>, inheritEnv}, api: ToolExecutionApi, ctx) => void \| Promise<void>`, which mutates the execution before it runs. Also `createPowerShellTool`, `createCodingTools(readOptions?)`, `CodingTools`, `DEFAULT_IMAGE_LIMITS`. |
| `wrapTool` | Root: `wrapTool<Tool>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool>`, used in `Extension.wraps`. It wraps the same-named tool wherever the wrapping extension is selected. `wrapSection(key, wrapper)` also exists. |
| `defineDoc` | Root, with overloads by `scope`: `"session"` (Session-wide singleton, e.g. a global approvals queue), conversation `history:"latest"\|"rewindable"`, and `"task"`. `CommonDocDefinition<T> = {kind, version, initial(), migrate?, checkpointWhen(value, ops, info): boolean}`. `defineDocFamily` adds keyed docs, `initial(seed)`. Read with `harness.snapshot`, `watchDoc`, `observeDoc`, `tx.doc`. |
| `defineTask` | Root: `defineTask<I, S extends {phase}, R, H>({name, version, initial(input), phases: {[phase]: (task, runtime, ctx) => Promise<void>}, abort(task, runtime, ctx), migrate?, hooks?})`. Each phase must commit a new checkpoint or a terminal outcome. `TaskRuntime` has `taskId`, `conversationId`, `signal`, `commit`, `memo`, `getTask`, `waitForTask`, `abortOwned`, `ownedTasks`, `outcomes`, `conversation(id)`, `entry`, `entries`, `context`, `now`, `setTimer`, `report`, `sleepUntil`, `env`, `agent`, `settings`, `models`, `hooks`. |
| `ConversationTranscript` | Root class: `new ConversationTranscript(load: (query, limit, ctx) => Promise<Page<EntryRecord>>, {pageSize?})`. Members: `newest`, `resume` (a `ConversationWindow` for re-watching), `merge(view) → TranscriptView {items: (entry\|gap\|earlier)[] …}`, `loadEarlier(ctx)`, `fillGap(gap, ctx)`. |
| `hook` | Root: `hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration`. |
| `ToolTask` | Root: `Task<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>`. `ToolHooks.beforeTool(call: ToolCall & {parent?}, api: HookApi, ctx) → {arguments?, block?}` and `afterTool(call, result, api, ctx) → ToolExecutionResult`. |
| `GenerationTask` | Root: `Task<…, GenerationHooks>`, with hooks `beforeRequest({messages})`, `beforeProviderRequest({model, payload})`, `afterResponse(msg)`, `onYield(answer) → {continue: UserInput}`, `afterTools(assistantId, resultIds)`, `afterRun(RunSummary) → {tasks: RunEndTask[]}`. `CompactionTask` has `beforeCompact`. |
| `HarnessSettings` | `extensions?`, `stream?`, `retry?`, `compaction?`, `progress?`, `toolExecution?`, `steeringMode?`, `followUpMode?`, `contextRetentionMs?`, `documentRetentionMs?`, `afterFailedRun?`, `restartLimit?`. |
| `AgentChange` | `model?`, `thinkingLevel?`, `extensions?` (array or `{add, remove}`), `tools?` (array or `{remove}`), `modelTools?` (array or `{add, remove}`), `instructions?`, `cwd?`, `maxTurns?`, `compaction?`. Every field is nullable, where `null` resets it to the host default. Root `configure(tx, conversationId, change)` applies it inside a commit. |
| `Submission` | `{ id; status(ctx): Promise<SubmissionRecord>; wait(ctx): Promise<SettledSubmissionRecord>; abort(ctx): Promise<"aborted"\|"already_placed"\|"settled"> }`. |
| `SubmissionRecord` / `SettledSubmissionRecord` | `{id, conversationId, requestId?, trace?, type}`, with status by type. `input`: `queued` / `placed{entry}` / `done{entry, answer}` / `unanswered{entry?, reason: string, detail?}`. `write`: `queued`/`done`/`unanswered`. `continue`: `placed`/…. Settled = `done \| unanswered`. |
| `EntryQuery` | `{conversationId, minEntryId?, maxEntryId?, order?: "ascending"\|"descending"}` (default descending). **There is no kind filter.** |
| List conversations | **Harness has no list method.** Use `harness.commit(tx => tx.scanConversations({ownerConversationId?, ownerTaskId?, order?}, limit, cursor))`, which returns `Page<ConversationRecord>`. Records are `{id, parent?, owner?}` only, with no title or timestamps. Other Tx scans: `scanTasks({conversationId?, kind?, status?, abortRequested?, background?})`, `scanEntries`. |
| `Harness` members | `resume`, `wake`, `root`, `conversation`, `createConversation(options: {ownership, agent?, init?})`, `getTask`, `inspect`, `submission`, `abortSubmission`, `abortTask`, `waitForTask`, `waitForIdle`, `usage`, `watchTaskGraph`, `observeConversation`, `observeTaskGraph`. Inherited from `Session`: `commit`, `close`, `closed`, `observeDoc`, `observeCommits`, `subscribeClose`, `snapshot`, `snapshotAsOf`, `watchDoc`. |
| `ToolExecutionApi` | `taskId`, `conversationId`, `callId`, `registry`, `agent(ctx)`, `models`, `env`, `now()`, `output(chunk, skipped?)`, `outputWindow`, `retainedOutput()`, `diagnostic(d)`, `details(v, ctx)`, `commit(fn, ctx, opts?)`, `memo`, `createTask(task, input, Omit<TaskOptions,"conversationId">, ctx)`, `getTask`, `waitForTask`, `conversation(id, ctx): ConversationHandle {id, submit, abort, waitForIdle}`, `executeTool(name, args, ctx, {key?, progress?})`, plus `DocumentReader`/`DocumentObserver` (`snapshot`, `watchDoc`). It has no handle to the Harness; `wait_for` used a closure over it. |
| pi-ai `CredentialStore` | `read(providerId, opts?)`, `list(opts?) → {providerId, type}[]`, `modify(providerId, fn(current) → Promise<Credential\|undefined>, opts?)`, `delete(providerId, opts?)`. `Credential = {type:"api_key", key?, env?} \| {type:"oauth", refresh, access, expires, …}`. |
| pi-ai `createModels` | `createModels({credentials?: CredentialStore, modelsStore?: ModelsStore, authContext?: AuthContext, identity?: ClientIdentity}) → MutableModels` (`setProvider`/`deleteProvider`/`clearProviders`). |
| `models.login` | `login(providerId: string, type: "api_key"\|"oauth", interaction: {signal?, prompt(p: text\|secret\|select\|manual_code) → Promise<string>, notify(e: info\|auth_url\|device_code\|progress)}, options?: {getDeviceId?, agentName?}) → Promise<Credential>`. Also `logout`, `checkAuth`, `getAuth`. |
| Anthropic OAuth | **Listed.** At runtime, `anthropicProvider().auth` has keys `apiKey` and `oauth`. `oauth` has `name: "Anthropic (Claude Pro/Max)"`, `isSubscription`, `loginLabel`, `login`, `refresh`, and `toAuth`. Login was not run. |
| Haiku ids | `claude-haiku-4-5` ($1/$5 per Mtok, used in every run here), `claude-haiku-4-5-20251001`, and `claude-haiku-5-5` ($0.1/$0.5), which is cheaper. |

## Decisions forced

1. **Approvals must be modeled outside the `beforeTool` await.** The hook gate itself works: it blocks, abort
   cancels it via `ctx.abortSignal`, and an approve resumes it. But it has three gaps: crashes while waiting count
   toward `restartLimit`, nothing about it is persisted, and the live slot shows plain `pending`. tobor should keep
   pending approvals in a Session-scoped `defineDoc`, written by the hook before it waits and resolved by the
   HTTP/UI side. The hook then waits on that doc (`watchDoc`/`observeDoc`) instead of a file. On restart it re-reads
   the doc and either finds the decision or re-asks.
   - Set `settings.restartLimit` high, or document that N daemon restarts with an approval outstanding fail the call.
   - Otherwise approval needs a durable task: a replay-safe tool that creates an approval task and `waitForTask`s it.
     Its cost is one extra task per gated call.
2. **Worker ownership: background holder task, not the tool task.**
   - A child conversation owned by the calling tool's task keeps that tool `completing`, which stalls the parent's
     whole run until the child finishes. That is acceptable only for a synchronous "subagent" tool.
   - Director-mode workers that run concurrently with the director need a `background: true`, conversation-owned
     holder task that creates and submits to the child. The holder's terminal outcome holds as `completing` while
     the child runs.
   - Background workers survive `director.abort()`. Stopping them is explicit: `abortTask(holderId)` or
     `abort({background:true})`.
3. **Wait strategy: never hold a director tool open on a worker.**
   - `wait_for` as an in-memory `submission.wait` blocks the director's run, is cancelled by a director abort, and is
     not crash-durable.
   - Prefer telling the director when a worker finishes by submitting into the director conversation, e.g. an
     `afterRun` hook in the worker, or the holder task's last phase, doing `handle.submit({type:"input",
     whenBusy:"steer"…, requestId})`.
   - If a blocking wait is wanted, implement it as a task that `waiting`-joins the holder.
4. **Missing APIs to build or work around:**
   - `withFileMutationQueue` is not exported. Custom file-mutating tools cannot share the built-in edit/write queue,
     so wrap the built-in tools (`wrapTool`) instead of re-implementing them.
   - There is no conversation listing with metadata. `tx.scanConversations` returns `{id, parent?, owner?}` only, so
     tobor needs its own Session doc for titles, timestamps, and kinds.
   - `EntryQuery` has no kind filter, so filter client-side.
   - `ToolExecutionApi` has no Harness handle. Tools that need `harness.submission()` close over the module-level
     Harness, or use `api.conversation(id)`.
   - The live tool slot has no "awaiting approval" state; see 1.
5. **Configuration facts:**
   - Agent `cwd` must be absolute.
   - Spawn child processes with `node --import tsx`, not `npx tsx`, wherever signals matter.
   - Watch `ops` replay exactly through chord `applyImmutable`, so the WS protocol is `watch.value` followed by
     forwarded `ops`.
   - Consider `claude-haiku-5-5` as the cheap default model.
