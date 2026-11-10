// Experiment 4 child: a Harness whose `beforeTool` hook holds every `bash` call until `spike/out/approve` exists or the
// hook's context is cancelled. Driven by spike/hook-parent.ts over stdout lines.
//
//   npx tsx spike/hook-child.ts submit   # create a conversation, submit a prompt that forces one bash call
//   npx tsx spike/hook-child.ts resume   # reopen, inspect, harness.resume(), no prompt
//   npx tsx spike/hook-child.ts abort    # as submit, then conversation.abort() in-process once PENDING
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	type Harness,
	hook,
	LiveDoc,
	type SubmissionId,
	ToolTask,
	type ConversationId,
} from "@earendil-works/pi-durable";
import { assistantText, ctx, j, MODEL, OUT, OUT_ABS, openHarness } from "./common.ts";

const mode = process.argv[2] ?? "submit";
const file = `${OUT}/hook.sqlite`;
const stateFile = `${OUT}/hook.state.json`;
const approveFile = `${OUT}/approve`;
const say = (tag: string, value?: unknown) => console.log(value === undefined ? tag : `${tag} ${j(value)}`);

/** Resolves when the approve file appears (`approved`) or the context's abort signal fires (`cancelled`). */
async function awaitApproval(context: Context): Promise<"approved" | "cancelled"> {
	const signal = context.abortSignal;
	while (true) {
		if (signal?.aborted) return "cancelled";
		if (existsSync(approveFile)) return "approved";
		await sleep(200);
	}
}

const Approval = defineExtension({
	name: "spike-approval",
	hooks: [
		hook(ToolTask, {
			async beforeTool(call, api, context) {
				if (call.name !== "bash") return undefined;
				say("HOOK_CTX", {
					hasAbortSignal: context.abortSignal !== undefined,
					aborted: context.abortSignal?.aborted ?? null,
				});
				context.abortSignal?.addEventListener("abort", () =>
					say("HOOK_SIGNAL_ABORT", { reason: String(context.abortSignal?.reason) }),
				);
				console.log(`PENDING ${call.id} taskId=${api.taskId}`);
				const decision = await awaitApproval(context);
				say("HOOK_DECISION", decision);
				return decision === "approved" ? undefined : { block: "Cancelled while awaiting approval" };
			},
			async afterTool(call, result) {
				say("AFTER_TOOL", { callId: call.id, isError: result.isError ?? false, output: result.output, diagnostics: result.diagnostics });
				return undefined;
			},
		}),
	],
});

const harness: Harness = await openHarness({
	file,
	extensions: [Approval],
	settings: { restartLimit: 2 },
	onReport: (report) => say("REPORT", { ...report, error: String(report.error) }),
});

async function inspect(label: string) {
	const inspection = await harness.inspect(ctx);
	say(`INSPECT ${label}`, {
		scheduling: inspection.scheduling,
		tasks: inspection.tasks.map((t) => ({
			id: t.record.id,
			kind: t.record.kind,
			status: t.record.state.status,
			restarts: t.record.restarts,
			inspection: t.state,
		})),
		submissions: inspection.submissions.map((s) => ({ id: s.id, status: s.status })),
	});
}

async function finish(conversationId: ConversationId, submissionId: SubmissionId) {
	const submission = await harness.submission(submissionId, ctx);
	const settled = await submission!.wait(ctx);
	say("SETTLED", settled);
	await inspect("after-settle");
	const live = await harness.snapshot(LiveDoc, conversationId, ctx);
	say("PI_LIVE", live);
	const conversation = (await harness.conversation(conversationId, ctx))!;
	const page = await conversation.entries({ order: "ascending" }, 50, undefined, ctx);
	for (const entry of page.items) {
		if (entry.kind === "pi.system") continue;
		if (entry.kind === "pi.assistant") say("ENTRY", { id: entry.id, kind: entry.kind, text: assistantText(entry), content: (entry.model?.[0] as { content?: unknown }).content });
		else say("ENTRY", entry);
	}
	await harness.close(ctx);
	say("CLOSED", await harness.closed);
	process.exit(0);
}

if (mode === "resume") {
	const state = JSON.parse(readFileSync(stateFile, "utf8")) as { conversationId: ConversationId; submissionId: SubmissionId };
	await inspect("before-resume");
	harness.resume();
	say("RESUMED");
	await sleep(500);
	await inspect("after-resume");
	await finish(state.conversationId, state.submissionId);
} else {
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	await conversation.configure({ model: MODEL, cwd: OUT_ABS }, ctx);
	const submission = await conversation.submit(
		{ type: "input", content: "Use the bash tool to run `echo approved-run`, then reply with its output only." },
		ctx,
	);
	writeFileSync(stateFile, j({ conversationId: conversation.id, submissionId: submission.id }));
	say("SUBMITTED", { conversationId: conversation.id, submissionId: submission.id });
	if (mode === "abort") {
		// Wait for the hook to be pending, then abort from this process.
		while (true) {
			const live = await harness.snapshot(LiveDoc, conversation.id, ctx);
			if (live?.tools?.some((t) => t.status !== "done")) {
				say("LIVE_TOOLS_WHILE_PENDING", live.tools);
				break;
			}
			await sleep(200);
		}
		await sleep(1000);
		await inspect("before-abort");
		const started = Date.now();
		say("ABORT_CALL");
		const aborted = conversation.abort(ctx).then(() => "resolved" as const);
		const outcome = await Promise.race([aborted, sleep(15_000).then(() => "timeout" as const)]);
		say("ABORT_OUTCOME", { outcome, ms: Date.now() - started });
		if (outcome === "timeout") {
			writeFileSync(approveFile, "");
			say("ABORT_AFTER_APPROVE_FILE", { outcome: await aborted, ms: Date.now() - started });
		}
	}
	await finish(conversation.id, submission.id);
}
