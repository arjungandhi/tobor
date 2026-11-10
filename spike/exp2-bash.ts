// Experiments 2 + 3: bash tool round-trip with a real model, recording every watch listener call as a fixture.
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { AssistantEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { assistantText, ctx, j, MODEL, OUT, OUT_ABS, openHarness } from "./common.ts";

// `npx tsx spike/exp2-bash.ts [name] [prompt]`; defaults to the experiment-2 prompt and the `bash-run` fixture.
const name = process.argv[2] ?? "bash-run";
const prompt = process.argv[3] ?? "Run `echo hello-from-bash` with the bash tool and tell me the output.";
const file = `${OUT}/${name}.sqlite`;
for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
const opsFile = `${OUT}/fixtures/${name}.ops.jsonl`;
const viewFile = `${OUT}/fixtures/${name}.view.json`;
writeFileSync(opsFile, "");

const harness = await openHarness({ file });
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
await conversation.configure({ model: MODEL, cwd: OUT_ABS }, ctx);

const watch = await conversation.watch(ctx);
writeFileSync(`${OUT}/fixtures/${name}.initial.json`, `${j(watch.value)}\n`);
let calls = 0;
const toolSlotShapes = new Map<string, unknown>();
const opKinds = new Map<string, number>();
watch.start(async (...args) => {
	calls++;
	const [call, listenerCtx] = args;
	if (calls === 1) {
		console.log("listener arity:", args.length, "call keys:", Object.keys(call), "ctx.abortSignal:", String(listenerCtx?.abortSignal));
	}
	appendFileSync(opsFile, `${j(call)}\n`);
	if (call.kind !== "value") return;
	for (const op of call.ops) {
		const kind = Array.isArray(op) ? String(op[0]) : typeof op;
		opKinds.set(kind, (opKinds.get(kind) ?? 0) + 1);
	}
	const tools = (call.value.docs as Record<string, { tools?: { status: string }[] } | undefined>)["pi.live"]?.tools;
	for (const slot of tools ?? []) toolSlotShapes.set(slot.status, slot);
});

const submission = await conversation.submit({ type: "input", content: prompt }, ctx);
const settled = await submission.wait(ctx);
console.log("settled:", j(settled));
// Let the watch deliver the commits that settled the run.
await conversation.waitForIdle(ctx);
await sleep(300);

console.log("listener calls:", calls);
console.log("op kinds seen (first element of each op):", j(Object.fromEntries(opKinds)));
for (const [status, slot] of toolSlotShapes) console.log(`pi.live.tools slot [${status}]:`, j(slot));

const page = await conversation.entries({ order: "ascending" }, 50, undefined, ctx);
console.log("entry kinds:", j(page.items.map((e) => ({ id: e.id, kind: e.kind }))));
for (const entry of page.items) {
	if (ToolResultEntry.is(entry)) console.log("pi.tool-result entry:", j(entry));
	if (AssistantEntry.is(entry)) {
		const msg = entry.model?.[0] as { stopReason?: string; content?: unknown[] };
		console.log(`pi.assistant ${entry.id} stopReason=${msg.stopReason} content:`, j(msg.content));
	}
}
if (settled.status === "done") {
	const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	console.log("final assistant text:", JSON.stringify(assistantText(answer)));
}

await watch.stop();
writeFileSync(viewFile, `${JSON.stringify(watch.value, null, 2)}\n`);
console.log("watch.value top-level keys:", Object.keys(watch.value), "docs:", Object.keys(watch.value.docs));
await harness.close(ctx);
