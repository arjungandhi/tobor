// Real-model smoke: `ANTHROPIC_API_KEY=… node --import tsx test/harness/smoke.ts [roots-dir]`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type SubmissionId } from "@earendil-works/pi-durable";
import { boot } from "../../src/server/harness/boot.js";
import { entryText } from "./helpers.js";

const root = process.argv[2] ?? "/home/monkey/repos/github.com/arjungandhi";
const home = await mkdtemp(join(tmpdir(), "tobor-smoke-"));
await mkdir(join(home, ".tobor"), { recursive: true });
await writeFile(join(home, ".tobor", "config.yml"), `roots: [${JSON.stringify(root)}]\ndefaults:\n  thinking: "off"\n`);

const host = await boot({ home });
host.events.onAny((e) => console.log("event", JSON.stringify(e)));
const { id, submissionId } = await host.sessions.create({
	cwd: root,
	model: "anthropic/claude-haiku-5-5",
	prompt: "reply pong",
});
console.log("session", id, "submission", submissionId);
const submission = await host.harness.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT);
const settled = await submission!.wait(BACKGROUND_CONTEXT);
console.log("settled", JSON.stringify(settled));
if (settled.status === "done" && settled.answer !== undefined) {
	const conversation = (await host.harness.conversation(settled.conversationId, BACKGROUND_CONTEXT))!;
	const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
	console.log("assistant text:", JSON.stringify(entryText(answer)));
}
console.log("list", JSON.stringify(await host.sessions.list()));
console.log("shutdown", await host.shutdown());
await rm(home, { recursive: true, force: true });
