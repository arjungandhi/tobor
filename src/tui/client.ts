import WebSocket from "ws";
import type {
	AnswerQuestionRequest,
	ApiError,
	AuthStatusResponse,
	CreateScheduleRequest,
	CreateScheduleResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	CwdsResponse,
	DecideApprovalRequest,
	EntriesQuery,
	EntriesResponse,
	EventsFrame,
	InputRequest,
	InputResponse,
	ListAgentsResponse,
	ListApprovalsResponse,
	ListArtifactRevisionsResponse,
	ListArtifactsResponse,
	ListQuestionsResponse,
	ListSchedulesResponse,
	ListSessionsResponse,
	ListWorkersResponse,
	LoginCodeResponse,
	LoginStartResponse,
	ModelsResponse,
	OkResponse,
	PatchSessionRequest,
	PatchSessionResponse,
	PathCompleteResponse,
	PutToborFileRequest,
	RestartResponse,
	ScheduleResponse,
	SessionDetail,
	SessionId,
	ToborFileResponse,
	ToborFileWriteResponse,
	UpdateScheduleRequest,
	UpgradeResponse,
	WatchFrame,
	WatchWindow,
	WhoamiResponse,
} from "../api/types.js";

/** A non-2xx API response. */
export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly body: ApiError | undefined,
		message: string,
	) {
		super(message);
	}
}

/** Request timeout when the body carries image attachments (up to 8 × 5 MB). */
const UPLOAD_TIMEOUT_MS = 120_000;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Typed HTTP client for one node's API. */
export class ApiClient {
	constructor(readonly base: string) {}

	private async request<T>(method: Method, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
		const headers: Record<string, string> = { accept: "application/json" };
		const payload = body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body);
		if (payload !== undefined) headers["content-type"] = "application/json";
		const res = await fetch(`${this.base}${path}`, {
			method,
			headers,
			body: payload,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let data: unknown;
		let parseFailed = false;
		try {
			data = text === "" ? undefined : JSON.parse(text);
		} catch {
			data = undefined;
			parseFailed = true;
		}
		if (res.ok && parseFailed) {
			throw new ApiRequestError(res.status, undefined, `${method} ${path}: non-JSON response from server (${res.status}): ${text.slice(0, 80).replace(/\s+/g, " ")}`);
		}
		if (!res.ok) {
			const err = data && typeof data === "object" && "error" in data ? (data as ApiError) : undefined;
			const detail = err?.errors?.map((e) => `${e.path}: ${e.message}`).join("; ");
			const message = `${method} ${path}: ${res.status} ${err?.error ?? (text.slice(0, 200) || res.statusText)}`;
			throw new ApiRequestError(res.status, err, detail ? `${message} (${detail})` : message);
		}
		return data as T;
	}

	/** `GET /api/whoami`. */
	whoami(): Promise<WhoamiResponse> {
		return this.request("GET", "/api/whoami");
	}

	/** `POST /api/upgrade`: the node downloads the latest release before answering, so the timeout is generous. */
	upgrade(): Promise<UpgradeResponse> {
		return this.request("POST", "/api/upgrade", undefined, 300_000);
	}

	/** `POST /api/restart`. */
	restart(): Promise<RestartResponse> {
		return this.request("POST", "/api/restart");
	}

	/** `GET /api/sessions`. */
	sessions(archived = false): Promise<ListSessionsResponse> {
		return this.request("GET", archived ? "/api/sessions?archived=1" : "/api/sessions");
	}

	/** `GET /api/sessions/:id`. */
	session(id: SessionId): Promise<SessionDetail> {
		return this.request("GET", `/api/sessions/${id}`);
	}

	/** `POST /api/sessions`. */
	createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
		return this.request("POST", "/api/sessions", req, req.attachments?.length ? UPLOAD_TIMEOUT_MS : undefined);
	}

	/** `PATCH /api/sessions/:id`. */
	patchSession(id: SessionId, req: PatchSessionRequest): Promise<PatchSessionResponse> {
		return this.request("PATCH", `/api/sessions/${id}`, req);
	}

	/** `DELETE /api/sessions/:id`. */
	deleteSession(id: SessionId): Promise<OkResponse> {
		return this.request("DELETE", `/api/sessions/${id}`);
	}

	/** `POST /api/sessions/:id/input`. */
	input(id: SessionId, req: InputRequest): Promise<InputResponse> {
		return this.request("POST", `/api/sessions/${id}/input`, req, req.attachments?.length ? UPLOAD_TIMEOUT_MS : undefined);
	}

	/** `POST /api/sessions/:id/abort`. */
	abort(id: SessionId): Promise<OkResponse> {
		return this.request("POST", `/api/sessions/${id}/abort`);
	}

	/** `GET /api/sessions/:id/entries`. */
	entries(id: SessionId, query: EntriesQuery): Promise<EntriesResponse> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
		return this.request("GET", `/api/sessions/${id}/entries?${params}`);
	}

	/** `GET /api/approvals`. */
	approvals(): Promise<ListApprovalsResponse> {
		return this.request("GET", "/api/approvals");
	}

	/** `POST /api/approvals/:callId`. */
	decide(callId: string, req: DecideApprovalRequest): Promise<OkResponse> {
		return this.request("POST", `/api/approvals/${encodeURIComponent(callId)}`, req);
	}

	/** `GET /api/questions`. */
	questions(): Promise<ListQuestionsResponse> {
		return this.request("GET", "/api/questions");
	}

	/** `POST /api/questions/:callId`. */
	answer(callId: string, req: AnswerQuestionRequest): Promise<OkResponse> {
		return this.request("POST", `/api/questions/${encodeURIComponent(callId)}`, req);
	}

	/** `GET /api/sessions/:id/workers`. */
	workers(id: SessionId): Promise<ListWorkersResponse> {
		return this.request("GET", `/api/sessions/${id}/workers`);
	}

	/** `GET /api/models`. */
	models(): Promise<ModelsResponse> {
		return this.request("GET", "/api/models");
	}

	/** `GET /api/agents` (node agents). */
	agents(): Promise<ListAgentsResponse> {
		return this.request("GET", "/api/agents");
	}

	/** `GET /api/auth`. */
	auth(): Promise<AuthStatusResponse> {
		return this.request("GET", "/api/auth");
	}

	/** `POST /api/auth/:provider/login/start`. */
	loginStart(provider: string): Promise<LoginStartResponse> {
		return this.request("POST", `/api/auth/${encodeURIComponent(provider)}/login/start`);
	}

	/** `POST /api/auth/:provider/login/code`. */
	loginCode(provider: string, code: string): Promise<LoginCodeResponse> {
		return this.request("POST", `/api/auth/${encodeURIComponent(provider)}/login/code`, { code });
	}

	/** `GET /api/sessions/:id/complete?prefix=…`. */
	complete(id: SessionId, prefix: string): Promise<PathCompleteResponse> {
		return this.request("GET", `/api/sessions/${encodeURIComponent(id)}/complete?prefix=${encodeURIComponent(prefix)}`, undefined, 10_000);
	}

	/** `GET /api/cwds`. */
	cwds(): Promise<CwdsResponse> {
		return this.request("GET", "/api/cwds");
	}

	/** `GET /api/artifacts`, optionally limited to a project and/or to the artifacts a session (or its workers) published. */
	artifacts(opts: { project?: string; session?: SessionId } = {}): Promise<ListArtifactsResponse> {
		const query = new URLSearchParams();
		if (opts.project) query.set("project", opts.project);
		if (opts.session !== undefined) query.set("session", String(opts.session));
		const qs = query.toString();
		return this.request("GET", qs ? `/api/artifacts?${qs}` : "/api/artifacts");
	}

	/** `GET /api/artifacts/:projectId/:slug/revisions`. */
	revisions(projectId: string, slug: string): Promise<ListArtifactRevisionsResponse> {
		return this.request("GET", `/api/artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}/revisions`);
	}

	/** `GET /api/schedules`. */
	schedules(): Promise<ListSchedulesResponse> {
		return this.request("GET", "/api/schedules");
	}

	/** `POST /api/schedules`. */
	createSchedule(req: CreateScheduleRequest): Promise<CreateScheduleResponse> {
		return this.request("POST", "/api/schedules", req);
	}

	/** `PUT /api/schedules/:id`. */
	updateSchedule(id: string, req: UpdateScheduleRequest): Promise<ScheduleResponse> {
		return this.request("PUT", `/api/schedules/${encodeURIComponent(id)}`, req);
	}

	/** `DELETE /api/schedules/:id`. */
	deleteSchedule(id: string): Promise<OkResponse> {
		return this.request("DELETE", `/api/schedules/${encodeURIComponent(id)}`);
	}

	/** `GET /api/tobor/files/*path` (`""` is the `.tobor/` root). */
	file(path: string): Promise<ToborFileResponse> {
		return this.request("GET", `/api/tobor/files/${encodePath(path)}`);
	}

	/** `PUT /api/tobor/files/*path`. */
	putFile(path: string, req: PutToborFileRequest): Promise<ToborFileWriteResponse> {
		return this.request("PUT", `/api/tobor/files/${encodePath(path)}`, req);
	}

	/** Fetch an absolute URL (artifacts origin) as bytes. */
	async download(url: string): Promise<Uint8Array> {
		const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!res.ok) throw new ApiRequestError(res.status, undefined, `GET ${url}: ${res.status} ${res.statusText}`);
		return new Uint8Array(await res.arrayBuffer());
	}

	/** WebSocket URL of `/api/sessions/:id/watch`, resuming from `window` when given. */
	watchUrl(id: SessionId, window?: WatchWindow): string {
		const url = new URL(`/api/sessions/${id}/watch`, this.base.replace(/^http/, "ws"));
		if (window && Object.keys(window).length > 0) url.searchParams.set("from", JSON.stringify(window));
		return url.toString();
	}

	/** WebSocket URL of `/api/events`. */
	eventsUrl(): string {
		return new URL("/api/events", this.base.replace(/^http/, "ws")).toString();
	}
}

function encodePath(path: string): string {
	return path
		.split("/")
		.filter((part) => part !== "")
		.map(encodeURIComponent)
		.join("/");
}

/** A connection must stay open this long before the reconnect backoff resets. */
const STABLE_MS = 10_000;

/** Connection state of a `ReconnectingSocket`. */
export type SocketState = "connecting" | "open" | "waiting" | "closed";

/** Options for `ReconnectingSocket`. */
export type ReconnectingSocketOptions<In> = {
	/** Evaluated on every (re)connect, so a watch can resume from its replica's window. */
	url: () => string;
	onFrame: (frame: In) => void;
	/** Called after each successful connect; `reconnect` is false the first time. */
	onOpen?: (reconnect: boolean) => void;
	onState?: (state: SocketState, detail?: string) => void;
	minDelayMs?: number;
	maxDelayMs?: number;
	pingMs?: number;
};

/** A JSON WebSocket that reconnects with exponential backoff and pings to keep idle links alive. */
export class ReconnectingSocket<In> {
	private ws: WebSocket | undefined;
	private attempt = 0;
	private opened = false;
	private stopped = false;
	private timer: NodeJS.Timeout | undefined;
	private ping: NodeJS.Timeout | undefined;
	/** Last time anything (message or pong) arrived on the current connection. */
	private lastRx = 0;
	/** When the current connection opened; 0 while not open. */
	private openedAt = 0;
	/** Most recent socket/handler error for the current attempt, shown in the retry detail. */
	private lastError: string | undefined;

	constructor(private readonly options: ReconnectingSocketOptions<In>) {}

	/** Open the socket. */
	start(): void {
		this.connect();
	}

	/** Close for good. */
	close(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		clearInterval(this.ping);
		this.ws?.removeAllListeners();
		this.ws?.on("error", () => {});
		this.ws?.terminate();
		this.ws = undefined;
		this.options.onState?.("closed");
	}

	/** Drop the current connection and reconnect now (e.g. after a watch `end`). */
	reconnect(): void {
		if (this.stopped) return;
		this.ws?.terminate();
	}

	private connect(): void {
		if (this.stopped) return;
		this.options.onState?.("connecting");
		this.lastError = undefined;
		const ws = new WebSocket(this.options.url(), { handshakeTimeout: 10_000 });
		this.ws = ws;
		const pingMs = this.options.pingMs ?? 20_000;
		ws.on("open", () => {
			const reconnect = this.opened;
			this.opened = true;
			// The backoff is only reset once the connection proves stable (see the close handler).
			this.openedAt = this.lastRx = Date.now();
			this.options.onState?.("open");
			clearInterval(this.ping);
			this.ping = setInterval(() => {
				if (ws.readyState !== WebSocket.OPEN) return;
				if (Date.now() - this.lastRx > pingMs * 2.5) {
					// Half-open link: nothing (not even a pong) arrived; force the normal reconnect path.
					this.lastError = "connection timed out (no data from server)";
					ws.terminate();
					return;
				}
				ws.send(JSON.stringify({ t: "ping" }));
			}, pingMs);
			this.options.onOpen?.(reconnect);
		});
		ws.on("pong", () => {
			this.lastRx = Date.now();
		});
		ws.on("message", (data) => {
			this.lastRx = Date.now();
			let frame: In;
			try {
				frame = JSON.parse(data.toString()) as In;
			} catch {
				return;
			}
			try {
				this.options.onFrame(frame);
			} catch (err) {
				// Never let a frame handler crash the process; reconnect to resync instead.
				this.lastError = `frame handler failed: ${err instanceof Error ? err.message : String(err)}`;
				ws.terminate();
			}
		});
		ws.on("error", (err) => {
			this.lastError = err instanceof Error ? err.message : String(err);
		});
		ws.on("close", (code, reason) => {
			if (this.ws !== ws) return;
			clearInterval(this.ping);
			this.ws = undefined;
			if (this.stopped) return;
			if (this.openedAt > 0 && Date.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
			this.openedAt = 0;
			const delay = Math.min(this.options.maxDelayMs ?? 15_000, (this.options.minDelayMs ?? 500) * 2 ** this.attempt);
			this.attempt++;
			const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
			const why = reason.toString() || this.lastError || `code ${code}`;
			this.options.onState?.("waiting", `${why}; retry in ${Math.ceil(jittered / 1000)}s`);
			this.timer = setTimeout(() => this.connect(), jittered);
		});
	}
}

/** Watch socket frames. */
export type WatchSocket = ReconnectingSocket<WatchFrame>;
/** Events socket frames. */
export type EventsSocket = ReconnectingSocket<EventsFrame>;
