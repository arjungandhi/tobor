// The node's service graph. The HTTP layer, WS handlers and tools code against these interfaces; boot builds one
// `Host` after `Harness.open` and passes it down. Services own their docs and emit `NodeEvent`s on `events`.
import type { Context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { ConversationWatch, Harness, Registry } from "@earendil-works/pi-durable";
import type {
	AgentDefinition,
	ApprovalDecision,
	ApprovalOutcome,
	ArtifactRevision,
	ArtifactSummary,
	AuthStatusResponse,
	CreateScheduleRequest,
	CwdsResponse,
	EntriesQuery,
	EntriesResponse,
	InputMode,
	ListSessionsResponse,
	LoginCodeResponse,
	LoginStartResponse,
	McpServerStatus,
	ModelsResponse,
	PatchSessionRequest,
	PendingApproval,
	PendingQuestion,
	PutToborFileRequest,
	Schedule,
	SessionDetail,
	SessionId,
	SessionKind,
	SubmissionId,
	ToborFileResponse,
	ToborFileWriteResponse,
	UpdateScheduleRequest,
	WatchWindow,
	WhoamiResponse,
	WorkerSummary,
} from "./api/types.js";
import type { HomePaths } from "./config/home.js";
import type { ApprovalMode, Config, ConfigError, NotifyEvent, SessionMode, ThinkingLevel } from "./config/schema.js";
import type { EventBus } from "./events.js";

export type { EventBus };

/** Error a service throws for a client-caused failure; the HTTP layer maps `status` and `code` to an `ApiError`. */
export class HostError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409 | 422 | 503,
		readonly code: string,
		message: string,
		readonly errors?: ConfigError[],
	) {
		super(message);
		this.name = "HostError";
	}
}

/** Everything a running node holds. */
export interface Host {
	/** Absolute `$TOBOR_HOME`. */
	readonly home: string;
	/** Every fixed path under `home`. */
	readonly paths: HomePaths;
	/** Current node config; replaced on reload, so read it at each use instead of caching fields. */
	config: Config;
	/** The one pi-durable Harness over `.tobor/state/tobor.sqlite`. */
	readonly harness: Harness;
	/** pi-ai models with tobor's file-backed CredentialStore. */
	readonly models: MutableModels;
	/** The registry holding the `tobor` extension (MCP reloads reinstall it). */
	readonly registry: Registry;
	/** Node lifetime context; cancelled on shutdown. */
	readonly ctx: Context;
	/** Ownerless system conversation (`tobor.sessions`, `tobor.schedules`). */
	readonly systemConversationId: number;
	readonly sessions: SessionIndex;
	readonly approvals: ApprovalService;
	readonly questions: QuestionService;
	readonly workers: WorkerService;
	readonly schedules: ScheduleService;
	readonly artifacts: ArtifactService;
	readonly mcp: McpService;
	readonly auth: AuthService;
	readonly agentData: AgentDataService;
	readonly events: EventBus;
	readonly notify: Notifier;
	/** `GET /api/whoami` payload. */
	whoami(): WhoamiResponse;
}

/** Options for creating a session (API, schedules). Omitted fields take node defaults plus the project overlay. */
export type CreateSessionOptions = {
	/** Must realpath inside a configured root; stored absolute. */
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	mode?: SessionMode;
	/** First input; seeds the title (first 60 characters). Absent or blank: the session is created idle with no turns. */
	prompt?: string;
	/** Default `session`. */
	kind?: SessionKind;
	/** With `kind: "schedule"`. */
	scheduleId?: string;
	/** Idempotency key of the first submission (schedules pass `<scheduleId>:<fireAt>`). */
	requestId?: string;
};

/** Sessions: ownerless conversations indexed in `tobor.sessions`, with settings in `tobor.session`. */
export interface SessionIndex {
	/** Index rows joined with live state, newest first; archived only with `archived: true`. */
	list(options?: { archived?: boolean }): Promise<ListSessionsResponse>;
	/**
	 * Create, configure and submit in order; returns once the first input is admitted. Throws 403 outside roots.
	 * Without a (non-blank) `prompt` nothing is submitted: the session is idle with no turns and there is no `submissionId`.
	 */
	create(options: CreateSessionOptions & { prompt: string }): Promise<{ id: SessionId; submissionId: SubmissionId }>;
	create(options: CreateSessionOptions): Promise<{ id: SessionId; submissionId?: SubmissionId }>;
	/** One session, or undefined if unknown (workers resolve too, for their transcripts). */
	get(id: SessionId): Promise<SessionDetail | undefined>;
	/** Apply a patch: `title`/`approval_mode`/`mode` to `tobor.session`, `model`/`thinking` via `configure`. */
	patch(id: SessionId, patch: PatchSessionRequest): Promise<SessionDetail>;
	/** Set or clear `archived` in the index. */
	archive(id: SessionId, archived?: boolean): Promise<void>;
	/** Abort (including background workers) and remove from the index. */
	delete(id: SessionId): Promise<void>;
	/** Submit input: `prompt`/`follow_up` queue while busy, `steer` uses `whenBusy: "steer"`. Idempotent per `requestId`. */
	input(id: SessionId, input: { content: string; mode: InputMode; requestId: string }): Promise<{ submissionId: SubmissionId }>;
	/** Abort the current run and its foreground tasks. */
	abort(id: SessionId): Promise<void>;
	/** Start a conversation watch for one socket; the caller sends `value`, then forwards ops, and stops it on close. */
	watch(id: SessionId, window: WatchWindow | undefined, ctx: Context): Promise<ConversationWatch>;
	/** One page of stored entries (`EntryQuery`). */
	entries(id: SessionId, query: EntriesQuery): Promise<EntriesResponse>;
	/** Roots plus recently used cwds. */
	cwds(): Promise<CwdsResponse>;
	/** Resolve a cwd: realpath, then require it to sit inside a root. Throws 403 `outside_roots`. */
	resolveCwd(cwd: string): Promise<string>;
}

/** Result of the approval gate for one tool call. */
export type GateResult =
	| { proceed: true }
	| { proceed: false; block: string; outcome: Exclude<ApprovalOutcome, "approve" | "approve_session"> };

/** Approvals: pending records in each conversation's `tobor.approvals`, waited on with `harness.watchDoc`. */
export interface ApprovalService {
	/** Every pending record across conversations, oldest first (survives restarts). */
	pending(): Promise<PendingApproval[]>;
	/** Pending records of one session and its workers. */
	pendingFor(sessionId: SessionId): Promise<PendingApproval[]>;
	/** Find a pending record by call id (the API path carries only `callId`). */
	find(callId: string): Promise<PendingApproval | undefined>;
	/** Commit a decision; `approve_session` also grants the tool. Throws 404 if unknown, 409 if already decided. */
	decide(conversationId: SessionId, callId: string, decision: ApprovalDecision): Promise<void>;
	/**
	 * The `beforeTool` gate: check stored decisions and session grants, else commit a pending record, emit
	 * `approval.requested`, notify, and wait for a decision, the timeout, or `ctx` cancellation.
	 */
	gate(
		conversationId: SessionId,
		call: { callId: string; tool: string; args: unknown },
		ctx: Context,
	): Promise<GateResult>;
}

/** How an `ask_user` wait ended. */
export type AskResult = { kind: "answered"; text: string } | { kind: "timeout" } | { kind: "cancelled" };

/** Questions: records in each conversation's `tobor.questions`, waited on with `harness.watchDoc`. */
export interface QuestionService {
	/** Every pending question across conversations, oldest first (survives restarts). */
	pending(): Promise<PendingQuestion[]>;
	/** Pending questions of one session and its workers. */
	pendingFor(sessionId: SessionId): Promise<PendingQuestion[]>;
	/** Find a pending question by call id (the API path carries only `callId`). */
	find(callId: string): Promise<PendingQuestion | undefined>;
	/** Commit the operator's answer. Throws 404 if unknown, 409 if already answered. */
	answer(conversationId: SessionId, callId: string, text: string): Promise<void>;
	/**
	 * The `ask_user` tool body: commit a pending record, emit `question.asked`, notify, and wait for an answer, the
	 * timeout, or `ctx` cancellation. Idempotent per `callId`.
	 */
	ask(
		conversationId: SessionId,
		call: { callId: string; question: string; options?: string[] },
		ctx: Context,
	): Promise<AskResult>;
}

/** Director-mode workers: background `tobor.worker` holder tasks recorded in the director's `tobor.workers`. */
export interface WorkerService {
	/** Workers of one director session, oldest first. */
	list(sessionId: SessionId): Promise<WorkerSummary[]>;
	/** One worker, or undefined. */
	get(sessionId: SessionId, workerId: string): Promise<WorkerSummary | undefined>;
	/** Stop one worker (`harness.abortTask(holderTaskId)`). */
	stop(sessionId: SessionId, workerId: string): Promise<void>;
	/** Stop every unsettled worker of a session. */
	stopAll(sessionId: SessionId): Promise<void>;
	/** Count of unsettled workers (for `max_workers`). */
	live(sessionId: SessionId): Promise<number>;
}

/** Schedules: definitions in `tobor.schedules`, one background `tobor.schedule` task per enabled schedule. */
export interface ScheduleService {
	/** Every schedule with runs and next fire time. */
	list(): Promise<Schedule[]>;
	get(id: string): Promise<Schedule | undefined>;
	/** Validate, write the doc and create the task in one commit. `fromAgent` forbids `approval_mode: auto`. */
	create(request: CreateScheduleRequest, options?: { fromAgent?: boolean }): Promise<{ id: string }>;
	/** Update fields; recreates the task when timing or `enabled` changes. */
	update(id: string, request: UpdateScheduleRequest): Promise<Schedule>;
	/** Delete the definition and abort its task in one commit. */
	delete(id: string): Promise<void>;
	/** Boot: create missing tasks for enabled definitions, abort orphans, re-wait unsettled run submissions. */
	reconcile(): Promise<void>;
}

/** Outcome of a PDF request for one revision. */
export type PdfResult =
	| { status: "ready"; path: string }
	| { status: "rendering"; retryAfterSeconds: number }
	| { status: "unavailable"; reason: string };

/** Artifacts: revision store under `$TOBOR_HOME/artifacts`, served by the artifacts listener. */
export interface ArtifactService {
	/** Latest revision per artifact, newest first, optionally for one project. */
	list(projectId?: string): Promise<ArtifactSummary[]>;
	/** All revisions of one artifact, newest first. */
	revisions(projectId: string, slug: string): Promise<ArtifactRevision[]>;
	/** One revision by global id. */
	revision(rev: string): Promise<ArtifactRevision | undefined>;
	/** Latest revision of one artifact. */
	latest(projectId: string, slug: string): Promise<ArtifactRevision | undefined>;
	/** Absolute directory of a stored revision (the viewer serves files inside it only). */
	revisionDir(rev: string): Promise<string | undefined>;
	/** Cached PDF for a revision, starting a render if needed. */
	pdf(rev: string): Promise<PdfResult>;
	/** Chrome probe result recorded at boot. */
	chrome(): { found: boolean; version?: string; path?: string };
}

/** MCP: clients for `mcp.json` servers, tools registered as `mcp__<server>__<tool>`. */
export interface McpService {
	/** Status of every configured server. */
	status(): McpServerStatus[];
	/** Re-read `mcp.json`, reconnect changed servers, reinstall tools. */
	reload(): Promise<void>;
	/** Whether a call to `toolName` needs approval in `ask` mode, per `config.mcp.approval` (default ask). */
	needsApproval(toolName: string): boolean;
	/** Close every client (shutdown). */
	close(): Promise<void>;
}

/** Credentials and the model catalog. Tokens never leave this service. */
export interface AuthService {
	/** Auth source per provider. */
	status(): Promise<AuthStatusResponse>;
	/** Catalog plus auth status and node defaults. */
	models(): Promise<ModelsResponse>;
	/** Start an OAuth login; resolves with the URL once the provider emits it. */
	loginStart(provider: string): Promise<LoginStartResponse>;
	/** Complete a started login with the code the provider shows. Throws 409 if no login is in progress. */
	loginCode(provider: string, code: string): Promise<LoginCodeResponse>;
}

/** The node-level `.tobor/` git repo and agent definitions. Paths are relative to `.tobor/`. */
export interface AgentDataService {
	/** Node agents, overlaid by project agents of `cwd`'s git root when given. */
	listAgents(cwd?: string): Promise<AgentDefinition[]>;
	/** One agent by name (project shadows node). */
	getAgent(name: string, cwd?: string): Promise<AgentDefinition | undefined>;
	/** A file or directory listing; undefined if absent. Rejects paths escaping `.tobor/`. */
	read(path: string): Promise<ToborFileResponse | undefined>;
	/** Validate, write and commit. Throws 422 with `errors` on validation failure, 409 on a stale `sha`. */
	write(path: string, request: PutToborFileRequest): Promise<ToborFileWriteResponse>;
	/** Delete and commit. */
	remove(path: string): Promise<ToborFileWriteResponse>;
	/** Recent commits, newest first, optionally only those touching `path`. */
	history(opts: { path?: string; limit?: number }): Promise<AgentDataCommit[]>;
	/** Unified diff of `commit` (default HEAD) against its parent, optionally limited to `path`. */
	diff(opts: { commit?: string; path?: string }): Promise<string>;
}

/** One commit of the `.tobor/` repo. */
export type AgentDataCommit = { sha: string; date: string; message: string };

/** A notification; payloads carry ids and titles only, never secrets or tool output. */
export type Notification = {
	event: NotifyEvent;
	title: string;
	message: string;
	sessionId?: SessionId;
	/** Click-through URL (public_url or an artifact URL). */
	url?: string;
	/** ntfy actions, e.g. approve/deny buttons. */
	actions?: { label: string; url: string; method?: "POST" | "GET"; body?: string }[];
};

/** Outbound notifications (ntfy). */
export interface Notifier {
	/** Whether `config.notify` would deliver this event at all. */
	enabled(event: NotifyEvent): boolean;
	/** Best effort: never throws; failures are logged. */
	send(notification: Notification): Promise<void>;
}
