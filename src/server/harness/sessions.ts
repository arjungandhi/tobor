import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Agent,
	type AgentChange,
	configure,
	type ConversationId,
	type ConversationWatch,
	type EntryId,
	type Harness,
	LiveDoc,
	type LiveState,
	type Registry,
	type TaskId,
	type ToolRegistration,
	type UserInput,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import type {
	CwdsResponse,
	EntriesQuery,
	EntriesResponse,
	ImageAttachment,
	InputMode,
	ListSessionsResponse,
	PatchSessionRequest,
	PathCompleteResponse,
	SessionDetail,
	SessionFailure,
	SessionId,
	SessionState,
	SessionSummary,
	SubmissionId,
	UsageSummary,
	WatchWindow,
} from "../../api/types.js";
import { applyProjectConfig, parseProjectConfig } from "../../config/load.js";
import { type Config, parseModelRef, type SessionMode } from "../../config/schema.js";
import { type SessionIndexEntry, SessionDoc, SessionsDoc, type WorkerRecord, WorkersDoc } from "../../docs.js";
import type { EventBus } from "../../events.js";
import {
	type CreateSessionOptions,
	HostError,
	type SessionIndex as SessionIndexContract,
} from "../../host.js";
import { completePath } from "./complete.js";
import { findGitRoot, resolveCwd } from "./env.js";
import { ASK_USER } from "./questions/tool.js";
import { generateTitle, resolveTitleModel } from "./titles.js";
import { isLive } from "./workers/tools.js";

/** Tools the model sees in `director` mode; `artifact_*` tools are added from the registry. */
export const DIRECTOR_TOOLS: readonly string[] = ["read", "todo", "task", "wait", "agent_output", "agent_list", "agent_stop", "agent_send", "fetch_url", "web_search", "ask_user"];

/** What `SessionIndex` reads pending approvals and questions from. */
export type PendingSource = { pending(): Promise<{ sessionId: SessionId }[]> };

/** Dependencies of `SessionIndex`. */
export type SessionIndexOptions = {
	harness: Harness;
	registry: Registry;
	models: Models;
	systemConversationId: number;
	events: EventBus;
	config: () => Config;
	approvals: PendingSource;
	questions: PendingSource;
	/** Node lifetime context. */
	ctx: Context;
};

/**
 * Client-facing state of a conversation from its `pi.live` doc, its pending approval and question count and its live
 * worker count. Precedence: run (`waiting`/`running`) > failure > live workers (`working`) > `idle`.
 */
export function deriveState(
	live: Readonly<LiveState> | undefined,
	pending: number,
	liveWorkers: number,
): { state: SessionState; failure?: SessionFailure } {
	if (live?.run) return { state: pending > 0 ? "waiting" : "running" };
	if (live?.runFailure) {
		const { reason, detail } = live.runFailure;
		return { state: "failed", failure: { reason, ...(detail ? { detail } : {}) } };
	}
	return { state: liveWorkers > 0 ? "working" : "idle" };
}

/** Live workers in a director's `tobor.workers` doc: state-based, as `isLive` (the `agent_*` tools) does. */
function liveWorkerCount(doc: Readonly<{ workers: Readonly<Record<string, Pick<WorkerRecord, "state">>> }> | undefined): number {
	return Object.values(doc?.workers ?? {}).filter(isLive).length;
}

/** Shown for a session created without a prompt until its first input names it. */
const UNTITLED = "new session";

/** Title for a new session: the prompt's first 60 characters, whitespace collapsed. */
export function titleFromPrompt(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * The `UserInput` for a message: the plain string when there are no attachments, else content blocks: a text block
 * (only when `text` is non-empty) followed by one image block per attachment.
 */
export function toUserInput(text: string, attachments?: readonly ImageAttachment[]): UserInput {
	if (!attachments?.length) return text;
	return [
		...(text === "" ? [] : [{ type: "text" as const, text }]),
		...attachments.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mimeType })),
	];
}

/** Token and cost totals over every model of a `pi.usage` doc. */
export function summarizeUsage(usage: Readonly<UsageState> | undefined): UsageSummary {
	const sum: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const u of Object.values(usage?.models ?? {})) {
		sum.input += u.input;
		sum.output += u.output;
		sum.cacheRead += u.cacheRead;
		sum.cacheWrite += u.cacheWrite;
		sum.totalTokens += u.totalTokens;
		sum.cost += u.cost.total;
	}
	return sum;
}

type Tracked = { detach(): void; busy: boolean };

/** Sessions over `tobor.sessions` (system conversation) and each conversation's `tobor.session`. */
export class SessionIndex implements SessionIndexContract {
	private readonly tracked = new Map<number, Tracked>();
	private readonly lastState = new Map<number, string>();
	private readonly refreshing = new Map<number, { dirty: boolean }>();
	private readonly unsubscribe: (() => void)[] = [];
	/** Sessions whose first exchange has been offered to the title model (once per process). */
	private readonly titled = new Set<number>();
	/** Title attempts currently running, for `titlesSettled`. */
	private readonly titling = new Set<Promise<void>>();
	/** Aborts in-flight title calls on `stop`. */
	private readonly titleAbort = new AbortController();

	constructor(private readonly o: SessionIndexOptions) {
		const onPending = (conversationId: number) => void this.sessionOf(conversationId).then((id) => this.refresh(id));
		this.unsubscribe.push(
			o.events.on("approval.requested", (e) => onPending(e.approval.sessionId)),
			o.events.on("approval.resolved", (e) => onPending(e.conversationId)),
			o.events.on("question.asked", (e) => onPending(e.question.sessionId)),
			o.events.on("question.answered", (e) => onPending(e.conversationId)),
			o.events.on("worker.state", (e) => void this.refresh(e.sessionId)),
		);
	}

	/** Boot: start tracking every indexed session with a run in progress. */
	async startTracking(): Promise<void> {
		const index = await this.index();
		for (const key of Object.keys(index.sessions)) {
			const id = Number(key);
			const live = await this.o.harness.snapshot(LiveDoc, id as ConversationId, this.o.ctx);
			if (live?.run) this.track(id);
		}
	}

	/** Stop observers and event subscriptions (shutdown). */
	stop(): void {
		this.titleAbort.abort();
		for (const t of this.tracked.values()) t.detach();
		this.tracked.clear();
		for (const u of this.unsubscribe.splice(0)) u();
	}

	async list(options: { archived?: boolean } = {}): Promise<ListSessionsResponse> {
		const index = await this.index();
		const pending = await this.pendingCounts();
		const rows = Object.values(index.sessions).filter((e) => options.archived || !e.archived);
		const out = await Promise.all(rows.map((e) => this.load(e.id, e, pending.get(e.id) ?? 0)));
		return out
			.flatMap((found) => (found ? [found.summary] : []))
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	create(options: CreateSessionOptions & { prompt: string }): Promise<{ id: SessionId; submissionId: SubmissionId }>;
	create(options: CreateSessionOptions): Promise<{ id: SessionId; submissionId?: SubmissionId }>;
	async create(options: CreateSessionOptions): Promise<{ id: SessionId; submissionId?: SubmissionId }> {
		const { harness, ctx } = this.o;
		const cwd = await this.resolveCwd(options.cwd);
		const config = await this.configFor(cwd);
		const model = this.modelRef(options.model ?? config.defaults.model);
		const mode = options.mode ?? config.defaults.mode;
		const kind = options.kind ?? "session";
		const createdAt = Date.now();
		const prompt = options.prompt?.trim() ? options.prompt : undefined;
		const title = titleFromPrompt(prompt ?? "");
		const systemId = this.o.systemConversationId as ConversationId;
		const modelTools = this.modelTools(mode, kind === "schedule");
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model,
					thinkingLevel: options.thinking ?? config.defaults.thinking,
					cwd,
					maxTurns: config.defaults.max_turns,
					...(modelTools ? { modelTools } : {}),
				},
				init: async (tx, id) => {
					const session = await tx.doc(SessionDoc, id);
					session.title = title;
					session.titleSource = "prompt";
					session.approval_mode = options.approvalMode ?? config.defaults.approval_mode;
					session.mode = mode;
					session.cwd = cwd;
					session.createdAt = createdAt;
					const index = await tx.doc(SessionsDoc, systemId);
					index.sessions[String(id)] = {
						id,
						title,
						cwd,
						kind,
						...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
						createdAt,
						archived: false,
					};
				},
			},
			ctx,
		);
		// Promptless: the session stays idle with no turns (nothing to track until `input`); the first input seeds the title.
		const attachments = options.attachments?.length ? options.attachments : undefined;
		const submission = prompt || attachments
			? await conversation.submit(
					{ type: "input", content: toUserInput(prompt ?? "", attachments), ...(options.requestId ? { requestId: options.requestId } : {}) },
					ctx,
				)
			: undefined;
		this.o.events.emit({ type: "session.updated", id: conversation.id });
		if (submission) this.track(conversation.id);
		return { id: conversation.id, ...(submission ? { submissionId: submission.id } : {}) };
	}

	async get(id: SessionId): Promise<SessionDetail | undefined> {
		const index = await this.index();
		const pending = (await this.pendingCounts()).get(id) ?? 0;
		const workers = await this.o.harness.snapshot(WorkersDoc, id as ConversationId, this.o.ctx);
		const found = await this.load(id, index.sessions[String(id)], pending, liveWorkerCount(workers));
		if (!found) return undefined;
		return {
			...found.summary,
			thinking: found.agent.thinkingLevel,
			max_turns: found.agent.maxTurns ?? this.o.config().defaults.max_turns,
			workers: Object.keys(workers?.workers ?? {}).length,
		};
	}

	async patch(id: SessionId, patch: PatchSessionRequest): Promise<SessionDetail> {
		const cid = id as ConversationId;
		const current = await this.o.harness.snapshot(SessionDoc, cid, this.o.ctx);
		if (!current) throw new HostError(404, "not_found", `no session ${id}`);
		if (patch.title !== undefined && patch.title.trim() === "") throw new HostError(400, "invalid", "title is empty");
		const change: { -readonly [K in keyof AgentChange]: AgentChange[K] } = {};
		if (patch.model !== undefined) change.model = this.modelRef(patch.model);
		if (patch.thinking !== undefined) change.thinkingLevel = patch.thinking;
		if (patch.mode !== undefined && patch.mode !== current.mode) {
			const unattended = (await this.index()).sessions[String(id)]?.kind === "schedule";
			change.modelTools = this.modelTools(patch.mode, unattended) ?? null;
		}
		const systemId = this.o.systemConversationId as ConversationId;
		await this.o.harness.commit(async (tx) => {
			const session = await tx.doc(SessionDoc, cid);
			const index = await tx.doc(SessionsDoc, systemId);
			const entry = index.sessions[String(id)];
			if (patch.title !== undefined) {
				session.title = patch.title.trim();
				session.titleSource = "user";
				if (entry) entry.title = session.title;
			}
			if (patch.approval_mode !== undefined) session.approval_mode = patch.approval_mode;
			if (patch.mode !== undefined) session.mode = patch.mode;
			if (patch.archived !== undefined && entry) entry.archived = patch.archived;
			if (Object.keys(change).length) await configure(tx, cid, change);
		}, this.o.ctx);
		this.o.events.emit({ type: "session.updated", id });
		return (await this.get(id))!;
	}

	async archive(id: SessionId, archived = true): Promise<void> {
		await this.o.harness.commit(async (tx) => {
			const index = await tx.doc(SessionsDoc, this.o.systemConversationId as ConversationId);
			const entry = index.sessions[String(id)];
			if (!entry) throw new HostError(404, "not_found", `no session ${id}`);
			entry.archived = archived;
		}, this.o.ctx);
		this.o.events.emit({ type: "session.updated", id });
	}

	async delete(id: SessionId): Promise<void> {
		const index = await this.index();
		if (!index.sessions[String(id)]) throw new HostError(404, "not_found", `no session ${id}`);
		await this.abort(id);
		await this.o.harness.commit(async (tx) => {
			const doc = await tx.doc(SessionsDoc, this.o.systemConversationId as ConversationId);
			delete doc.sessions[String(id)];
		}, this.o.ctx);
		this.tracked.get(id)?.detach();
		this.tracked.delete(id);
		this.lastState.delete(id);
		this.o.events.emit({ type: "session.updated", id, deleted: true });
	}

	async input(
		id: SessionId,
		input: { content: string; attachments?: ImageAttachment[]; mode: InputMode; requestId: string },
	): Promise<{ submissionId: SubmissionId }> {
		const conversation = await this.conversation(id);
		await this.seedTitle(id, input.content);
		const submission = await conversation.submit(
			{
				type: "input",
				content: toUserInput(input.content, input.attachments),
				requestId: input.requestId,
				...(input.mode === "steer" ? { whenBusy: "steer" as const } : {}),
			},
			this.o.ctx,
		);
		this.track(id);
		return { submissionId: submission.id };
	}

	/** A session created without a prompt has an empty title; its first input names it, as a first prompt would. */
	private async seedTitle(id: SessionId, content: string): Promise<void> {
		const cid = id as ConversationId;
		const session = await this.o.harness.snapshot(SessionDoc, cid, this.o.ctx);
		if (!session || session.title !== "" || session.worker) return;
		const title = titleFromPrompt(content);
		if (!title) return;
		await this.o.harness.commit(async (tx) => {
			const doc = await tx.doc(SessionDoc, cid);
			if (doc.title !== "") return;
			doc.title = title;
			doc.titleSource = "prompt";
			const index = await tx.doc(SessionsDoc, this.o.systemConversationId as ConversationId);
			const entry = index.sessions[String(id)];
			if (entry) entry.title = title;
		}, this.o.ctx);
		this.o.events.emit({ type: "session.updated", id });
	}

	/** Fire-and-forget `generateSessionTitle`; never rejects. */
	private retitle(id: number): void {
		if (this.titled.has(id)) return;
		this.titled.add(id);
		const run: Promise<void> = this.generateSessionTitle(id).then(
			(done) => {
				if (!done) this.titled.delete(id);
			},
			() => {},
		);
		this.titling.add(run);
		void run.finally(() => this.titling.delete(run));
	}

	/** Resolves once every title attempt started so far has finished (applied, skipped or failed). */
	async titlesSettled(): Promise<void> {
		await Promise.all([...this.titling]);
	}

	/**
	 * Name a session from its first exchange with the title model, once it first settles. Plain sessions only (not
	 * workers or schedule runs), and only while `titleSource` is exactly "prompt" (a session without one predates titling and may have been renamed). Resolves false when there was
	 * nothing to title yet (so a later idle may retry); any model failure keeps the prompt title.
	 */
	private async generateSessionTitle(id: number): Promise<boolean> {
		const { harness, ctx, models } = this.o;
		const cid = id as ConversationId;
		if (this.titleAbort.signal.aborted) return true;
		const entry = (await this.index()).sessions[String(id)];
		const session = await harness.snapshot(SessionDoc, cid, ctx);
		if (!entry || !session || session.worker || entry.kind !== "session" || entry.scheduleId) return true;
		if (session.titleSource !== "prompt") return true;
		if (this.titleAbort.signal.aborted) return true;
		const conversation = await harness.conversation(cid, ctx);
		if (!conversation) return true;
		const page = await conversation.entries({ order: "ascending" }, 30, undefined, ctx);
		const text = (kind: string): string => {
			for (const e of page.items) {
				const message = e.kind === kind ? e.model?.[0] : undefined;
				if (!message) continue;
				const content = message.content;
				const out = typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (out.trim()) return out.trim();
			}
			return "";
		};
		const prompt = text("pi.user");
		const reply = text("pi.assistant");
		if (!prompt || !reply) return false;
		const agent = await conversation.agent(ctx);
		const model = await resolveTitleModel(models, this.o.config().defaults.title_model, agent.model);
		if (!model) return true;
		const title = await generateTitle(models, model, { prompt, reply }, this.titleAbort.signal);
		if (!title) return true;
		let applied = false;
		await harness.commit(async (tx) => {
			const doc = await tx.doc(SessionDoc, cid);
			if (doc.titleSource !== "prompt") return;
			const index = await tx.doc(SessionsDoc, this.o.systemConversationId as ConversationId);
			const row = index.sessions[String(id)];
			if (!row) return;
			doc.title = title;
			doc.titleSource = "model";
			row.title = title;
			applied = true;
		}, ctx);
		if (applied) this.o.events.emit({ type: "session.updated", id });
		return true;
	}

	async abort(id: SessionId): Promise<void> {
		const conversation = await this.conversation(id);
		await conversation.abort(this.o.ctx);
		const workers = await this.o.harness.snapshot(WorkersDoc, id as ConversationId, this.o.ctx);
		await Promise.all(
			Object.values(workers?.workers ?? {})
				.filter((w) => w.state === "starting" || w.state === "running")
				.map((w) => this.o.harness.abortTask(w.holderTaskId as TaskId, this.o.ctx).catch(() => undefined)),
		);
	}

	async watch(id: SessionId, window: WatchWindow | undefined, ctx: Context): Promise<ConversationWatch> {
		const conversation = await this.conversation(id);
		return conversation.watch(ctx, window);
	}

	async entries(id: SessionId, query: EntriesQuery): Promise<EntriesResponse> {
		const conversation = await this.conversation(id);
		const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
		const page = await conversation.entries(
			{
				...(query.minEntryId !== undefined ? { minEntryId: query.minEntryId as EntryId } : {}),
				...(query.maxEntryId !== undefined ? { maxEntryId: query.maxEntryId as EntryId } : {}),
				order: query.order === "asc" ? "ascending" : "descending",
			},
			limit,
			undefined,
			this.o.ctx,
		);
		return { items: [...page.items], more: page.next !== undefined };
	}

	async complete(id: SessionId, prefix: string): Promise<PathCompleteResponse> {
		const detail = await this.get(id);
		if (!detail) throw new HostError(404, "not_found", `no session ${id}`);
		return completePath(prefix, detail.cwd, this.o.config().roots);
	}

	async cwds(): Promise<CwdsResponse> {
		const index = await this.index();
		const recent: string[] = [];
		for (const e of Object.values(index.sessions).sort((a, b) => b.createdAt - a.createdAt)) {
			if (!recent.includes(e.cwd)) recent.push(e.cwd);
			if (recent.length === 20) break;
		}
		return { roots: [...this.o.config().roots], recent };
	}

	resolveCwd(cwd: string): Promise<string> {
		return resolveCwd(cwd, this.o.config().roots);
	}

	private async index(): Promise<{ sessions: Readonly<Record<string, SessionIndexEntry>> }> {
		const doc = await this.o.harness.snapshot(SessionsDoc, this.o.systemConversationId as ConversationId, this.o.ctx);
		return doc ?? { sessions: {} };
	}

	private async conversation(id: SessionId) {
		const conversation = await this.o.harness.conversation(id as ConversationId, this.o.ctx);
		if (!conversation || id === this.o.systemConversationId) throw new HostError(404, "not_found", `no session ${id}`);
		return conversation;
	}

	/** Node config with the project overlay of `cwd`'s git root. */
	private async configFor(cwd: string): Promise<Config> {
		const config = this.o.config();
		const root = await findGitRoot(cwd);
		if (!root) return config;
		const path = join(root, ".tobor", "config.yml");
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text === undefined) return config;
		const project = parseProjectConfig(text);
		for (const e of project.errors) console.warn(`${path}: ${e.path || "(file)"}: ${e.message}`);
		return applyProjectConfig(config, project.config);
	}

	private modelRef(model: string): { provider: string; modelId: string } {
		const ref = parseModelRef(model);
		if (!ref) throw new HostError(400, "invalid_model", `model must be provider/modelId: ${model}`);
		if (!this.o.models.getModel(ref.provider, ref.modelId)) {
			throw new HostError(400, "unknown_model", `unknown model ${model}`);
		}
		return ref;
	}

	/**
	 * `modelTools` for a mode: the director's list resolved against the registry, unset for `solo`. `unattended` (schedule
	 * runs, which nobody is watching) withholds `ask_user`, which would block until the approval timeout.
	 */
	private modelTools(mode: SessionMode, unattended = false): ToolRegistration[] | { remove: ToolRegistration[] } | undefined {
		const tools = this.o.registry.snapshot().tools();
		if (mode !== "director") {
			return unattended ? { remove: tools.map((t) => t.tool).filter((t) => t.name === ASK_USER) } : undefined;
		}
		const out: ToolRegistration[] = [];
		const seen = new Set<string>();
		for (const { tool } of tools) {
			if (seen.has(tool.name) || (unattended && tool.name === ASK_USER)) continue;
			if (DIRECTOR_TOOLS.includes(tool.name) || tool.name.startsWith("artifact_")) {
				seen.add(tool.name);
				out.push(tool);
			}
		}
		return out;
	}

	private async pendingCounts(): Promise<Map<number, number>> {
		const counts = new Map<number, number>();
		const pending = await Promise.all([this.o.approvals.pending(), this.o.questions.pending()]);
		for (const p of pending.flat()) counts.set(p.sessionId, (counts.get(p.sessionId) ?? 0) + 1);
		return counts;
	}

	private async load(
		id: number,
		entry: SessionIndexEntry | undefined,
		pending: number,
		liveWorkers?: number,
	): Promise<{ summary: SessionSummary; agent: Agent } | undefined> {
		const { harness, ctx } = this.o;
		const cid = id as ConversationId;
		const session = await harness.snapshot(SessionDoc, cid, ctx);
		if (!session) return undefined;
		const conversation = await harness.conversation(cid, ctx);
		if (!conversation) return undefined;
		const [live, usage, agent, latest, workers] = await Promise.all([
			harness.snapshot(LiveDoc, cid, ctx),
			harness.snapshot(UsageDoc, cid, ctx),
			conversation.agent(ctx),
			conversation.entries({ order: "descending" }, 5, undefined, ctx),
			liveWorkers === undefined ? harness.snapshot(WorkersDoc, cid, ctx) : undefined,
		]);
		const createdAt = entry?.createdAt ?? session.createdAt;
		const stamped = latest.items.map((e) => e.model?.[0]?.timestamp);
		const updatedAt = Math.max(createdAt, ...stamped.filter((t): t is number => typeof t === "number"));
		const { state, failure } = deriveState(live, pending, liveWorkers ?? liveWorkerCount(workers));
		const summary: SessionSummary = {
			id,
			title: entry?.title || session.title || UNTITLED,
			cwd: entry?.cwd ?? session.cwd,
			model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : this.o.config().defaults.model,
			approval_mode: session.approval_mode,
			mode: session.mode,
			kind: entry?.kind ?? "session",
			...(entry?.scheduleId ? { scheduleId: entry.scheduleId } : {}),
			state,
			...(failure ? { failure } : {}),
			pending,
			usage: summarizeUsage(usage),
			archived: entry?.archived ?? false,
			createdAt,
			updatedAt,
		};
		return { summary, agent };
	}

	/** The top-level session a conversation belongs to (a worker's director, else itself). */
	private async sessionOf(conversationId: number): Promise<number> {
		const session = await this.o.harness.snapshot(SessionDoc, conversationId as ConversationId, this.o.ctx);
		return session?.worker?.parentId ?? conversationId;
	}

	/** Observe `pi.live` until the session settles, emitting `session.state` on every change. */
	private track(id: number): void {
		if (this.tracked.has(id)) return;
		const entry: Tracked = { detach: () => {}, busy: false };
		this.tracked.set(id, entry);
		this.o.harness
			.observeDoc(
				LiveDoc,
				id as ConversationId,
				{
					advance: () => void this.refresh(id),
					end: () => {
						if (this.tracked.get(id) === entry) this.tracked.delete(id);
					},
				},
				this.o.ctx,
			)
			.then(
				(observation) => {
					if (!observation) {
						this.tracked.delete(id);
						return;
					}
					if (this.tracked.get(id) !== entry) return observation.detach();
					entry.detach = () => observation.detach();
					void this.refresh(id);
				},
				() => this.tracked.delete(id),
			);
	}

	/** Recompute one session's state and emit it when it changed; coalesces concurrent calls. */
	private async refresh(id: number): Promise<void> {
		const running = this.refreshing.get(id);
		if (running) {
			running.dirty = true;
			return;
		}
		const flag = { dirty: true };
		this.refreshing.set(id, flag);
		try {
			while (flag.dirty) {
				flag.dirty = false;
				const live = await this.o.harness.snapshot(LiveDoc, id as ConversationId, this.o.ctx);
				const pending = (await this.pendingCounts()).get(id) ?? 0;
				const workers = await this.o.harness.snapshot(WorkersDoc, id as ConversationId, this.o.ctx);
				const { state, failure } = deriveState(live, pending, liveWorkerCount(workers));
				const key = `${state}:${failure?.reason ?? ""}:${failure?.detail ?? ""}`;
				if (this.lastState.get(id) !== key) {
					this.lastState.set(id, key);
					this.o.events.emit({ type: "session.state", id, state, ...(failure ? { failure } : {}) });
				}
				const tracked = this.tracked.get(id);
				if (tracked && (state === "running" || state === "waiting")) tracked.busy = true;
				if (tracked?.busy && state === "idle") this.retitle(id);
				if (tracked?.busy && (state === "idle" || state === "failed")) {
					tracked.detach();
					this.tracked.delete(id);
				}
			}
		} catch {
			this.lastState.delete(id);
		} finally {
			this.refreshing.delete(id);
		}
	}
}
