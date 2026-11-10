import { randomBytes } from "node:crypto";
import type { ConversationId, SubmissionId, TaskId, Tx } from "@earendil-works/pi-durable";
import type {
	CreateScheduleRequest,
	Schedule,
	ScheduleRun,
	ScheduleRunStatus,
	UpdateScheduleRequest,
} from "../../../api/types.js";
import { parseDuration } from "../../../config/load.js";
import { APPROVAL_MODES, type ConfigError, parseModelRef } from "../../../config/schema.js";
import { type ScheduleRecord, SchedulesDoc } from "../../../docs.js";
import { type Host, HostError, type ScheduleService, type SessionIndex } from "../../../host.js";
import { cronError, hostZone, isValidZone, nextCronFire, parseAt } from "./cron.js";
import { createScheduleTask, plain, type ScheduleTask } from "./task.js";

/** What the schedule service reads from the node, at call time. */
export type ScheduleHost = Pick<
	Host,
	"harness" | "ctx" | "config" | "events" | "notify" | "systemConversationId"
> & { sessions: Pick<SessionIndex, "resolveCwd"> };

type Fields = Omit<ScheduleRecord, "id" | "createdAt" | "updatedAt" | "taskId" | "runs">;

/** Validate a create request merged over `base`; returns the stored fields or the problems found. */
export function validateSchedule(
	request: UpdateScheduleRequest,
	base: Partial<Fields>,
	options: { fromAgent?: boolean; defaultTz: string },
): { fields?: Fields; errors: ConfigError[] } {
	const errors: ConfigError[] = [];
	const merged = { ...base, ...request };
	if (request.cron !== undefined && request.at === undefined) delete merged.at;
	if (request.at !== undefined && request.cron === undefined) delete merged.cron;
	const tz = merged.tz ?? options.defaultTz;
	if (typeof merged.name !== "string" || merged.name.trim() === "") errors.push({ path: "name", message: "required" });
	if (typeof merged.prompt !== "string" || merged.prompt.trim() === "") errors.push({ path: "prompt", message: "required" });
	if (typeof merged.cwd !== "string" || merged.cwd === "") errors.push({ path: "cwd", message: "required" });
	if (!isValidZone(tz)) errors.push({ path: "tz", message: `unknown time zone ${tz}` });
	if ((merged.cron === undefined) === (merged.at === undefined)) {
		errors.push({ path: "cron", message: "set exactly one of cron and at" });
	} else if (merged.cron !== undefined) {
		const error = cronError(merged.cron);
		if (error) errors.push({ path: "cron", message: error });
	} else if (merged.at !== undefined && isValidZone(tz) && parseAt(merged.at, tz) === undefined) {
		errors.push({ path: "at", message: "must be an ISO 8601 time" });
	}
	if (merged.model !== undefined && parseModelRef(merged.model) === undefined) {
		errors.push({ path: "model", message: "must be provider/modelId" });
	}
	if (merged.approval_mode !== undefined && !APPROVAL_MODES.includes(merged.approval_mode)) {
		errors.push({ path: "approval_mode", message: "must be ask or auto" });
	}
	if (options.fromAgent && merged.approval_mode === "auto") {
		errors.push({ path: "approval_mode", message: "an agent cannot create auto-approved schedules" });
	}
	if (merged.misfire_grace !== undefined && parseDuration(merged.misfire_grace) === undefined) {
		errors.push({ path: "misfire_grace", message: "must be a duration such as 2h" });
	}
	if (errors.length > 0) return { errors };
	const fields: Fields = {
		name: (merged.name as string).trim(),
		tz,
		cwd: merged.cwd as string,
		prompt: merged.prompt as string,
		enabled: merged.enabled ?? true,
	};
	if (merged.cron !== undefined) fields.cron = merged.cron;
	if (merged.at !== undefined) fields.at = merged.at;
	if (merged.model !== undefined) fields.model = merged.model;
	if (merged.approval_mode !== undefined) fields.approval_mode = merged.approval_mode;
	if (merged.misfire_grace !== undefined) fields.misfire_grace = merged.misfire_grace;
	return { fields, errors };
}

/** Next fire time shown by the API: absent when disabled or a one-shot that already ran. */
export function displayNextFire(record: Readonly<ScheduleRecord>, now: number): number | undefined {
	if (!record.enabled) return undefined;
	if (record.cron !== undefined) return nextCronFire(record.cron, record.tz, now);
	if (record.at !== undefined && record.runs.length === 0) return parseAt(record.at, record.tz);
	return undefined;
}

/** The API view of a stored schedule. */
export function toSchedule(record: Readonly<ScheduleRecord>, now: number): Schedule {
	const { taskId: _taskId, runs, ...definition } = plain(record) as ScheduleRecord;
	const next = displayNextFire(record, now);
	return { ...definition, runs, ...(next !== undefined ? { nextFireAt: next } : {}) };
}

/** `ScheduleService`: `tobor.schedules` on the system conversation plus one `tobor.schedule` task per enabled entry. */
export class Schedules implements ScheduleService {
	/** The task definition to register in the `tobor` extension. */
	readonly task: ScheduleTask;
	private readonly watching = new Set<number>();

	constructor(private readonly host: () => ScheduleHost) {
		this.task = createScheduleTask({ config: () => host().config, onRun: (def, run) => this.onRun(def, run) });
	}

	async list(): Promise<Schedule[]> {
		const now = Date.now();
		return Object.values(await this.all())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((r) => toSchedule(r, now));
	}

	async get(id: string): Promise<Schedule | undefined> {
		const record = (await this.all())[id];
		return record ? toSchedule(record, Date.now()) : undefined;
	}

	async create(request: CreateScheduleRequest, options: { fromAgent?: boolean } = {}): Promise<{ id: string }> {
		const h = this.host();
		const fields = this.validate(request, {}, options.fromAgent);
		fields.cwd = await h.sessions.resolveCwd(fields.cwd);
		const id = `s${randomBytes(4).toString("hex")}`;
		const now = Date.now();
		await h.harness.commit(async (tx) => {
			const doc = await tx.doc(SchedulesDoc, this.systemId());
			const record: ScheduleRecord = { id, ...fields, createdAt: now, updatedAt: now, runs: [] };
			if (fields.enabled) record.taskId = await this.createTask(tx, id, now);
			doc.schedules[id] = record;
		}, h.ctx);
		return { id };
	}

	async update(id: string, request: UpdateScheduleRequest): Promise<Schedule> {
		const h = this.host();
		const existing = (await this.all())[id];
		if (!existing) throw new HostError(404, "not_found", `no schedule ${id}`);
		const fields = this.validate(request, existing, false);
		if (request.cwd !== undefined) fields.cwd = await h.sessions.resolveCwd(fields.cwd);
		const retime =
			fields.cron !== existing.cron ||
			fields.at !== existing.at ||
			fields.tz !== existing.tz ||
			fields.enabled !== existing.enabled;
		const now = Date.now();
		const oldTask = existing.taskId;
		const updated = await h.harness.commit(async (tx) => {
			const doc = await tx.doc(SchedulesDoc, this.systemId());
			const record = doc.schedules[id];
			if (!record) throw new HostError(404, "not_found", `no schedule ${id}`);
			const next: ScheduleRecord = { id, ...fields, createdAt: record.createdAt, updatedAt: now, runs: record.runs };
			if (retime) {
				if (fields.enabled) next.taskId = await this.createTask(tx, id, now);
			} else if (record.taskId !== undefined) {
				next.taskId = record.taskId;
			}
			doc.schedules[id] = next;
			return plain(next);
		}, h.ctx);
		if (retime && oldTask !== undefined) await h.harness.abortTask(oldTask as TaskId, h.ctx);
		return toSchedule(updated, now);
	}

	async delete(id: string): Promise<void> {
		const h = this.host();
		const taskId = await h.harness.commit(async (tx) => {
			const doc = await tx.doc(SchedulesDoc, this.systemId());
			const record = doc.schedules[id];
			if (!record) throw new HostError(404, "not_found", `no schedule ${id}`);
			delete doc.schedules[id];
			return record.taskId;
		}, h.ctx);
		if (taskId !== undefined) await h.harness.abortTask(taskId as TaskId, h.ctx);
	}

	async reconcile(): Promise<void> {
		const h = this.host();
		const inspection = await h.harness.inspect(h.ctx);
		const live = new Set(
			inspection.tasks.filter((t) => t.record.kind === this.task.definition.name).map((t) => t.record.id as number),
		);
		const now = Date.now();
		const wanted = await h.harness.commit(async (tx) => {
			const doc = await tx.doc(SchedulesDoc, this.systemId());
			const keep = new Set<number>();
			for (const record of Object.values(doc.schedules)) {
				if (!record.enabled) {
					delete record.taskId;
					continue;
				}
				if (record.taskId === undefined || !live.has(record.taskId)) {
					record.taskId = await this.createTask(tx, record.id, now);
				}
				keep.add(record.taskId);
			}
			return keep;
		}, h.ctx);
		for (const id of live) if (!wanted.has(id)) await h.harness.abortTask(id as TaskId, h.ctx);
		for (const record of Object.values(await this.all())) {
			for (const run of record.runs) if (run.status === "running") this.watchRun(record.id, run);
		}
	}

	private validate(request: UpdateScheduleRequest, base: Partial<Fields>, fromAgent: boolean | undefined): Fields {
		const { fields, errors } = validateSchedule(request, base, { fromAgent, defaultTz: hostZone() });
		if (!fields) throw new HostError(422, "invalid", errors.map((e) => `${e.path}: ${e.message}`).join("; "), errors);
		return fields;
	}

	private systemId(): ConversationId {
		return this.host().systemConversationId as ConversationId;
	}

	private async createTask(tx: Tx, id: string, after: number): Promise<number> {
		return (await tx.createTask(
			this.task,
			{ scheduleId: id, after },
			{ ownership: { kind: "conversation" }, conversationId: this.systemId(), background: true },
		)) as number;
	}

	private async all(): Promise<Readonly<Record<string, Readonly<ScheduleRecord>>>> {
		const h = this.host();
		return (await h.harness.snapshot(SchedulesDoc, this.systemId(), h.ctx))?.schedules ?? {};
	}

	private onRun(def: Readonly<ScheduleRecord>, run: ScheduleRun): void {
		const h = this.host();
		h.events.emit({ type: "schedule.fired", scheduleId: def.id, name: def.name, run });
		if (run.conversationId !== undefined) h.events.emit({ type: "session.updated", id: run.conversationId });
		if (run.status === "running") this.watchRun(def.id, run);
		if (run.status === "skipped_misfire" && h.notify.enabled("error")) {
			void h.notify.send({ event: "error", title: `schedule ${def.name}: skipped`, message: run.notice ?? "missed" });
		}
	}

	/** Wait for a run's submission in memory, then record its status and notify (re-armed by `reconcile` at boot). */
	private watchRun(scheduleId: string, run: ScheduleRun): void {
		const submissionId = run.submissionId;
		if (submissionId === undefined || this.watching.has(submissionId)) return;
		this.watching.add(submissionId);
		void (async () => {
			const h = this.host();
			try {
				const submission = await h.harness.submission(submissionId as SubmissionId, h.ctx);
				const settled = submission ? await submission.wait(h.ctx) : undefined;
				const status: ScheduleRunStatus = settled?.status === "done" ? "done" : "failed";
				const notice = settled?.status === "unanswered" ? settled.reason : settled ? undefined : "submission missing";
				const updated = await h.harness.commit(async (tx) => {
					const record = (await tx.doc(SchedulesDoc, this.systemId())).schedules[scheduleId];
					const stored = record?.runs.find((r) => r.submissionId === submissionId);
					if (!record || !stored) return undefined;
					stored.status = status;
					if (notice !== undefined) stored.notice = notice;
					return { name: record.name, run: plain(stored) };
				}, h.ctx);
				if (!updated) return;
				h.events.emit({ type: "schedule.fired", scheduleId, name: updated.name, run: updated.run });
				const event = status === "done" ? "settled" : "error";
				if (h.notify.enabled(event)) {
					await h.notify.send({
						event,
						title: `schedule ${updated.name}: ${status}`,
						message: notice ?? `run of ${new Date(run.fireAt).toISOString()} finished`,
						...(run.conversationId !== undefined ? { sessionId: run.conversationId } : {}),
					});
				}
			} catch (error) {
				if (!h.ctx.abortSignal?.aborted) console.error(`schedule ${scheduleId}: run watch failed:`, error);
			} finally {
				this.watching.delete(submissionId);
			}
		})();
	}
}
