// tobor's pi-durable documents (design: "Storage"). All are conversation-scoped and latest-only.
// `tobor.sessions` and `tobor.schedules` live on the system conversation (id in `$TOBOR_HOME/node.json`); the rest on
// each session/worker conversation. Shapes are plain JSON; absent optional values are omitted, never `undefined`.
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	ApprovalDecision,
	ApprovalMode,
	ScheduleRun,
	SessionKind,
	SessionMode,
	WorkerState,
} from "./api/types.js";
import { defineDoc } from "./tools/registry.js";

// ─── tobor.sessions (system conversation) ───────────────────────────────────────────────────────────────────────────

/** One session in the index; written in the create commit and on archive/delete. */
export type SessionIndexEntry = {
	id: number;
	title: string;
	cwd: string;
	kind: SessionKind;
	/** Set when `kind` is `schedule`. */
	scheduleId?: string;
	createdAt: number;
	archived: boolean;
};

/** Index of every top-level session, keyed by conversation id (decimal string). Workers are not listed. */
export type SessionsDocValue = { sessions: Record<string, SessionIndexEntry> };

export const SessionsDoc = defineDoc<SessionsDocValue>({
	kind: "tobor.sessions",
	initial: () => ({ sessions: {} }),
});

// ─── tobor.session (per conversation) ───────────────────────────────────────────────────────────────────────────────

/** Worker identity, present on a worker conversation's `tobor.session`. */
export type WorkerIdentity = {
	/** Worker id within the parent session's `tobor.workers`. */
	id: string;
	name: string;
	agent: string;
	/** Director conversation that spawned it. */
	parentId: number;
};

/** Per-conversation tobor settings; model/thinking/cwd/maxTurns live in pi-durable's agent state (`configure`). */
export type SessionDocValue = {
	title: string;
	approval_mode: ApprovalMode;
	mode: SessionMode;
	/** Absolute cwd, mirrored from `configure` for display. */
	cwd: string;
	createdAt: number;
	/** Present on worker conversations. */
	worker?: WorkerIdentity;
};

export const SessionDoc = defineDoc<SessionDocValue>({
	kind: "tobor.session",
	initial: () => ({ title: "", approval_mode: "ask", mode: "director", cwd: "", createdAt: 0 }),
});

// ─── tobor.approvals (per conversation, fork: initial) ──────────────────────────────────────────────────────────────

/** A gated call awaiting the operator, committed by the hook before it waits. */
export type ApprovalPendingRecord = {
	callId: string;
	tool: string;
	args: JsonValue;
	createdAt: number;
	/** `createdAt + approval_timeout`; the hook denies with reason `timeout` after it. */
	expiresAt: number;
	/** Worker name when the conversation is a worker. */
	worker?: string;
};

/** A decision; replaces the pending record for the same call id. The first decision wins. */
export type ApprovalDecisionRecord = {
	callId: string;
	tool: string;
	decision: ApprovalDecision;
	/** `operator` (API), `timeout` (hook), or `cancelled` (abort while waiting). */
	reason: "operator" | "timeout" | "cancelled";
	decidedAt: number;
};

/** Approval state of one conversation. A fork starts empty (no inherited grants). */
export type ApprovalsDocValue = {
	pending: Record<string, ApprovalPendingRecord>;
	decisions: Record<string, ApprovalDecisionRecord>;
	/** Tools granted for the rest of the session by `approve_session`. */
	session: Record<string, true>;
};

export const ApprovalsDoc = defineDoc<ApprovalsDocValue>({
	kind: "tobor.approvals",
	fork: "initial",
	initial: () => ({ pending: {}, decisions: {}, session: {} }),
});

// ─── tobor.todo (per conversation) ──────────────────────────────────────────────────────────────────────────────────

/** Todo item status. */
export type TodoStatus = "pending" | "doing" | "done";

/** One todo item, owned by the `todo` tool. */
export type TodoItem = { id: string; text: string; status: TodoStatus };

/** The conversation's todo list, rendered in the Session view. */
export type TodoDocValue = { items: TodoItem[] };

export const TodoDoc = defineDoc<TodoDocValue>({
	kind: "tobor.todo",
	initial: () => ({ items: [] }),
});

// ─── tobor.workers (per director conversation) ──────────────────────────────────────────────────────────────────────

/** One worker spawned by the `task` tool. */
export type WorkerRecord = {
	/** Unique within the director session. */
	id: string;
	name: string;
	agent: string;
	/** Background `tobor.worker` holder task; `harness.abortTask(holderTaskId)` stops the worker. */
	holderTaskId: number;
	/** Child conversation, once the holder has created it. */
	conversationId?: number;
	/** Deterministic request id of the brief submission (`<callId>:<i>`). */
	requestId: string;
	/** Brief submission id, once submitted. */
	submissionId?: number;
	state: WorkerState;
	createdAt: number;
	finishedAt?: number;
	/** Final assistant text, once done. */
	answer?: string;
	/** Failure or abort reason. */
	reason?: string;
};

/** Workers of one director conversation, keyed by worker id. */
export type WorkersDocValue = { workers: Record<string, WorkerRecord> };

export const WorkersDoc = defineDoc<WorkersDocValue>({
	kind: "tobor.workers",
	initial: () => ({ workers: {} }),
});

// ─── tobor.schedules (system conversation) ──────────────────────────────────────────────────────────────────────────

/** A stored schedule: the API definition plus its task and run list (capped at 50, newest last). */
export type ScheduleRecord = {
	id: string;
	name: string;
	cron?: string;
	/** ISO 8601 one-shot time. */
	at?: string;
	tz: string;
	cwd: string;
	prompt: string;
	model?: string;
	approval_mode?: ApprovalMode;
	/** Duration text, default `2h`. */
	misfire_grace?: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	/** The live `tobor.schedule` task, while enabled. */
	taskId?: number;
	runs: ScheduleRun[];
};

/** Every schedule, keyed by id. */
export type SchedulesDocValue = { schedules: Record<string, ScheduleRecord> };

export const SchedulesDoc = defineDoc<SchedulesDocValue>({
	kind: "tobor.schedules",
	initial: () => ({ schedules: {} }),
});

/** Every tobor doc token, for `ToolModule.docs` and inspection. */
export const TOBOR_DOCS = [SessionsDoc, SessionDoc, ApprovalsDoc, TodoDoc, WorkersDoc, SchedulesDoc] as const;
