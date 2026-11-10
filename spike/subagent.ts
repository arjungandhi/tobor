// Experiment 5: a subagent conversation started from a tool, and a second tool that waits for it.
//   npx tsx spike/subagent.ts fg        # `spawn`: child conversation owned by the spawn tool's task
//   npx tsx spike/subagent.ts abort     # as fg, then parent.abort() while the child's bash runs
//   npx tsx spike/subagent.ts bg        # `spawn`: child owned by a background conversation-owned holder task
//   npx tsx spike/subagent.ts bg-abort  # as bg, then parent.abort() while the child's bash runs
// The parent's tool task graph is sampled every 200 ms and printed when it changes.
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
	AssistantEntry,
	configure,
	type ConversationId,
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";
import { assistantText, ctx, j, MODEL, OUT, OUT_ABS, openHarness } from "./common.ts";

const mode = process.argv[2] ?? "fg";
const background = mode.startsWith("bg");
const file = `${OUT}/subagent-${mode}.sqlite`;
for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });

const t0 = Date.now();
const say = (tag: string, value?: unknown) =>
	console.log(`+${String(Date.now() - t0).padStart(5)}ms ${tag}${value === undefined ? "" : ` ${j(value)}`}`);

const CHILD_AGENT = { model: MODEL, cwd: OUT_ABS, instructions: "You are a subagent. Do exactly what the input says." };
type Spawned = { conversationId: ConversationId; submissionId: SubmissionId };

/** Background holder: creates the child conversation owned by itself, submits, and completes with the ids. */
type HolderState = { phase: "create" } | { phase: "submit"; conversationId: ConversationId };
const Holder = defineTask<{ prompt: string }, HolderState, Spawned>({
	name: "spike.subagent-holder",
	version: 1,
	initial: () => ({ phase: "create" }),
	phases: {
		async create(task, runtime, context) {
			await runtime.commit(async (tx) => {
				const record = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
				await configure(tx, record.id, CHILD_AGENT);
				return { status: "running", checkpoint: { phase: "submit", conversationId: record.id } };
			}, context);
		},
		async submit(task, runtime, context) {
			const { conversationId } = task.state.checkpoint;
			const handle = (await runtime.conversation(conversationId, context))!;
			await runtime.commit(async (tx) => {
				const submissionId = await handle.submit(tx, { type: "input", content: task.input.prompt, requestId: "holder" });
				return { status: "terminal", outcome: { status: "completed", result: { conversationId, submissionId } } };
			}, context);
		},
	},
	async abort(_task, runtime, context) {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

let harness: Harness;
let child: Spawned | undefined;

const spawnTool = defineTool({
	name: "spawn",
	description: "Start a subagent on a prompt. Returns its submissionId; pass it to wait_for to get the answer.",
	parameters: obj({ prompt: str() }),
	async execute(args, api, context) {
		say("TOOL spawn start", { taskId: api.taskId });
		if (!background) {
			const conversationId = await api.commit(async (tx) => {
				const record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, record.id, CHILD_AGENT);
				return record.id;
			}, context);
			const handle = (await api.conversation(conversationId, context))!;
			const submission = await handle.submit({ type: "input", content: args.prompt }, context);
			child = { conversationId, submissionId: submission.id };
		} else {
			const holderId = (await api.createTask(
				Holder,
				{ prompt: args.prompt },
				{ ownership: { kind: "conversation" }, background: true },
				context,
			)) as TaskId<Spawned>;
			say("TOOL spawn holder created", { holderId });
			// The holder completes (or sits in `completing`) once it submitted; its outcome carries the ids.
			while (true) {
				const record = await api.getTask(holderId, context);
				if (record?.state.status === "completing" || record?.state.status === "terminal") {
					const outcome = record.state.outcome;
					if (outcome.status !== "completed") throw new Error(`holder ${j(outcome)}`);
					child = outcome.result;
					break;
				}
				await sleep(100);
			}
		}
		say("TOOL spawn return", child);
		return { output: [{ type: "text", text: `submissionId: ${child.submissionId}` }] };
	},
});

const waitForTool = defineTool({
	name: "wait_for",
	description: "Wait for a subagent's submission and return its answer.",
	parameters: obj({ submissionId: num() }),
	async execute(args, api, context) {
		say("TOOL wait_for start", { taskId: api.taskId, submissionId: args.submissionId });
		const submission = await harness.submission(args.submissionId as SubmissionId, context);
		if (!submission) throw new Error(`no submission ${args.submissionId}`);
		const settled = await submission.wait(context);
		say("TOOL wait_for settled", settled);
		if (settled.status !== "done") return { output: [{ type: "text", text: `unanswered: ${settled.reason}` }], isError: true };
		const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { output: [{ type: "text", text: assistantText(answer) }] };
	},
});

harness = await openHarness({
	file,
	extensions: [defineExtension({ name: "spike-subagent", tools: [spawnTool, waitForTool], tasks: [Holder] })],
	onReport: (report) => say("REPORT", { ...report, error: String(report.error) }),
});

let lastGraph = "";
let sampling = true;
async function sample() {
	while (sampling) {
		const inspection = await harness.inspect(ctx);
		const graph = inspection.tasks
			.map((t) => {
				const r = t.record;
				const tags = [r.owner === undefined ? "conv-owned" : `owner=${r.owner}`, r.background ? "bg" : "", r.abortRequested ? "abortReq" : ""];
				return `${r.id}:${r.kind}@c${r.conversationId}:${t.state.kind}${"on" in t.state ? `${j(t.state.on)}` : ""}(${tags.filter(Boolean).join(",")})`;
			})
			.join("  ");
		if (graph !== lastGraph) {
			say("GRAPH", graph || "(no live tasks)");
			lastGraph = graph;
		}
		await sleep(200);
	}
}
void sample();

const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
await parent.configure({ model: MODEL, cwd: OUT_ABS }, ctx);
const childPrompt = "Use the bash tool to run `sleep 5; echo child-done`, then reply with its output only.";
const submission = await parent.submit(
	{
		type: "input",
		content: `Call the spawn tool with prompt: "${childPrompt}". Then call wait_for with the submissionId it returns. Then reply with wait_for's result only.`,
	},
	ctx,
);
say("PARENT submitted", { conversationId: parent.id, submissionId: submission.id });

if (mode.endsWith("abort")) {
	// Abort once the child's bash call is running.
	while (true) {
		const inspection = await harness.inspect(ctx);
		if (child && inspection.tasks.some((t) => t.record.conversationId === child!.conversationId && t.record.kind === "pi.tool")) break;
		await sleep(100);
	}
	await sleep(500);
	const started = Date.now();
	say("PARENT abort call");
	await parent.abort(ctx);
	say("PARENT abort resolved", { ms: Date.now() - started });
	const childSubmission = await harness.submission(child!.submissionId, ctx);
	say("CHILD submission status after parent abort", await childSubmission!.status(ctx));
	await sleep(300);
}

const settled = await submission.wait(ctx);
say("PARENT settled", settled);
if (settled.status === "done") {
	const answer = await parent.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	say("PARENT answer", assistantText(answer));
}
if (child) {
	const childSubmission = await harness.submission(child.submissionId, ctx);
	const childSettled = await Promise.race([childSubmission!.wait(ctx), sleep(15_000).then(() => "still running after 15s")]);
	say("CHILD settled", childSettled);
	const childConversation = (await harness.conversation(child.conversationId, ctx))!;
	const page = await childConversation.entries({ order: "ascending" }, 20, undefined, ctx);
	say("CHILD entries", page.items.filter((e) => e.kind !== "pi.system").map((e) => ({ id: e.id, kind: e.kind, byTaskId: e.byTaskId, text: e.kind === "pi.assistant" ? assistantText(e) : undefined })));
	const records = await harness.commit(async (tx) => tx.conversation(child!.conversationId), ctx);
	say("CHILD conversation record", records);
}
await sleep(500);
sampling = false;
const parentEntries = await parent.entries({ order: "ascending" }, 30, undefined, ctx);
say(
	"PARENT entries",
	parentEntries.items
		.filter((e) => e.kind !== "pi.system")
		.map((e) => ({ id: e.id, kind: e.kind, model: j(e.model?.[0]).slice(0, 220) })),
);
await harness.close(ctx);
process.exit(0);
