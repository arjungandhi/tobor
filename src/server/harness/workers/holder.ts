import {
	configure,
	type ConversationId,
	defineTask,
	type EntryRecord,
	type ModelRef,
	type RegistrySnapshot,
	type SubmissionId,
	type SubmissionRecord,
	type Task,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ApprovalMode, ThinkingLevel, WorkerState } from "../../../api/types.js";
import { SessionDoc, WorkersDoc } from "../../../docs.js";

/** How often the `await` phase re-checks the latest worker submission (pi-durable waits only on task ids). */
export const WORKER_POLL_MS = 5000;

/** Input of one `tobor.worker` holder, fully resolved by the `task` tool. */
export type WorkerInput = {
	workerId: string;
	name: string;
	agent: string;
	/** Director conversation; also the holder's own conversation. */
	directorId: ConversationId;
	brief: string;
	/** `<callId>:<i>`. */
	requestId: string;
	cwd: string;
	model?: ModelRef;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	/** Tool names offered to the worker. */
	tools: string[];
	/** Agent body, the worker's instructions. */
	instructions: string;
	approvalMode: ApprovalMode;
};

/** Holder result once the worker settled. */
export type WorkerResult = { state: WorkerState; answer: string; reason?: string };

type HolderState =
	| { phase: "create" }
	| { phase: "submit"; conversationId: number }
	| { phase: "await"; conversationId: number; submissionId: number }
	| { phase: "report"; conversationId: number; submissionId: number };

/** Callbacks a holder makes after its commits (not durable; for events). */
export type WorkerHolderDeps = { onChange?(directorId: number, workerId: string): void; /** Default `WORKER_POLL_MS`. */ pollMs?: number };

/** Concatenated text blocks of an assistant entry's model message. */
export function assistantText(entry: Pick<EntryRecord, "model"> | undefined): string {
	const message = entry?.model?.[0];
	if (!message || message.role !== "assistant") return "";
	return message.content
		.flatMap((c) => (c.type === "text" ? [c.text] : []))
		.join("")
		.trim();
}

/** Text of the director follow-up a finished worker submits. */
export function reportText(name: string, state: WorkerState, answer: string, reason?: string): string {
	const status = reason === undefined ? state : `${state} (${reason})`;
	return `[worker ${name} finished: ${status}]\n${answer || "(no final text)"}`;
}

/** Registrations named in `names`, the last installed one per name, in `names` order. */
export function resolveTools(registry: RegistrySnapshot, names: readonly string[]): ToolRegistration[] {
	const byName = new Map<string, ToolRegistration>();
	for (const { tool } of registry.tools()) byName.set(tool.name, tool);
	return names.flatMap((n) => byName.get(n) ?? []);
}

/** Settle outcome of a worker submission record, or undefined while unsettled. */
export async function settledResult(tx: Tx, record: SubmissionRecord | undefined): Promise<WorkerResult | undefined> {
	if (!record || record.type !== "input") return { state: "failed", answer: "", reason: "submission missing" };
	if (record.status === "done") return { state: "done", answer: assistantText(await tx.entry(record.answer)) };
	if (record.status === "unanswered") {
		return { state: record.reason === "aborted" ? "aborted" : "failed", answer: "", reason: record.reason };
	}
	return undefined;
}

/** The `tobor.worker` task type. */
export type WorkerHolderTask = Task<WorkerInput, HolderState, WorkerResult, object>;

/** `tobor.worker`: background, director-owned holder that creates, briefs, awaits and reports one worker. */
export function createWorkerHolder(deps: WorkerHolderDeps = {}): WorkerHolderTask {
	const changed = (input: WorkerInput) => deps.onChange?.(input.directorId, input.workerId);
	return defineTask<WorkerInput, HolderState, WorkerResult>({
		name: "tobor.worker",
		version: 1,
		initial: () => ({ phase: "create" }),
		phases: {
			async create(task, runtime, context) {
				const input = task.input;
				const tools = resolveTools(runtime.registry, input.tools);
				await runtime.commit(async (tx) => {
					const record = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
					await configure(tx, record.id, {
						cwd: input.cwd,
						tools: null,
						modelTools: tools,
						instructions: input.instructions || null,
						maxTurns: input.maxTurns ?? null,
						...(input.model ? { model: input.model } : {}),
						...(input.thinking ? { thinkingLevel: input.thinking } : {}),
					});
					const session = await tx.doc(SessionDoc, record.id);
					session.title = input.name;
					session.approval_mode = input.approvalMode;
					session.mode = "solo";
					session.cwd = input.cwd;
					session.createdAt = runtime.now();
					session.worker = { id: input.workerId, name: input.name, agent: input.agent, parentId: input.directorId };
					const w = (await tx.doc(WorkersDoc, input.directorId)).workers[input.workerId];
					if (w) w.conversationId = record.id;
					return { status: "running", checkpoint: { phase: "submit", conversationId: record.id } };
				}, context);
				changed(input);
			},
			async submit(task, runtime, context) {
				const input = task.input;
				const { conversationId } = task.state.checkpoint;
				const handle = await runtime.conversation(conversationId as ConversationId, context);
				if (!handle) throw new Error(`worker conversation ${conversationId} missing`);
				await runtime.commit(async (tx) => {
					const submissionId = await handle.submit(tx, {
						type: "input",
						content: input.brief,
						requestId: input.requestId,
					});
					const w = (await tx.doc(WorkersDoc, input.directorId)).workers[input.workerId];
					if (w) {
						w.submissionId = submissionId;
						w.state = "running";
					}
					return { status: "running", checkpoint: { phase: "await", conversationId, submissionId } };
				}, context);
				changed(input);
			},
			async await(task, runtime, context) {
				const input = task.input;
				const checkpoint = task.state.checkpoint;
				await runtime.commit(async (tx) => {
					// `agent_send` moves the record's submission on; poll the latest one.
					const latest = (await tx.doc(WorkersDoc, input.directorId)).workers[input.workerId]?.submissionId ?? checkpoint.submissionId;
					const record = await tx.submission(latest as SubmissionId);
					if (record && (record.status === "queued" || record.status === "placed")) {
						return { status: "sleeping", until: runtime.now() + (deps.pollMs ?? WORKER_POLL_MS), checkpoint: { ...checkpoint, submissionId: latest } };
					}
					return { status: "running", checkpoint: { ...checkpoint, submissionId: latest, phase: "report" } };
				}, context);
			},
			async report(task, runtime, context) {
				const input = task.input;
				const { conversationId, submissionId } = task.state.checkpoint;
				const director = await runtime.conversation(input.directorId, context);
				if (!director) throw new Error(`director conversation ${input.directorId} missing`);
				await runtime.commit(async (tx) => {
					// A follow-up that landed since `await` settled: keep waiting instead of reporting.
					const newer = (await tx.doc(WorkersDoc, input.directorId)).workers[input.workerId]?.submissionId;
					if (newer !== undefined && newer !== submissionId && (await settledResult(tx, await tx.submission(newer as SubmissionId))) === undefined) {
						return { status: "running", checkpoint: { phase: "await", conversationId, submissionId: newer } };
					}
					const result = (await settledResult(tx, await tx.submission(submissionId as SubmissionId))) ?? {
						state: "failed" as const,
						answer: "",
						reason: "unsettled",
					};
					await director.submit(tx, {
						type: "input",
						content: reportText(input.name, result.state, result.answer, result.reason),
						requestId: `${input.requestId}:report`,
					});
					await finishRecord(tx, input, result, runtime.now());
					return { status: "terminal", outcome: { status: "completed", result } };
				}, context);
				changed(input);
			},
		},
		async abort(task, runtime, context) {
			const input = task.input;
			const result: WorkerResult = { state: "aborted", answer: "", reason: "stopped" };
			try {
				const director = await runtime.conversation(input.directorId, context);
				if (director) {
					await runtime.commit(async (tx) => {
						await director.submit(tx, {
							type: "input",
							content: reportText(input.name, result.state, result.answer, result.reason),
							requestId: `${input.requestId}:report`,
						});
						return undefined;
					}, context);
				}
			} catch (error) {
				runtime.report(error);
			}
			await runtime.commit(async (tx) => {
				await finishRecord(tx, input, result, runtime.now());
				return { status: "terminal", outcome: { status: "aborted", reason: "stopped", result } };
			}, context);
			changed(input);
		},
	});
}

async function finishRecord(tx: Tx, input: WorkerInput, result: WorkerResult, now: number): Promise<void> {
	const w = (await tx.doc(WorkersDoc, input.directorId)).workers[input.workerId];
	if (!w) return;
	w.state = result.state;
	w.finishedAt = now;
	if (result.answer) w.answer = result.answer;
	if (result.reason !== undefined) w.reason = result.reason;
}
