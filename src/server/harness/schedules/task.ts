import {
	configure,
	type ConversationId,
	defineTask,
	type SubmissionId,
	type Task,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ScheduleRun } from "../../../api/types.js";
import { type Config, parseModelRef } from "../../../config/schema.js";
import { type ScheduleRecord, SchedulesDoc, SessionDoc, SessionsDoc } from "../../../docs.js";
import { fireDecision, graceMs, nextFireAt } from "./cron.js";

/** Runs kept per schedule. */
export const MAX_RUNS = 50;

/** Input of one `tobor.schedule` task. */
export type ScheduleTaskInput = { scheduleId: string; /** Epoch ms the first fire is computed after. */ after: number };

type ScheduleState =
	| { phase: "wait"; after: number }
	| { phase: "create"; fireAt: number }
	| { phase: "submit"; fireAt: number; conversationId: number }
	| { phase: "next"; fireAt: number };

/** What the schedule task reads from the node and reports to it (not durable). */
export type ScheduleTaskDeps = {
	config(): Config;
	/** A run was recorded (fired or skipped). */
	onRun(schedule: Readonly<ScheduleRecord>, run: ScheduleRun): void;
};

/** The `tobor.schedule` task type. */
export type ScheduleTask = Task<ScheduleTaskInput, ScheduleState, null, object>;

/** A plain JSON copy of a doc value or draft (drafts are proxies `structuredClone` rejects). */
export function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Append `run`, keeping the newest `MAX_RUNS`. */
export function pushRun(runs: ScheduleRun[], run: ScheduleRun): void {
	runs.push(run);
	if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
}

/** Text of a run's first input. */
export function runPrompt(fireAt: number, prompt: string): string {
	return `[scheduled run, fired ${new Date(fireAt).toISOString()}]\n${prompt}`;
}

/** Idempotency key of a run's first submission. */
export function runRequestId(scheduleId: string, fireAt: number): string {
	return `${scheduleId}:${fireAt}`;
}

/** Whether the latest run's submission has not settled. */
async function previousUnsettled(tx: Tx, runs: readonly ScheduleRun[]): Promise<boolean> {
	const last = runs.at(-1);
	if (last?.submissionId === undefined || last.status !== "running") return false;
	const record = await tx.submission(last.submissionId as SubmissionId);
	return record !== undefined && (record.status === "queued" || record.status === "placed");
}

/** `tobor.schedule`: background, system-conversation-owned loop that fires one schedule. */
export function createScheduleTask(deps: ScheduleTaskDeps): ScheduleTask {
	const current = async (tx: Tx, systemId: ConversationId, scheduleId: string, taskId: number) => {
		const def = (await tx.doc(SchedulesDoc, systemId)).schedules[scheduleId];
		return def && def.enabled && def.taskId === taskId ? def : undefined;
	};
	const done = { status: "terminal", outcome: { status: "completed", result: null } } as const;

	return defineTask<ScheduleTaskInput, ScheduleState, null>({
		name: "tobor.schedule",
		version: 1,
		initial: (input) => ({ phase: "wait", after: input.after }),
		phases: {
			async wait(task, runtime, context) {
				const { after } = task.state.checkpoint;
				const doc = await runtime.snapshot(SchedulesDoc, runtime.conversationId, context);
				const def = doc?.schedules[task.input.scheduleId];
				const fireAt = def && def.enabled && def.taskId === runtime.taskId ? nextFireAt(def, after) : undefined;
				if (fireAt === undefined) {
					await runtime.commit(() => done, context);
					return;
				}
				await runtime.sleepUntil(fireAt, { phase: "create", fireAt }, context);
			},
			async create(task, runtime, context) {
				const { fireAt } = task.state.checkpoint;
				const { scheduleId } = task.input;
				let skipped: { def: ScheduleRecord; run: ScheduleRun } | undefined;
				await runtime.commit(async (tx) => {
					const def = await current(tx, runtime.conversationId, scheduleId, runtime.taskId);
					if (!def) return done;
					const now = runtime.now();
					const decision = fireDecision({
						now,
						fireAt,
						graceMs: graceMs(def.misfire_grace),
						previousUnsettled: await previousUnsettled(tx, def.runs),
					});
					if (decision !== "fire") {
						const notice =
							decision === "skipped_misfire"
								? `missed by ${Math.round((now - fireAt) / 60_000)} min (grace ${def.misfire_grace ?? "2h"})`
								: "previous run still running";
						const run: ScheduleRun = { fireAt, status: decision, notice };
						pushRun(def.runs, run);
						skipped = { def: plain(def), run };
						if (def.at !== undefined) return done;
						return { status: "running", checkpoint: { phase: "wait", after: Math.max(now, fireAt) } };
					}
					const config = deps.config();
					const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
					const model = parseModelRef(def.model ?? config.defaults.model);
					await configure(tx, record.id, {
						cwd: def.cwd,
						thinkingLevel: config.defaults.thinking,
						maxTurns: config.defaults.max_turns,
						...(model ? { model } : {}),
					});
					const title = `${def.name} · ${new Date(fireAt).toISOString()}`;
					const session = await tx.doc(SessionDoc, record.id);
					session.title = title;
					session.approval_mode = def.approval_mode ?? "ask";
					session.mode = "solo";
					session.cwd = def.cwd;
					session.createdAt = now;
					(await tx.doc(SessionsDoc, runtime.conversationId)).sessions[String(record.id)] = {
						id: record.id,
						title,
						cwd: def.cwd,
						kind: "schedule",
						scheduleId,
						createdAt: now,
						archived: false,
					};
					return { status: "running", checkpoint: { phase: "submit", fireAt, conversationId: record.id } };
				}, context);
				if (skipped) deps.onRun(skipped.def, skipped.run);
			},
			async submit(task, runtime, context) {
				const { fireAt, conversationId } = task.state.checkpoint;
				const { scheduleId } = task.input;
				const handle = await runtime.conversation(conversationId as ConversationId, context);
				if (!handle) throw new Error(`schedule run conversation ${conversationId} missing`);
				let fired: { def: ScheduleRecord; run: ScheduleRun } | undefined;
				await runtime.commit(async (tx) => {
					const def = (await tx.doc(SchedulesDoc, runtime.conversationId)).schedules[scheduleId];
					if (!def) return done;
					const submissionId = await handle.submit(tx, {
						type: "input",
						content: runPrompt(fireAt, def.prompt),
						requestId: runRequestId(scheduleId, fireAt),
					});
					const run: ScheduleRun = { fireAt, conversationId, submissionId, status: "running" };
					pushRun(def.runs, run);
					fired = { def: plain(def), run };
					return { status: "running", checkpoint: { phase: "next", fireAt } };
				}, context);
				if (fired) deps.onRun(fired.def, fired.run);
			},
			async next(task, runtime, context) {
				const { fireAt } = task.state.checkpoint;
				await runtime.commit(async (tx) => {
					const def = await current(tx, runtime.conversationId, task.input.scheduleId, runtime.taskId);
					if (!def || def.at !== undefined) return done;
					return { status: "running", checkpoint: { phase: "wait", after: fireAt } };
				}, context);
			},
		},
		async abort(_task, runtime, context) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}
