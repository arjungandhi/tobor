import { randomUUID } from "node:crypto";
import { type Component, ScrollView } from "@earendil-works/pi-tui";
import type {
	InputMode,
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
import { Transcript } from "../components/transcript.js";
import { BUSY_MESSAGE, COMMANDS } from "../keys.js";
import { ConversationReplica, liveOf, usageOf, type ViewUsage } from "../replica.js";
import { c } from "../theme.js";
import { startSession } from "./new-session.js";
import { WorkersStrip } from "./workers.js";

/** The transcript's primary scroll view; scrolling up into its top calls `onTop` (to load earlier history). */
class TranscriptScroll extends ScrollView {
	constructor(
		content: Component,
		private readonly onTop: () => void,
	) {
		super(content, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	}

	override scrollBy(lines: number): number {
		const remaining = super.scrollBy(lines);
		if (lines < 0 && this.scrollTop === 0) this.onTop();
		return remaining;
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

	/** Remove and return the draft for `key`. */
	take(key: string): string | undefined {
		const text = this.drafts.get(key);
		this.drafts.delete(key);
		return text;
	}
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
	private watch: ReconnectingSocket<WatchFrame> | undefined;
	private loadingEarlier = false;
	private answering = false;
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
		this.scroll = new TranscriptScroll(this.transcript, () => this.maybeLoadEarlier());
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
		this.composer.setText("");
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
		this.strip.update([], undefined);
		this.watchState = "closed";
		this.transcript.setEmptyText("No session open · Ctrl+N new session · Ctrl+L or ←← sessions · Ctrl+T workspaces · ? help");
		this.transcript.update([]);
	}

	private onFrame(replica: ConversationReplica, frame: WatchFrame): void {
		if (replica !== this.replica) return;
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
				break;
			case "end":
				this.app.flash(`watch ended: ${frame.reason}`);
				if (/delet|not.found/i.test(frame.reason)) {
					this.watch?.close();
					this.watch = undefined;
				}
				break;
			case "pong":
				return;
		}
		this.rebuild();
		this.app.changed();
	}

	/** Re-derive transcript blocks (after ops, or when pending approvals change). */
	rebuild(): void {
		if (!this.replica || !this.target) return;
		this.transcript.update(this.replica.blocks(this.app.pendingCalls(this.target.id), this.app.askingCalls(this.target.id)));
		this.strip.update(this.workers, this.todo());
	}

	private todo(): { done: number; total: number } | undefined {
		const items = this.replica?.view?.docs["tobor.todo"]?.items;
		if (!Array.isArray(items) || items.length === 0) return undefined;
		const done = items.filter((item) => typeof item === "object" && item !== null && "status" in item && item.status === "done").length;
		return { done, total: items.length };
	}

	/** Session state as derived from the replica, pending approvals and live workers. */
	state(): SessionState {
		if (!this.target || !this.replica) return "idle";
		if (this.app.approvals.some((a) => a.conversationId === this.target?.id)) return "waiting";
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
					? "running · Enter steers · Ctrl+Q queues a follow-up · Esc clears / aborts when empty"
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

	/** Run a flow for submitted text; if it fails (the error is flashed), put the text back unless the user has typed something new. */
	private keepOnFail(text: string, flow: () => Promise<unknown>): void {
		this.app.guard(async () => {
			try {
				await flow();
			} catch (err) {
				if (this.composer.getExpandedText().trim() === "") this.composer.setText(text);
				throw err;
			}
		});
	}

	/** Answer an inline question (highlighted option or typed text), then refresh so the panel moves on or collapses. */
	async answerQuestion(question: PendingQuestion, answer: string): Promise<void> {
		// Throw (not flash+return) so `keepOnFail` puts the submitted text back instead of silently dropping it.
		if (this.answering) throw new Error("still answering\u2026");
		this.answering = true;
		try {
			if (question.fields?.length) {
				// A form: collect this field; send everything only after the last one.
				const answers = this.questions.record(question, answer);
				if (!answers) return;
				await this.app.api().answer(question.callId, { answers, conversationId: question.conversationId });
				this.app.flash(`answered ${answers.length} fields`);
			} else {
				await this.app.api().answer(question.callId, { answer, conversationId: question.conversationId });
				this.app.flash(`answered: ${answer.length > 40 ? `${answer.slice(0, 39)}…` : answer}`);
			}
		} finally {
			this.answering = false;
			// Refetch on success and failure (e.g. the question expired) so the panel self-heals.
			await this.app.refreshQuestions();
		}
		this.scroll.scrollToEnd();
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
		if (this.composer.stagedImages().length >= MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message · /attach clear`);
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
		await this.app.api().input(target.id, {
			content,
			mode,
			requestId: this.requestIds.for(content),
			...(images.length > 0 ? { attachments: images.map((i) => i.attachment) } : {}),
		});
		this.requestIds.done();
		this.composer.unstage(images);
		if (mode !== "prompt") this.app.flash(mode === "steer" ? "steering…" : "queued as a follow-up");
		this.scroll.scrollToEnd();
	}

	/** Ctrl+Q: send the composer text as a follow-up while running (a prompt when idle). */
	async queueFollowUp(): Promise<void> {
		const text = this.composer.getExpandedText().trim();
		if (text === "" && this.composer.stagedImages().length === 0) {
			this.app.flash("type the follow-up first, then Ctrl+Q");
			return;
		}
		const running = this.state() === "running" || this.state() === "waiting";
		await this.send(text, running ? "follow_up" : "prompt");
		// Sent: clear the composer (unless the user has already edited it meanwhile).
		if (this.composer.getExpandedText().trim() === text) this.composer.setText("");
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
		this.app.flash("aborting…");
		await this.app.api().abort(target.id);
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
		if (!this.transcript.moveSelection(delta)) return false;
		const line = this.transcript.selectedLine();
		if (line !== undefined) this.scroll.scrollTo(Math.max(0, line - 2), { disableFollow: true });
		this.app.tui.requestRender();
		return true;
	}

	/** Leave navigation mode and follow the end again. */
	clearSelection(): void {
		this.transcript.clearSelection();
		this.scroll.scrollToEnd();
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
				this.rebuild();
				this.app.changed();
			});
		}
		this.app.tui.requestRender();
	}

	/** Load the page before the oldest entry held. */
	async loadEarlier(): Promise<void> {
		const replica = this.replica;
		if (!replica || this.loadingEarlier) return;
		this.loadingEarlier = true;
		try {
			await replica.loadEarlier();
		} finally {
			this.loadingEarlier = false;
		}
		this.rebuild();
		this.app.changed();
	}

	/** Load earlier history when the transcript is scrolled to its top. */
	private maybeLoadEarlier(): void {
		if (this.replica?.items[0]?.kind !== "earlier") return;
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
