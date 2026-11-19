import { randomUUID } from "node:crypto";
import { type Component, ScrollView } from "@earendil-works/pi-tui";
import type {
	InputMode,
	PendingApproval,
	PendingQuestion,
	PatchSessionRequest,
	SessionDetail,
	SessionId,
	SessionSummary,
	SessionState,
	WatchFrame,
	WorkerSummary,
} from "../../api/types.js";
import type { App } from "../app.js";
import { clipboardImage, loadImage, MAX_ATTACHMENTS } from "../attachments.js";
import { ReconnectingSocket, type SocketState } from "../client.js";
import { readClipboard, stripPasteMarkers, WL_CLIPBOARD_HINT } from "../clipboard.js";
import { Composer } from "../components/composer.js";
import { QuestionPanel } from "../components/question-panel.js";
import { Transcript, type PendingBlock } from "../components/transcript.js";
import { BUSY_MESSAGE, COMMANDS } from "../keys.js";
import { type Block, ConversationReplica, type ImagePart, liveOf, usageOf, type ViewUsage } from "../replica.js";
import { c } from "../theme.js";
import { startSession } from "./new-session.js";
import { WorkersStrip } from "./workers.js";

/** The transcript's primary scroll view; scrolling up into its top calls `onTop` (to load earlier history). */
export class TranscriptScroll extends ScrollView {
	/** Rows prepended above the viewport that the next layout should scroll past, so the user stays where they were. */
	private shift = 0;

	constructor(
		content: Component,
		private readonly onTop: () => void,
		private readonly onAway: () => void = () => {},
	) {
		super(content, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	}

	override scrollBy(lines: number): number {
		const remaining = super.scrollBy(lines);
		if (this.scrollTop > 0) this.onAway();
		else if (lines < 0) this.onTop();
		return remaining;
	}

	/** Forget a pending `keepPosition` (the content it was measured against is gone). */
	clearKeep(): void {
		this.shift = 0;
	}

	/** `rows` were added above the current content: keep the visible lines where they are (applied on the next layout, when the new height is known). */
	keepPosition(rows: number): void {
		this.shift = rows;
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const shift = this.shift;
		this.shift = 0;
		const following = this.isFollowingEnd;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		if (shift > 0 && !following) this.scrollTo(this.scrollTop + shift, { disableFollow: true });
	}

	override scrollToStart(): void {
		super.scrollToStart();
		this.onTop();
	}
}

/** Where submitted composer text goes. */
export type SubmitRoute = "attach" | "command" | "answer" | "prompt";

/**
 * Routing order for submitted text: `/attach` first; then, with a question pending and non-empty text, the text is the
 * ANSWER unless its first token is exactly a known command (so a path like `/tmp/x` can be answered); then any other
 * `/…` is a command (unknown ones are reported by `app.command`); everything else is a prompt.
 */
export function routeSubmit(text: string, questionPending: boolean): SubmitRoute {
	if (/^\/attach(?:\s+(.*))?$/s.exec(text)) return "attach";
	const isCommand = text.startsWith("/") && COMMANDS.some((cmd) => cmd.name === text.slice(1).split(/\s+/)[0]);
	if (questionPending && text !== "") return isCommand ? "command" : "answer";
	return text.startsWith("/") ? "command" : "prompt";
}

/**
 * Idempotency key for a submission that may be retried: a failed send restores its text to the composer, so
 * resubmitting the same text must reuse the requestId (the server dedupes on it); other text gets a fresh one.
 */
export class RequestIds {
	private last: { text: string; id: string } | undefined;

	/** The id for sending `text`: the previous one when it is the same text still awaiting success, else a new one. */
	for(text: string): string {
		if (this.last?.text !== text) this.last = { text, id: randomUUID() };
		return this.last.id;
	}

	/** The send succeeded: the next submission is a new message. */
	done(): void {
		this.last = undefined;
	}
}

/** Composer drafts per session (`""` = no session open), so typing in one session never leaks into another. */
export class DraftStore {
	private readonly drafts = new Map<string, string>();

	constructor(private readonly cap = 50) {}

	/** Remember `text` for `key` (blank text forgets it); the oldest drafts beyond the cap are dropped. */
	stash(key: string, text: string): void {
		this.drafts.delete(key);
		if (text.trim() === "") return;
		this.drafts.set(key, text);
		for (const old of this.drafts.keys()) {
			if (this.drafts.size <= this.cap) break;
			this.drafts.delete(old);
		}
	}

	/** Like `stash`, but never replaces an existing draft: for text recovered from a failed send, which must not clobber what the user typed since. */
	stashIfEmpty(key: string, text: string): void {
		if (this.drafts.has(key)) return;
		this.stash(key, text);
	}

	/** Remove and return the draft for `key`. */
	take(key: string): string | undefined {
		const text = this.drafts.get(key);
		this.drafts.delete(key);
		return text;
	}
}

/** `text` cut to at most `max` code points (never inside a surrogate pair), ending in `…` when cut. */
export function shorten(text: string, max: number): string {
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

/** Backs off a failing top-of-transcript history load: no retry until the user scrolls away from the top, or `delayMs` pass. */
export class RetryGate {
	private failedAt: number | undefined;
	private away = false;

	constructor(private readonly delayMs = 8000) {}

	/** The load failed at `now`. */
	failed(now: number): void {
		this.failedAt = now;
		this.away = false;
	}

	/** The load worked. */
	ok(): void {
		this.failedAt = undefined;
	}

	/** The user scrolled off the top. */
	scrolledAway(): void {
		this.away = true;
	}

	/** Whether a load may start at `now`. */
	allows(now: number): boolean {
		return this.failedAt === undefined || this.away || now - this.failedAt >= this.delayMs;
	}
}

/** Notices when an aborted run actually stops (the abort request returns before the run does). */
export class AbortWatch {
	private at: number | undefined;

	constructor(private readonly ttlMs = 30_000) {}

	/** An abort was requested at `now`; only worth watching while the run is `running`. */
	arm(now: number, running: boolean): void {
		this.at = running ? now : undefined;
	}

	/** The abort request failed. */
	disarm(): void {
		this.at = undefined;
	}

	/** True once, the first time the run is seen stopped after `arm` (and not too long after). */
	stopped(now: number, running: boolean): boolean {
		if (this.at === undefined) return false;
		if (now - this.at > this.ttlMs) {
			this.at = undefined;
			return false;
		}
		if (running) return false;
		this.at = undefined;
		return true;
	}
}

/** A sent message awaiting the watch: `seen` is how many identical user/queued blocks already existed when it was sent. */
export type PendingEcho = { requestId: string; text: string; images: ImagePart[]; seen: number };

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

/** How many user or queued blocks carry exactly `text` (modulo outer whitespace). */
export function countUserBlocks(blocks: readonly Block[], text: string): number {
	return blocks.filter((b) => (b.kind === "user" || b.kind === "queued") && sameText(b.text, text)).length;
}

/**
 * The echoes still pending against `blocks`: one is settled (dropped) once more identical user/queued blocks exist than
 * when it was sent, so the real block never shows next to its echo. The server does not return the requestId in entries,
 * hence the text match.
 */
export function pendingEchoes(blocks: readonly Block[], echoes: readonly PendingEcho[]): PendingEcho[] {
	const counts = new Map<string, number>();
	return echoes.filter((echo) => {
		const have = counts.get(echo.text) ?? countUserBlocks(blocks, echo.text);
		counts.set(echo.text, have);
		return have <= echo.seen;
	});
}

/** The transcript block for a pending echo. */
export function echoBlock(echo: PendingEcho): PendingBlock {
	return { kind: "pending", key: `p:${echo.requestId}`, text: echo.text, ...(echo.images.length > 0 ? { images: echo.images } : {}) };
}

/**
 * Whether a watch `end` reason is final: the session is deleted/not found or its source ended. Anything else (`closed`,
 * `failed: …`, `listener_error: …`, `stopped`, `aborted`) leaves the session alive, so the socket reconnects.
 */
export function isTerminalEnd(reason: string): boolean {
	if (/^(failed|listener_error):/.test(reason)) return false;
	return /^ended$|delet|not[ _.-]?found/i.test(reason);
}

/** What the Session view shows: a session, or a worker conversation opened from its director. */
export type SessionTarget = {
	id: SessionId;
	title: string;
	worker?: { name: string; parent: SessionTarget };
};

/** The Session view: transcript replica over the watch socket, workers strip and composer. */
export class SessionScreen {
	readonly transcript = new Transcript();
	readonly strip = new WorkersStrip();
	readonly questions: QuestionPanel;
	readonly composer: Composer;
	readonly scroll: TranscriptScroll;
	target: SessionTarget | undefined;
	detail: SessionDetail | undefined;
	replica: ConversationReplica | undefined;
	workers: WorkerSummary[] = [];
	watchState: SocketState = "closed";
	/** Why the server ended the watch for good (see `isTerminalEnd`; no reconnect); cleared when the session is reopened or closed. */
	watchEnded: string | undefined;
	/** Set while ops frames are applied but not yet rebuilt: the transcript height before the first of them. */
	private dirtyFrom: number | undefined;
	private flushQueued = false;
	private watch: ReconnectingSocket<WatchFrame> | undefined;
	/** The replica whose earlier-history load is in flight (keyed by replica so a stale load never blocks another session). */
	private loadingEarlier: ConversationReplica | undefined;
	/** The in-flight answer (per target, so an answer pending in a closed session never blocks another). */
	private answering: { target: SessionTarget | undefined } | undefined;
	/** Stale guard for `refreshDetail`/`patch`: the latest detail fetch wins. */
	private detailFetch = 0;
	/** Stale guards for `refreshWorkers`: the latest fetch wins, and events newer than a fetch's start win over its result. */
	private workersFetch = 0;
	private eventSeq = 0;
	/** Numbers the images pasted with Ctrl+V (`pasted-1.png`). */
	private pasteSeq = 0;
	private readonly requestIds = new RequestIds();
	private readonly drafts = new DraftStore();
	private workerStamp = new Map<string, number>();
	/** Sent messages the watch has not delivered yet (shown as local echoes at the transcript end). */
	private echoes: PendingEcho[] = [];
	private earlierRetry = new RetryGate();
	private readonly abortWatch = new AbortWatch();
	/** Output arrived while the view was scrolled up (cleared on return to the end). */
	private newOutput = false;
	/** Whether the view was following the end when transcript navigation started, so leaving it can resume following. */
	private followBeforeSelect = true;

	constructor(private readonly app: App) {
		this.composer = new Composer(app.tui, {
			api: () => {
				try {
					return app.api();
				} catch {
					return undefined;
				}
			},
			target: () => (!this.target ? { kind: "default" } : this.target.worker ? { kind: "none" } : { kind: "session", id: this.target.id }),
		});
		this.questions = new QuestionPanel(app, () => this.target);
		this.scroll = new TranscriptScroll(
			this.transcript,
			() => this.maybeLoadEarlier(),
			() => this.earlierRetry.scrolledAway(),
		);
		this.composer.cue = () => {
			if (this.scroll.isFollowingEnd) this.newOutput = false;
			return this.newOutput ? "↓ new output" : "";
		};
		this.composer.onSubmit = (text) => this.submitted(text);
		this.transcript.setEmptyText("No session open · Ctrl+N new session · Ctrl+L or ←← sessions · Ctrl+T workspaces · ? help");
	}

	/** Watch a conversation: snapshot then ops; reconnects resume from the replica's window. */
	open(target: SessionTarget): void {
		const cur = this.target;
		// A watch that ended (`end` frame) is gone while target/replica stay: that falls through to a full reopen.
		if (cur && this.replica && this.watch && cur.id === target.id && cur.worker?.name === target.worker?.name) {
			// Re-opening what is already open: keep the transcript, scroll and expanded state; just refresh.
			void this.refreshDetail();
			void this.refreshWorkers();
			this.rebuild();
			this.app.changed();
			return;
		}
		this.stashDraft();
		this.reset();
		const client = this.app.api();
		const id = target.id;
		this.target = target;
		const replica = new ConversationReplica((query) => client.entries(id, query));
		this.replica = replica;
		this.transcript.setEmptyText("loading…");
		this.watch = new ReconnectingSocket<WatchFrame>({
			url: () => client.watchUrl(id, replica.resume),
			onFrame: (frame) => this.onFrame(replica, frame),
			onOpen: (reconnect) => {
				if (reconnect) void this.app.refresh();
				void this.refreshWorkers();
			},
			onError: (message) => {
				if (replica === this.replica) this.app.flash(`✗ ${message}`, 8000);
			},
			onState: (state, detail) => {
				if (state === "waiting" && this.watchState === "open") this.app.flash(`watch: ${detail ?? "disconnected"}`);
				this.watchState = state;
				this.app.changed();
			},
		});
		this.watch.start();
		void this.refreshDetail();
		this.rebuild();
		this.scroll.scrollToEnd();
		this.restoreDraft();
		this.app.changed();
	}

	/** Stop watching and clear the view. */
	close(): void {
		if (this.target) this.stashDraft();
		this.reset();
		this.restoreDraft();
	}

	/** Stash the composer text under the open session (or `""`) and clear the composer, ahead of switching away. */
	private stashDraft(): void {
		this.drafts.stash(this.target ? String(this.target.id) : "", this.composer.getExpandedText());
		this.composer.clearAll();
	}

	/** Put back the draft of whatever is now open (or of no session), unless the composer already has text. */
	private restoreDraft(): void {
		const draft = this.drafts.take(this.target ? String(this.target.id) : "");
		if (draft !== undefined && this.composer.getExpandedText().trim() === "") this.composer.setText(draft);
	}

	private reset(): void {
		this.watch?.close();
		this.watch = undefined;
		this.target = undefined;
		this.detail = undefined;
		this.replica = undefined;
		this.workers = [];
		this.detailFetch++;
		this.workersFetch++;
		this.workerStamp.clear();
		this.echoes = [];
		this.dirtyFrom = undefined;
		this.newOutput = false;
		this.followBeforeSelect = true;
		this.loadingEarlier = undefined;
		this.answering = undefined;
		this.earlierRetry = new RetryGate();
		this.abortWatch.disarm();
		this.scroll.clearKeep();
		this.strip.update([], undefined);
		this.watchState = "closed";
		this.watchEnded = undefined;
		this.transcript.setEmptyText("No session open · Ctrl+N new session · Ctrl+L or ←← sessions · Ctrl+T workspaces · ? help");
		this.transcript.update([]);
	}

	private onFrame(replica: ConversationReplica, frame: WatchFrame): void {
		if (replica !== this.replica) return;
		const heightBefore = this.dirtyFrom ?? this.transcript.lineCount();
		switch (frame.t) {
			case "snapshot":
				replica.snapshot(frame.value);
				this.transcript.setEmptyText("empty conversation");
				break;
			case "ops":
				try {
					replica.apply(frame.ops);
				} catch (err) {
					this.app.flash(`watch: ${(err as Error).message}; resyncing`);
					this.watch?.reconnect();
					return;
				}
				// Several ops frames in one tick (a burst after a stall) share one rebuild, run when the tick ends.
				this.dirtyFrom ??= heightBefore;
				if (!this.flushQueued) {
					this.flushQueued = true;
					queueMicrotask(() => {
						this.flushQueued = false;
						if (this.dirtyFrom !== undefined && this.replica) this.afterFrame(this.replica, this.dirtyFrom);
					});
				}
				return;
			case "end":
				this.app.flash(`watch ended: ${frame.reason}`);
				if (isTerminalEnd(frame.reason)) {
					// The server will not resume this watch, so stop the socket (it would reconnect forever and flash each cycle).
					// The transcript stays; opening the session again (no watch left) starts a fresh one.
					this.watch?.close();
					this.watch = undefined;
					this.watchEnded = frame.reason;
					this.transcript.setEmptyText(`○ watch ended: ${frame.reason}`);
				}
				// Any other reason (closed, failed: …, listener_error: …): the server closes the socket, which reconnects.
				break;
			case "pong":
				return;
		}
		this.afterFrame(replica, heightBefore);
	}

	/** Rebuild after one or more applied frames; `heightBefore` is the transcript height before the first of them. */
	private afterFrame(replica: ConversationReplica, heightBefore: number): void {
		this.dirtyFrom = undefined;
		this.rebuild();
		if (!this.scroll.isFollowingEnd && this.transcript.lineCount() > heightBefore) this.newOutput = true;
		if (this.abortWatch.stopped(Date.now(), replica.running)) this.app.flash("aborted");
		this.app.changed();
	}

	/** Re-derive transcript blocks (after ops, or when pending approvals change). */
	rebuild(): void {
		if (!this.replica || !this.target) return;
		const blocks = this.derive();
		if (!blocks) return;
		this.echoes = pendingEchoes(blocks, this.echoes);
		this.transcript.update([...blocks, ...this.echoes.map(echoBlock)]);
		this.strip.update(this.workers, this.todo());
	}

	private derive(): Block[] | undefined {
		if (!this.replica || !this.target) return undefined;
		return this.replica.blocks(this.app.pendingCalls(this.target.id), this.app.askingCalls(this.target.id));
	}

	private todo(): { done: number; total: number } | undefined {
		const items = this.replica?.view?.docs["tobor.todo"]?.items;
		if (!Array.isArray(items) || items.length === 0) return undefined;
		const done = items.filter((item) => typeof item === "object" && item !== null && "status" in item && item.status === "done").length;
		return { done, total: items.length };
	}

	/** Whether a pending approval is this session's: its own conversation, or one of its workers' (they carry the worker's conversation id). */
	private ownsApproval(approval: PendingApproval): boolean {
		const target = this.target;
		if (!target) return false;
		if (approval.conversationId === target.id) return true;
		if (target.worker) return false;
		return approval.sessionId === target.id || this.workers.some((w) => w.conversationId === approval.conversationId);
	}

	/** Session state as derived from the replica, pending approvals and live workers. */
	state(): SessionState {
		if (!this.target || !this.replica) return "idle";
		if (this.app.approvals.some((a) => this.ownsApproval(a))) return "waiting";
		if (this.replica.running) return "running";
		if (liveOf(this.replica.view?.docs).runFailure) return "failed";
		return this.workers.some((w) => w.state === "starting" || w.state === "running") ? "working" : "idle";
	}

	/** Usage of the watched conversation. */
	usage(): ViewUsage {
		return usageOf(this.replica?.view?.docs);
	}

	/** Set the composer's border label for the current mode. */
	updateLabel(): void {
		const label = !this.target
			? "no session · Enter starts one with this prompt"
			: this.questions.current()
				? "question pending · Enter answers · / commands"
				: this.target.worker
				? `worker ${this.target.worker.name} · read-only · Esc back`
				: this.state() === "running" || this.state() === "waiting"
					? "running · Enter steers · Ctrl+Q queues · Esc clears / aborts"
					: "prompt · Enter sends · Shift+Enter newline · / commands";
		this.composer.setLabel(label);
	}

	private async refreshDetail(): Promise<void> {
		const target = this.target;
		if (!target || target.worker) return;
		const fetchId = ++this.detailFetch;
		try {
			const detail = await this.app.api().session(target.id);
			if (target !== this.target || fetchId !== this.detailFetch) return;
			this.detail = detail;
			target.title = detail.title;
		} catch (err) {
			this.app.flash(`session #${target.id}: ${(err as Error).message}`);
		}
		this.app.changed();
	}

	/** Pick up a retitle (a generated title or a rename elsewhere) of the open session from a fresh session list. */
	syncTitle(sessions: readonly SessionSummary[]): void {
		const target = this.target;
		if (!target || target.worker) return;
		const title = sessions.find((s) => s.id === target.id)?.title;
		if (title === undefined || title === target.title) return;
		target.title = title;
		if (this.detail) this.detail = { ...this.detail, title };
		this.app.changed();
	}

	/** Apply a `session.updated` event: close the view when the open session was deleted, else refresh its title/detail. */
	onSessionUpdated(id: SessionId, deleted?: boolean): void {
		const target = this.target;
		if (!target || target.id !== id) return;
		if (deleted) {
			this.app.flash(`session #${id} was deleted`);
			this.close();
			this.drafts.take(String(id));
			this.app.changed();
			return;
		}
		void this.refreshDetail();
	}

	/** Refetch the workers of the open session. */
	async refreshWorkers(): Promise<void> {
		const target = this.target;
		if (!target || target.worker) return;
		const fetchId = ++this.workersFetch;
		const start = this.eventSeq;
		try {
			const fetched = await this.app.api().workers(target.id);
			if (target !== this.target || fetchId !== this.workersFetch) return;
			// Workers touched by a `worker.state` event since this fetch began keep their event-driven state.
			const newer = (id: string) => (this.workerStamp.get(id) ?? 0) > start;
			const kept = new Map(this.workers.filter((w) => newer(w.id)).map((w) => [w.id, w]));
			const merged = fetched.map((w) => kept.get(w.id) ?? w);
			for (const w of kept.values()) if (!merged.some((m) => m.id === w.id)) merged.push(w);
			this.workers = merged;
			this.rebuild();
		} catch (err) {
			if (target === this.target) this.app.flash(`workers: ${(err as Error).message}`);
		}
		this.app.changed();
	}

	/** Apply a `worker.state` event. */
	upsertWorker(sessionId: SessionId, worker: WorkerSummary): void {
		if (this.target?.id !== sessionId || this.target.worker) return;
		this.workerStamp.set(worker.id, ++this.eventSeq);
		const at = this.workers.findIndex((w) => w.id === worker.id);
		this.workers = at === -1 ? [...this.workers, worker] : this.workers.map((w, i) => (i === at ? worker : w));
		this.strip.update(this.workers, this.todo());
	}

	private submitted(text: string): void {
		const staged = this.composer.stagedImages();
		if (text === "" && staged.length === 0) return;
		if (text !== "") this.composer.addToHistory(text);
		const question = this.questions.current();
		if (question && text === "") {
			// Enter on staged images with a question open would steer them as an empty message and leave the question unanswered.
			this.app.flash("answer the question first — images stay staged");
			return;
		}
		const route = routeSubmit(text, question !== undefined);
		if (route === "attach") {
			const arg = /^\/attach(?:\s+(.*))?$/s.exec(text)?.[1] ?? "";
			this.keepOnFail(text, () => this.attach(arg.trim()));
			return;
		}
		if (route === "command") {
			this.keepOnFail(text, async () => {
				// Another flow is running: refuse loudly (the text stays in the composer) instead of dropping the command.
				if (this.app.busy) throw new Error(BUSY_MESSAGE);
				await this.app.command(text);
			});
			return;
		}
		if (route === "answer" && question) {
			this.keepOnFail(text, () => this.answerQuestion(question, text));
			return;
		}
		if (!this.target) {
			const images = [...staged];
			this.keepOnFail(text, async () => {
				const started = await startSession(this.app, text, { attachments: images.map((i) => i.attachment) });
				if (started) this.composer.unstage(images);
			});
			return;
		}
		const running = this.state() === "running" || this.state() === "waiting";
		this.keepOnFail(text, () => this.send(text, running ? "steer" : "prompt"));
	}

	/** Whether `target` is (still) what the view shows; a reopen of the same session or worker counts as the same. */
	private isCurrent(target: SessionTarget | undefined): boolean {
		const cur = this.target;
		return cur === target || (cur !== undefined && target !== undefined && cur.id === target.id && cur.worker?.name === target.worker?.name);
	}

	/** Run a flow for submitted text; if it fails (the error is flashed), put the text back unless the user has typed something new. */
	private keepOnFail(text: string, flow: () => Promise<unknown>): void {
		const submittedTo = this.target;
		this.app.guard(async () => {
			try {
				await flow();
			} catch (err) {
				// Only into the session the text was submitted to: the user may have switched away while the flow ran, in
				// which case it waits in that session's draft (unless it already has one) for when they switch back.
				if (this.isCurrent(submittedTo)) {
					if (this.composer.getExpandedText().trim() === "") this.composer.setText(text);
				} else this.drafts.stashIfEmpty(submittedTo ? String(submittedTo.id) : "", text);
				throw err;
			}
		});
	}

	/** Answer an inline question (highlighted option or typed text), then refresh so the panel moves on or collapses. */
	async answerQuestion(question: PendingQuestion, answer: string): Promise<void> {
		// Throw (not flash+return) so `keepOnFail` puts the submitted text back instead of silently dropping it.
		const target = this.target;
		if (this.answering && this.answering.target === target) throw new Error("still answering\u2026");
		const following = this.scroll.isFollowingEnd;
		const mine = { target };
		this.answering = mine;
		try {
			if (question.fields?.length) {
				// A form: collect this field; send everything only after the last one.
				const answers = this.questions.record(question, answer);
				if (!answers) return;
				await this.app.api().answer(question.callId, { answers, conversationId: question.conversationId });
				this.app.flash(`answered ${answers.length} fields`);
			} else {
				await this.app.api().answer(question.callId, { answer, conversationId: question.conversationId });
				this.app.flash(`answered: ${shorten(answer, 40)}`);
			}
		} finally {
			if (this.answering === mine) this.answering = undefined;
			// Refetch on success and failure (e.g. the question expired) so the panel self-heals.
			await this.app.refreshQuestions();
		}
		if (following && this.isCurrent(target)) this.scroll.scrollToEnd();
	}

	/** `/attach <path>` stages a local image for the next message; `/attach clear` drops the staged ones. */
	private async attach(arg: string): Promise<void> {
		const staged = this.composer.stagedImages();
		if (arg === "") throw new Error("usage: /attach <path> · /attach clear");
		if (arg === "clear") {
			this.composer.unstage();
			this.app.flash(staged.length === 0 ? "no attachments staged" : `cleared ${staged.length} attachment${staged.length === 1 ? "" : "s"}`);
			this.app.tui.requestRender();
			return;
		}
		if (staged.length >= MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message · /attach clear`);
		const image = await loadImage(arg);
		if (this.composer.stagedImages().length >= MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message · /attach clear`);
		this.composer.stage(image);
		this.app.flash(`attached ${image.name} (${this.composer.stagedImages().length}/${MAX_ATTACHMENTS}) · sent with your next message`);
		this.app.tui.requestRender();
	}

	/** Ctrl+V: stage the system clipboard's image; with no image, paste its text into the composer. */
	async pasteClipboard(): Promise<void> {
		// The limit only matters for an image: a full list must not refuse a text paste (checked again once the clipboard is read).
		const { available, image: data, text, wlPasteMissing } = await readClipboard();
		if (data) {
			const image = clipboardImage(data, this.pasteSeq + 1);
			if (this.composer.stagedImages().length >= MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message · /attach clear`);
			this.pasteSeq++;
			this.composer.stage(image);
			this.app.flash(`attached ${image.name} (${this.composer.stagedImages().length}/${MAX_ATTACHMENTS}) · sent with your next message`);
			this.app.tui.requestRender();
			return;
		}
		const pasted = text ? stripPasteMarkers(text) : "";
		if (!pasted) {
			if (!available) throw new Error(`clipboard: unavailable (no display · ${WL_CLIPBOARD_HINT})`);
			throw new Error(wlPasteMissing ? `clipboard: no image or text (${WL_CLIPBOARD_HINT} to read the Wayland clipboard)` : "clipboard: no image or text");
		}
		// The same bracketed paste the terminal layer sends, so the Editor's paste handling applies (markers stripped so the text cannot end it early).
		this.composer.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		this.app.tui.requestRender();
	}

	private async send(content: string, mode: InputMode): Promise<void> {
		const target = this.target;
		if (!target) throw new Error("no session open");
		if (target.worker) throw new Error("worker transcripts are read-only · Esc back");
		const images = [...this.composer.stagedImages()];
		const requestId = this.requestIds.for(content);
		// Local echo: shown at once, dropped when the watch delivers the message (see `pendingEchoes`) or the send fails.
		this.addEcho(requestId, content, images);
		this.scroll.scrollToEnd();
		try {
			await this.app.api().input(target.id, {
				content,
				mode,
				requestId,
				...(images.length > 0 ? { attachments: images.map((i) => i.attachment) } : {}),
			});
		} catch (err) {
			this.echoes = this.echoes.filter((e) => e.requestId !== requestId);
			if (target === this.target) this.rebuild();
			this.app.changed();
			throw err;
		}
		this.requestIds.done();
		if (mode !== "prompt") this.app.flash(mode === "steer" ? "steering…" : "queued as a follow-up");
		// The user may have switched sessions while the request ran: the composer and scroll then belong to another one.
		if (!this.isCurrent(target)) return;
		this.composer.unstage(images);
		this.scroll.scrollToEnd();
	}

	private addEcho(requestId: string, text: string, images: readonly { attachment: { data: string; mimeType: string } }[]): void {
		const blocks = this.derive();
		if (!blocks) return;
		this.echoes = this.echoes.filter((e) => e.requestId !== requestId);
		const earlier = this.echoes.filter((e) => e.text === text).length;
		this.echoes.push({ requestId, text, images: images.map((i) => ({ data: i.attachment.data, mimeType: i.attachment.mimeType })), seen: countUserBlocks(blocks, text) + earlier });
		this.rebuild();
		this.app.changed();
	}

	/** Ctrl+Q: send the composer text as a follow-up while running (a prompt when idle). */
	async queueFollowUp(): Promise<void> {
		const text = this.composer.getExpandedText().trim();
		if (text === "" && this.composer.stagedImages().length === 0) {
			this.app.flash("type the follow-up first, then Ctrl+Q");
			return;
		}
		const running = this.state() === "running" || this.state() === "waiting";
		const target = this.target;
		await this.send(text, running ? "follow_up" : "prompt");
		// Sent: clear the composer (unless the user has switched session or edited it meanwhile).
		if (this.isCurrent(target) && this.composer.getExpandedText().trim() === text) this.composer.setText("");
		if (text !== "") this.composer.addToHistory(text);
	}

	/** Ctrl+P: switch the open session to the next model of the node's list (wrapping around). */
	async cycleModel(): Promise<void> {
		if (!this.target || this.target.worker) throw new Error("open a session first");
		const { models, defaults } = await this.app.api().models();
		// Skip models whose provider has no credential (the current one stays as the cycle's anchor).
		const usable = models.filter((m) => m.available || m.ref === (this.detail?.model ?? defaults.model));
		if (usable.length === 0) return;
		const current = this.detail?.model ?? defaults.model;
		const next = usable[(usable.findIndex((m) => m.ref === current) + 1) % usable.length];
		if (!next || next.ref === current) return;
		await this.patch({ model: next.ref });
		this.app.flash(`model → ${next.ref}`);
		this.app.changed();
	}

	/** Esc: abort the run. */
	async abort(): Promise<void> {
		const target = this.target;
		if (!target) return;
		this.abortWatch.arm(Date.now(), this.replica?.running === true);
		this.app.flash("aborting…");
		try {
			await this.app.api().abort(target.id);
		} catch (err) {
			this.abortWatch.disarm();
			throw err;
		}
	}

	/** PATCH the open session, then refresh its detail and the list. */
	async patch(req: PatchSessionRequest): Promise<void> {
		const target = this.target;
		if (!target || target.worker) throw new Error("no session open");
		const fetchId = ++this.detailFetch;
		const detail = await this.app.api().patchSession(target.id, req);
		if (target === this.target && fetchId === this.detailFetch) {
			target.title = detail.title;
			this.detail = detail;
		}
		await this.app.refreshSessions();
	}

	/** Move the transcript selection; 0 enters navigation at the newest selectable block. */
	moveSelection(delta: number): boolean {
		const entering = !this.transcript.selecting;
		const following = this.scroll.isFollowingEnd;
		if (!this.transcript.moveSelection(delta)) return false;
		if (entering) this.followBeforeSelect = following;
		const line = this.transcript.selectedLine();
		if (line !== undefined) this.scroll.scrollTo(Math.max(0, line - 2), { disableFollow: true });
		this.app.tui.requestRender();
		return true;
	}

	/** Leave navigation mode; follows the end again only if the view was following it before navigation started. */
	clearSelection(): void {
		this.transcript.clearSelection();
		if (this.followBeforeSelect) this.scroll.scrollToEnd();
		this.app.tui.requestRender();
	}

	/** Enter on the selection: toggle a tool, or load history. */
	activateSelection(): void {
		const action = this.transcript.activate();
		if (action?.kind === "toggled") {
			// The block grew or shrank under the cursor: keep its first line in view.
			const line = this.transcript.selectedLine();
			if (line !== undefined) this.scroll.scrollTo(Math.max(0, line - 2), { disableFollow: true });
		} else if (action?.kind === "earlier") this.app.guard(() => this.loadEarlier());
		else if (action?.kind === "gap") {
			const replica = this.replica;
			this.app.guard(async () => {
				await replica?.fillGap(action.after, action.upTo);
				if (replica !== this.replica) return;
				this.rebuild();
				this.app.changed();
			});
		}
		this.app.tui.requestRender();
	}

	/** Load the page before the oldest entry held. */
	async loadEarlier(): Promise<void> {
		const replica = this.replica;
		if (!replica || this.loadingEarlier === replica) return;
		this.loadingEarlier = replica;
		const retry = this.earlierRetry;
		try {
			await replica.loadEarlier();
		} catch (err) {
			retry.failed(Date.now());
			throw err;
		} finally {
			if (this.loadingEarlier === replica) this.loadingEarlier = undefined;
		}
		retry.ok();
		// The session was closed or switched while the page loaded: nothing of it is on screen any more.
		if (replica !== this.replica) return;
		// The page lands above the viewport: remember how tall the content was so the view can stay on the same lines.
		const before = this.transcript.lineCount();
		this.rebuild();
		const grown = this.transcript.lineCount() - before;
		if (grown > 0) this.scroll.keepPosition(grown);
		this.app.changed();
	}

	/** Load earlier history when the transcript is scrolled to its top. */
	private maybeLoadEarlier(): void {
		if (this.replica?.items[0]?.kind !== "earlier" || !this.earlierRetry.allows(Date.now())) return;
		this.app.guard(() => this.loadEarlier());
	}
}

/** Alt+M: pick a model for the open session. */
export async function pickModel(app: App): Promise<void> {
	const s = app.session;
	if (!s.target || s.target.worker) throw new Error("open a session first");
	const { models, defaults } = await app.api().models();
	const current = s.detail?.model ?? defaults.model;
	const items = models.map((m) => ({
		value: m.ref,
		label: `${m.ref === current ? c.accent("● ") : "  "}${m.ref}`,
		description: `${m.name}${m.available ? "" : " · no credential"}${m.cost ? ` · $${m.cost.input}/$${m.cost.output} per Mtok` : ""}`,
	}));
	const picked = await app.pick("model", items, { selected: Math.max(0, models.findIndex((m) => m.ref === current)) });
	if (!picked?.value || picked.value === current) return;
	await s.patch({ model: picked.value });
	app.flash(`model: ${picked.value}`);
	app.changed();
}
