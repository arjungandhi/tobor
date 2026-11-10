// Experiment 1: open SQLite storage, create an ownerless conversation, prompt a real model, read the answer.
import { rmSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { assistantText, ctx, j, MODEL, OUT, openHarness } from "./common.ts";

const file = `${OUT}/a.sqlite`;
for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });

const models = createModels();
models.setProvider(anthropicProvider());

const harness = await openHarness({ file, models });
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
console.log("conversation.id:", conversation.id);
await conversation.configure({ model: MODEL, cwd: OUT }, ctx);

const submission = await conversation.submit({ type: "input", content: "Reply with exactly: pong" }, ctx);
console.log("submission.id:", submission.id);
const settled = await submission.wait(ctx);
console.log("settled:", j(settled));

if (settled.status === "done") {
	// Typed read inside a commit (the README's Quick Start pattern).
	const typed = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	console.log("AssistantEntry via tx.entry:", j(typed));
	console.log("assistant text:", JSON.stringify(assistantText(typed)));
	// Untyped page read through Conversation.entries (newest first by default).
	const page = await conversation.entries({ order: "ascending" }, 10, undefined, ctx);
	console.log("entries page kinds:", j(page.items.map((e) => ({ id: e.id, kind: e.kind }))), "next:", j(page.next));
	const system = page.items.find((e) => e.kind === "pi.system");
	console.log("pi.system entry (trimmed):", j(system).slice(0, 600));
}
console.log("usage:", j(await harness.usage(ctx)));
await harness.close(ctx);
console.log("closed:", j(await harness.closed));
