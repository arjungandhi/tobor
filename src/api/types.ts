// Wire types for the node's HTTP+WS API (design: "API"). Shared by the server and every client.
// All types are JSON-serializable. Request bodies are `*Request`, response bodies `*Response` (or a named record).
// Mutating requests require `Content-Type: application/json`; errors use `ApiError` with an HTTP status.
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, ConversationWindow, EntryRecord } from "@earendil-works/pi-durable";
import type { ApprovalMode, ConfigError, SessionMode, ThinkingLevel } from "../config/schema.js";

export type { ApprovalMode, ConfigError, SessionMode, ThinkingLevel };

// ─── Common ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A session id: the pi-durable conversation id of an ownerless (or worker) conversation. */
export type SessionId = number;
/** A pi-durable entry id. */
export type EntryId = number;
/** A pi-durable submission id. */
export type SubmissionId = number;
/** Epoch milliseconds. */
export type Millis = number;

/** Error body for every non-2xx response. */
export type ApiError = {
	/** Human-readable message. */
	error: string;
	/** Machine code, e.g. `not_found`, `conflict`, `invalid`, `unsupported_media_type`. */
	code?: string;
	/** Validation problems (config, frontmatter, mcp.json). */
	errors?: ConfigError[];
};

/** Body of mutations that return nothing else. */
export type OkResponse = { ok: true };

/**
 * Session lifecycle as shown to clients: `waiting` means at least one approval or `ask_user` question is pending;
 * `working` means the director is idle (no run, no failure) while background workers are still live.
 */
export type SessionState = "idle" | "running" | "waiting" | "failed" | "working";

/** Token and cost totals summed over a conversation's `pi.usage`. */
export type UsageSummary = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Total cost in USD. */
	cost: number;
};

/** Why the newest run ended without an answer (`pi.live.runFailure`). */
export type SessionFailure = {
	/** pi-durable `RunFailureReason`: `model_error`, `aborted`, `turn_limit`, `restart_limit`, … */
	reason: string;
	detail?: string;
};

// ─── Whoami ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/whoami`. */
export type WhoamiResponse = {
	/** Host name of the node. */
	host: string;
	/** tobor version. */
	version: string;
	/** Build id: content hash of the binary's sources, `dev` when run from source. */
	build: string;
	/** Pinned pi-durable version. */
	pi_durable: string;
	/** Runtime of the node: `bun <Bun.version>`. */
	runtime: string;
	public_url: string;
	artifacts_url: string;
	/** ntfy topic, if notifications are configured. */
	ntfy_topic?: string;
	/** Chrome probe result (PDF export). */
	chrome: { found: boolean; version?: string };
	/** Node clock, for client skew display. */
	now: Millis;
};

// ─── Sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a session came to exist. */
export type SessionKind = "session" | "schedule";

/** One row of `GET /api/sessions` (from `tobor.sessions` plus live state). */
export type SessionSummary = {
	id: SessionId;
	title: string;
	/** Absolute working directory. */
	cwd: string;
	/** `provider/modelId`. */
	model: string;
	approval_mode: ApprovalMode;
	mode: SessionMode;
	kind: SessionKind;
	/** Schedule id when `kind` is `schedule`. */
	scheduleId?: string;
	state: SessionState;
	/** Present when `state` is `failed`. */
	failure?: SessionFailure;
	/** Number of pending approvals and questions (session plus its workers). */
	pending: number;
	usage: UsageSummary;
	archived: boolean;
	createdAt: Millis;
	updatedAt: Millis;
};

/** `GET /api/sessions` → `SessionSummary[]`, newest first. `?archived=1` includes archived sessions. */
export type ListSessionsResponse = SessionSummary[];

/** `GET /api/sessions/:id`. */
export type SessionDetail = SessionSummary & {
	thinking: ThinkingLevel;
	max_turns: number;
	/** Worker count for director sessions. */
	workers: number;
};

/** `POST /api/sessions`: create, configure and (when `prompt` is given) submit the first prompt. */
export type CreateSessionRequest = {
	/** Must realpath inside a configured root. */
	cwd: string;
	/** Default `config.defaults.model` (after the project overlay). */
	model?: string;
	thinking?: ThinkingLevel;
	approval_mode?: ApprovalMode;
	mode?: SessionMode;
	/** First prompt; also seeds the title. Omit for an idle session with no turns. */
	prompt?: string;
};

/** Response to `POST /api/sessions`. */
export type CreateSessionResponse = { id: SessionId };

/** `PATCH /api/sessions/:id`. Loosening `ask` → `auto` is confirmed client-side. */
export type PatchSessionRequest = {
	title?: string;
	model?: string;
	thinking?: ThinkingLevel;
	approval_mode?: ApprovalMode;
	mode?: SessionMode;
	archived?: boolean;
};

/** Response to `PATCH /api/sessions/:id`. */
export type PatchSessionResponse = SessionDetail;

/** `DELETE /api/sessions/:id` → `OkResponse` (aborts, then drops it from the index). */
export type DeleteSessionResponse = OkResponse;

/** How input reaches a session: a new prompt (idle), a steer, or a queued follow-up (busy). */
export type InputMode = "prompt" | "steer" | "follow_up";

/** `POST /api/sessions/:id/input`. */
export type InputRequest = {
	content: string;
	mode: InputMode;
	/** Client-chosen idempotency key; a repeat with the same id returns the same submission. */
	requestId: string;
};

/** Response to `POST /api/sessions/:id/input`. */
export type InputResponse = { submissionId: SubmissionId };

/** `POST /api/sessions/:id/abort` → `OkResponse`. Aborts the run and its owned (foreground) tasks. */
export type AbortResponse = OkResponse;

/** `GET /api/sessions/:id/entries` query (pi-durable `EntryQuery` plus a page size). */
export type EntriesQuery = {
	minEntryId?: EntryId;
	maxEntryId?: EntryId;
	/** Default `desc`. */
	order?: "asc" | "desc";
	/** Default 50, max 500. */
	limit?: number;
};

/** One transcript entry as stored by pi-durable (`pi.user`, `pi.assistant`, `pi.tool-result`, …). */
export type ApiEntry = EntryRecord;

/** Response to `GET /api/sessions/:id/entries`. */
export type EntriesResponse = {
	items: ApiEntry[];
	/** True when more entries exist past the last item in the requested order. */
	more: boolean;
};

// ─── Approvals ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Operator decision on a gated tool call. */
export type ApprovalDecision = "approve" | "approve_session" | "deny";

/** A pending approval (from `tobor.approvals`). */
export type PendingApproval = {
	/** Conversation that made the call (a session or a worker). */
	conversationId: SessionId;
	/** Top-level session the conversation belongs to (equals `conversationId` unless a worker). */
	sessionId: SessionId;
	/** Worker name when the call came from a worker. */
	worker?: string;
	/** Model tool call id. */
	callId: string;
	tool: string;
	/** Tool arguments as the model sent them. */
	args: unknown;
	createdAt: Millis;
	/** When the call is auto-denied (`createdAt + approval_timeout`). */
	expiresAt: Millis;
};

/** `GET /api/approvals` → every pending record across conversations, oldest first. */
export type ListApprovalsResponse = PendingApproval[];

/** `POST /api/approvals/:callId`. `conversationId` disambiguates if two conversations share a call id. */
export type DecideApprovalRequest = {
	decision: ApprovalDecision;
	conversationId?: SessionId;
};

/** Response to `POST /api/approvals/:callId`; a second decision gets 409. */
export type DecideApprovalResponse = OkResponse;

/** How a resolved approval ended. */
export type ApprovalOutcome = ApprovalDecision | "timeout" | "cancelled";

// ─── Questions (`ask_user`) ─────────────────────────────────────────────────────────────────────────────────────────

/** A question the agent asked the operator (from `tobor.questions`) and is waiting on. */
export type PendingQuestion = {
	/** Conversation that asked (a session or a worker). */
	conversationId: SessionId;
	/** Top-level session the conversation belongs to (equals `conversationId` unless a worker). */
	sessionId: SessionId;
	/** Worker name when a worker asked. */
	worker?: string;
	/** Model tool call id. */
	callId: string;
	question: string;
	/** Suggested answers; free text is always allowed. */
	options?: string[];
	createdAt: Millis;
	/** When the wait gives up (`createdAt + approval_timeout`). */
	expiresAt: Millis;
};

/** `GET /api/questions` → every pending question across conversations, oldest first. */
export type ListQuestionsResponse = PendingQuestion[];

/** `POST /api/questions/:callId`. `conversationId` disambiguates if two conversations share a call id. */
export type AnswerQuestionRequest = {
	answer: string;
	conversationId?: SessionId;
};

/** Response to `POST /api/questions/:callId`; a second answer gets 409. */
export type AnswerQuestionResponse = OkResponse;

/** How a question ended. */
export type QuestionOutcome = "answered" | "timeout" | "cancelled";

// ─── Workers ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Worker lifecycle. */
export type WorkerState = "starting" | "running" | "done" | "failed" | "aborted";

/** One row of `GET /api/sessions/:id/workers`. */
export type WorkerSummary = {
	/** Worker id, unique within its session. */
	id: string;
	name: string;
	/** Agent definition name. */
	agent: string;
	/** The worker's conversation; watch it like a session. Absent while `starting`. */
	conversationId?: SessionId;
	state: WorkerState;
	usage: UsageSummary;
	/** Last line of assistant text (or the final answer when done). */
	lastText: string;
	createdAt: Millis;
	finishedAt?: Millis;
};

/** `GET /api/sessions/:id/workers`. */
export type ListWorkersResponse = WorkerSummary[];

// ─── Agents ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An agent definition from `.tobor/agents/<name>.md` (node or project). */
export type AgentDefinition = {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** Tool names or `mcp__<server>__*` globs; absent = full set. */
	tools?: string[];
	max_turns?: number;
	approval: "inherit" | "auto";
	/** Where it came from; project agents shadow node agents by name. */
	source: "node" | "project";
	/** Absolute file path. */
	path: string;
	/** Markdown body: the worker's preamble. */
	body: string;
};

/** `GET /api/agents?cwd=` → node agents, overlaid with project agents for `cwd` when given. */
export type ListAgentsResponse = AgentDefinition[];

// ─── MCP ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Connection status of one MCP server. */
export type McpStatus = "connected" | "connecting" | "error";

/** One row of `GET /api/mcp`. */
export type McpServerStatus = {
	server: string;
	type: "stdio" | "http";
	status: McpStatus;
	error?: string;
	/** Number of registered tools. */
	tools: number;
	/** Registered tool names (`mcp__<server>__<tool>`). */
	toolNames: string[];
};

/** `GET /api/mcp`. */
export type ListMcpResponse = McpServerStatus[];

// ─── Models and auth ────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a provider's credential comes from; OAuth wins over an env key. */
export type AuthSource = "oauth" | "env" | "none";

/** Auth status of one provider. Tokens are never returned. */
export type ProviderAuth = {
	source: AuthSource;
	/** OAuth access token expiry. */
	expiresAt?: Millis;
	/** Provider supports `POST /api/auth/:provider/login/*`. */
	oauth?: boolean;
};

/** `GET /api/auth` → `{<provider>: ProviderAuth}`. */
export type AuthStatusResponse = Record<string, ProviderAuth>;

/** One catalog model. */
export type ModelInfo = {
	/** `provider/modelId`, the form every other API uses. */
	ref: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
	/** USD per million tokens. */
	cost?: { input: number; output: number };
	/** Whether the provider has a credential. */
	available: boolean;
};

/** `GET /api/models`. */
export type ModelsResponse = {
	models: ModelInfo[];
	providers: AuthStatusResponse;
	/** Node defaults, for pickers. */
	defaults: { model: string; thinking: ThinkingLevel; approval_mode: ApprovalMode; mode: SessionMode };
};

/** Response to `POST /api/auth/:provider/login/start`: the URL the operator opens on any device. */
export type LoginStartResponse = { url: string; instructions?: string };

/** `POST /api/auth/:provider/login/code`: the code the provider displays after approval. */
export type LoginCodeRequest = { code: string };

/** Response to `POST /api/auth/:provider/login/code`. */
export type LoginCodeResponse = { ok: true; auth: ProviderAuth };

// ─── Cwds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/cwds`. */
export type CwdsResponse = {
	/** Configured roots (absolute). */
	roots: string[];
	/** Recently used session cwds, most recent first. */
	recent: string[];
};

// ─── Agent data files (.tobor) ──────────────────────────────────────────────────────────────────────────────────────

/** One directory entry under `$TOBOR_HOME/.tobor`. */
export type ToborDirEntry = { name: string; type: "file" | "dir" };

/** `GET /api/tobor/files/*path`: a file's text or a directory listing (`path` is relative to `.tobor/`). */
export type ToborFileResponse =
	| { type: "file"; path: string; content: string; /** Git blob sha of the committed content. */ sha?: string }
	| { type: "dir"; path: string; entries: ToborDirEntry[] };

/** `PUT /api/tobor/files/*path`. Validated (config.yml, mcp.json, frontmatter) before commit. */
export type PutToborFileRequest = {
	content: string;
	/** Optimistic concurrency: reject with 409 if the current sha differs. */
	sha?: string;
	/** Commit message; default `client: <path>`. */
	message?: string;
};

/** Response to `PUT`/`DELETE /api/tobor/files/*path`; validation failures are 422 `ApiError` with `errors`. */
export type ToborFileWriteResponse = { ok: true; commit: string };

// ─── Artifacts ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One published artifact revision. */
export type ArtifactRevision = {
	/** Global revision id (`/art/r/<rev>`). */
	rev: string;
	/** Per-(project, slug) sequence number, from 1. */
	revision: number;
	projectId: string;
	slug: string;
	title: string;
	tags: string[];
	/** Content hash of the bundle. */
	hash: string;
	/** Session that published it, if any. */
	conversationId?: SessionId;
	createdAt: Millis;
	/** Viewer URL on the artifacts origin (fixed revision). */
	url: string;
	/** PDF URL on the artifacts origin. */
	pdfUrl: string;
};

/** Latest revision of one artifact. */
export type ArtifactSummary = {
	projectId: string;
	slug: string;
	title: string;
	latest: ArtifactRevision;
	revisions: number;
	/** Viewer URL that always shows the latest revision. */
	url: string;
};

/** `GET /api/artifacts?project=` → artifacts, newest first. */
export type ListArtifactsResponse = ArtifactSummary[];

/** `GET /api/artifacts/:projectId/:slug/revisions` → revisions, newest first. */
export type ListArtifactRevisionsResponse = ArtifactRevision[];

// ─── Schedules ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Outcome of one schedule firing. */
export type ScheduleRunStatus = "running" | "done" | "failed" | "skipped_misfire" | "skipped_overlap";

/** One firing of a schedule (capped at 50 per schedule). */
export type ScheduleRun = {
	fireAt: Millis;
	conversationId?: SessionId;
	submissionId?: SubmissionId;
	status: ScheduleRunStatus;
	/** Reason for skips or failures. */
	notice?: string;
};

/** A schedule definition as stored in `tobor.schedules`. Exactly one of `cron` and `at` is set. */
export type ScheduleDefinition = {
	id: string;
	name: string;
	/** 5-field cron expression. */
	cron?: string;
	/** One-shot fire time, ISO 8601. */
	at?: string;
	/** IANA zone; default the host zone. */
	tz: string;
	/** Absolute working directory (inside a root). */
	cwd: string;
	prompt: string;
	model?: string;
	approval_mode?: ApprovalMode;
	/** Duration such as `2h`; default `2h`. */
	misfire_grace?: string;
	enabled: boolean;
	createdAt: Millis;
	updatedAt: Millis;
};

/** A schedule with its run history, as returned by the API. */
export type Schedule = ScheduleDefinition & {
	/** Next computed fire time, absent when disabled or a fired one-shot. */
	nextFireAt?: Millis;
	runs: ScheduleRun[];
};

/** `GET /api/schedules`. */
export type ListSchedulesResponse = Schedule[];

/** `POST /api/schedules`. */
export type CreateScheduleRequest = {
	name: string;
	cron?: string;
	at?: string;
	tz?: string;
	cwd: string;
	prompt: string;
	model?: string;
	approval_mode?: ApprovalMode;
	misfire_grace?: string;
	/** Default true. */
	enabled?: boolean;
};

/** Response to `POST /api/schedules`. */
export type CreateScheduleResponse = { id: string };

/** `PUT /api/schedules/:id`: fields to change. */
export type UpdateScheduleRequest = Partial<CreateScheduleRequest>;

/** Response to `GET`/`PUT /api/schedules/:id`. */
export type ScheduleResponse = Schedule;

// ─── WebSocket: /api/sessions/:id/watch ─────────────────────────────────────────────────────────────────────────────

/** The `from` query parameter of the watch socket, JSON-encoded (pi-durable `ConversationWindow`). */
export type WatchWindow = ConversationWindow;

/** A pi-durable conversation view (`entries`, `docs` such as `pi.live`, `pi.usage`, `tobor.todo`). */
export type WatchValue = ConversationView;

/** Node → client frames on the watch socket. */
export type WatchFrame =
	/** First frame: the full view to replicate. */
	| { t: "snapshot"; value: WatchValue }
	/** Chord ops to apply in order (`chord/delta` `applyImmutable`). */
	| { t: "ops"; ops: readonly Op[] }
	/** The watch ended (session deleted, node shutting down, Session failed); the socket closes after it. */
	| { t: "end"; reason: string }
	/** Reply to a client ping. */
	| { t: "pong" };

/** Client → node frames; commands go through REST. */
export type WatchClientFrame = { t: "ping" };

// ─── WebSocket: /api/events ─────────────────────────────────────────────────────────────────────────────────────────

/** Node-wide events, also the in-process `EventBus` payloads. Lossy: refetch lists on (re)connect. */
export type NodeEvent =
	/** A session changed state, or its summary changed (title, archived, created). */
	| { type: "session.state"; id: SessionId; state: SessionState; failure?: SessionFailure }
	/** A session was created, renamed, archived or deleted; refetch `/api/sessions`. */
	| { type: "session.updated"; id: SessionId; deleted?: boolean }
	/** A gated call is waiting for the operator. */
	| { type: "approval.requested"; approval: PendingApproval }
	/** A pending approval was decided, timed out or cancelled. */
	| { type: "approval.resolved"; conversationId: SessionId; callId: string; outcome: ApprovalOutcome }
	/** The agent asked the operator a question (`ask_user`) and is waiting. */
	| { type: "question.asked"; question: PendingQuestion }
	/** A pending question was answered, timed out or cancelled. */
	| { type: "question.answered"; conversationId: SessionId; callId: string; outcome: QuestionOutcome }
	/** A worker changed state. */
	| { type: "worker.state"; sessionId: SessionId; worker: WorkerSummary }
	/** The agent published an artifact revision. */
	| { type: "artifact.published"; artifact: ArtifactRevision }
	/** A schedule fired (or skipped). */
	| { type: "schedule.fired"; scheduleId: string; name: string; run: ScheduleRun }
	/** The node committed a change to `.tobor/` (client or agent edit). */
	| { type: "agent.committed"; commit: string; message: string; paths: string[] }
	/** MCP server status changed. */
	| { type: "mcp.status"; status: McpServerStatus };

/** Every `NodeEvent["type"]`. */
export type NodeEventType = NodeEvent["type"];

/** Node → client frames on `/api/events`. */
export type EventsFrame = { t: "event"; event: NodeEvent } | { t: "pong" };

/** Client → node frames on `/api/events`. */
export type EventsClientFrame = { t: "ping" };
