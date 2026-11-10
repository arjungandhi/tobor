import { spawn } from "node:child_process";
import {
	type Component,
	decodeKittyPrintable,
	type Focusable,
	Input,
	isFocusable,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	stripTerminalSequences,
	TuiAltScreen,
	type TuiInputListenerResult,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	EventsFrame,
	NodeEvent,
	PendingApproval,
	PendingQuestion,
	SessionId,
	SessionSummary,
	WhoamiResponse,
} from "../api/types.js";
import { ApiClient, ReconnectingSocket, type SocketState } from "./client.js";
import { commandRows } from "./command-rows.js";
import { Band } from "./components/band.js";
import { StatusLine } from "./components/status.js";
import {
	baseUrl,
	type ClientConfig,
	findWorkspace,
	formatAddress,
	lastSession,
	saveClientConfig,
	setLastSession,
	type Start,
	type Workspace,
	workspaceAt,
} from "./workspaces.js";
import { COMMANDS, DOUBLE_LEFT_WINDOW_MS, HELP, KEYS, matchesBinding, QuitGate } from "./keys.js";
import { showApprovals } from "./screens/approvals.js";
import { showQuestions } from "./screens/questions.js";
import { showArtifacts } from "./screens/artifacts.js";
import { showFiles } from "./screens/files.js";
import { offerSave, showWorkspaces } from "./screens/workspaces.js";
import { showLogin } from "./screens/login.js";
import { newSession } from "./screens/new-session.js";
import { showSchedules } from "./screens/schedules.js";
import { pickModel, SessionScreen } from "./screens/session.js";
import { showSessions } from "./screens/sessions.js";
import { showSettings } from "./screens/settings.js";
import { restartNode, upgradeNode } from "./screens/upgrade.js";
import { openWorkerTranscript, showWorkers } from "./screens/workers.js";
import { c, selectListTheme } from "./theme.js";

/** A bordered modal: title, body lines, an optional interactive child, and a key-hint footer. */
export class Panel implements Component, Focusable {
	private _focused = false;
	private lines: string[];
	private readonly child: Component | undefined;
	private hint: string;
	private readonly onKey: ((data: string) => boolean) | undefined;
	private fill: (() => number) | undefined;

	constructor(
		private readonly title: string,
		options: { lines?: string[]; child?: Component; hint?: string; onKey?: (data: string) => boolean },
	) {
		this.lines = options.lines ?? [];
		this.child = options.child;
		this.hint = options.hint ?? "";
		this.onKey = options.onKey;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.child && isFocusable(this.child)) this.child.focused = value;
	}

	get capturesViewportInput(): boolean {
		return this.child?.capturesViewportInput ?? false;
	}

	/** Replace the bottom-border hint. */
	setHint(hint: string): void {
		this.hint = hint;
	}

	/** Stretch the panel to `rows()` lines (blank bordered rows between body and footer; an overlong body is cut). */
	stretch(rows: () => number): void {
		this.fill = rows;
	}

	/** Replace the body lines. */
	setLines(lines: string[]): void {
		this.lines = lines;
	}

	handleInput(data: string): void {
		if (this.onKey?.(data)) return;
		this.child?.handleInput?.(data);
	}

	invalidate(): void {
		this.child?.invalidate();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const side = c.accent("│");
		const row = (line: string): string => `${side} ${truncateToWidth(line, inner, "…", true)} ${side}`;
		const title = truncateToWidth(` ${this.title} `, Math.max(1, width - 6));
		const top = `${c.accent("╭─")}${c.bold(c.accent(title))}${c.accent(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`)}`;
		const body: string[] = [];
		for (const line of this.lines) for (const wrapped of line === "" ? [""] : wrapTextWithAnsi(line, inner)) body.push(row(wrapped));
		if (this.child) {
			if (this.lines.length > 0) body.push(row(""));
			for (const line of this.child.render(inner)) body.push(row(line));
		}
		if (this.fill) {
			const room = Math.max(1, this.fill() - 2);
			body.length = Math.min(body.length, room);
			while (body.length < room) body.push(row(""));
		}
		const out = [top, ...body];
		const hint = this.hint ? truncateToWidth(` ${this.hint} `, Math.max(1, width - 6)) : "";
		out.push(`${c.accent("╰─")}${c.dim(hint)}${c.accent(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(hint)))}╯`)}`);
		return out;
	}
}

/** `SelectItem` value prefix of a slash command row in `App.pick` (item rows have their index as value). */
const COMMAND_PREFIX = "cmd:";

/** One choice of `App.pick`. */
export type PickItem<T> = { value: T; label: string; description?: string };

/** Result of `App.pick`: the chosen value and the key that chose it (`enter` or one of `keys`); `command` is a slash command row chosen with `commands` (no value). */
export type Picked<T> = { key: string; value?: T; command?: string };

/** The TUI: owns the renderer, the active node connection, shared lists, modals and global keys. */
export class App {
	readonly terminal = new ProcessTerminal();
	readonly tui: TuiAltScreen;
	readonly band = new Band();
	readonly status = new StatusLine();
	readonly session: SessionScreen;
	client: ApiClient | undefined;
	/** Workspace connected to (for an unsaved `tobor host:port`, named after the address). */
	workspace: Workspace | undefined;
	whoami: WhoamiResponse | undefined;
	/** Local time (ms) at which `whoami` was last assigned; `now()` extrapolates the server clock from it. */
	private whoamiAt = 0;
	sessions: SessionSummary[] = [];
	approvals: PendingApproval[] = [];
	questions: PendingQuestion[] = [];
	eventsState: SocketState = "closed";
	/** True while a node restart triggered by /upgrade or /restart is awaited. */
	restarting = false;
	private events: ReconnectingSocket<EventsFrame> | undefined;
	/** Open modals, bottom to top; `cancel` dismisses one as if Esc was pressed. */
	private modals: { handle: OverlayHandle; cancel: () => void }[] = [];
	private exit: ((code: number) => void) | undefined;
	private readonly quitGate = new QuitGate();
	/** When the last bare Left press happened on an empty composer (for the ←← sessions gesture). */
	private lastLeft = 0;
	/** Generation whose initial session/picker was already opened (connect and the first events open both try). */
	private initialOpened = 0;
	private generation = 0;
	/** A modal-opening flow (hotkey or slash command) is running: further ones are ignored until it settles. */
	private flowActive = false;
	/** The key being handled is a Kitty auto-repeat: one-shot hotkeys ignore it. */
	private repeating = false;
	/** Whether the TUI was already stopped (quit or fatal error). */
	private stopped = false;
	/** Fetch/event counters per shared list: a fetch is applied only if nothing newer started or happened meanwhile. */
	private readonly sessionsSeq = { fetch: 0, event: 0 };
	private readonly approvalsSeq = { fetch: 0, event: 0 };
	private readonly onFatal = (err: unknown): void => this.fatal(err);

	constructor(
		public config: ClientConfig,
		readonly configPath: string,
		private readonly statePath: string,
	) {
		this.tui = new TuiAltScreen(this.terminal, false, undefined, { mouse: true, openUrl: openExternal });
		this.session = new SessionScreen(this);
		this.tui.setLayoutRoot(
			new VStack([
				{ component: this.band, basis: "auto" },
				{ component: this.session.scroll, basis: 0, grow: 1, minSize: 3 },
				{ component: this.session.strip, basis: "auto", shrink: 1 },
				{ component: this.session.questions, basis: "auto", shrink: 1 },
				{ component: this.session.composer, basis: "auto", shrink: 1, minSize: 3 },
				{ component: this.status, basis: "auto" },
			]),
		);
	}

	/** Start the UI on `start` (a workspace, an unsaved address or the picker); resolves with the exit code when the user quits. */
	run(start: Start, notice?: string): Promise<number> {
		const { promise, resolve } = Promise.withResolvers<number>();
		this.exit = resolve;
		process.on("uncaughtException", this.onFatal);
		process.on("unhandledRejection", this.onFatal);
		try {
			this.begin(start, notice);
		} catch (err) {
			this.stopUi();
			throw err;
		}
		return promise;
	}

	private begin(start: Start, notice: string | undefined): void {
		this.tui.addInputListener((data) => this.onInput(data));
		this.tui.setFocus(this.session.composer);
		this.tui.start();
		if (start.kind === "workspace") this.connect(start.workspace);
		else if (start.kind === "address") {
			const saved = workspaceAt(this.config, start.address);
			this.connect(saved ?? { name: formatAddress(start.address), ...start.address });
			if (!saved) {
				this.guard(async () => {
					await offerSave(this, start.address);
					this.openInitial();
				});
			}
		} else this.guard(() => showWorkspaces(this, "switch", undefined, true));
		const flash = [notice, start.kind === "picker" ? start.reason : undefined].filter(Boolean).join(" · ");
		if (flash) this.flash(flash);
		this.changed();
	}

	/** Stop sockets and the renderer once, restoring the terminal. */
	private stopUi(preserveScreen = false): void {
		process.off("uncaughtException", this.onFatal);
		process.off("unhandledRejection", this.onFatal);
		if (this.stopped) return;
		this.stopped = true;
		this.events?.close();
		this.session.close();
		this.tui.setLayoutRoot(new VStack([]));
		this.tui.stop(preserveScreen ? { preserveScreen } : {});
	}

	/** Unexpected error: restore the terminal first, then print it and exit non-zero. */
	private fatal(err: unknown): void {
		try {
			this.stopUi(true);
		} catch {}
		process.stderr.write(`tobor: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	}

	/** Leave the TUI. */
	quit(): void {
		this.stopUi();
		this.exit?.(0);
	}

	/** The server's clock now: `whoami.now` advanced by the time since it was fetched (local clock drift corrected). */
	now(): number {
		return this.whoami ? this.whoami.now + (Date.now() - this.whoamiAt) : Date.now();
	}

	/** Connect to a workspace: drop the old node's sockets and session, then load lists and open a session. */
	connect(workspace: Workspace): void {
		this.generation++;
		const generation = this.generation;
		this.events?.close();
		this.session.close();
		this.workspace = workspace;
		this.whoami = undefined;
		this.whoamiAt = 0;
		this.sessions = [];
		this.approvals = [];
		this.questions = [];
		const client = new ApiClient(baseUrl(workspace));
		this.client = client;
		this.events = new ReconnectingSocket<EventsFrame>({
			url: () => client.eventsUrl(),
			onFrame: (frame) => {
				if (frame.t === "event") this.onEvent(frame.event);
			},
			onOpen: () => {
				// Always refetch: events between the initial HTTP refresh and the socket opening are lost.
				void this.refresh().then(() => {
					if (generation === this.generation) this.openInitial();
				});
			},
			onState: (state, detail) => {
				if (state === "waiting" && this.eventsState === "open") this.flash(`events: ${detail ?? "disconnected"}`);
				this.eventsState = state;
				this.changed();
			},
		});
		this.events.start();
		void this.refresh().then(() => {
			if (generation === this.generation) this.openInitial();
		});
		this.changed();
	}

	/** Replace the client config and write it to config.yml. */
	updateConfig(config: ClientConfig): void {
		this.config = config;
		try {
			saveClientConfig(this.configPath, config);
		} catch (err) {
			this.flash(`saving ${this.configPath}: ${(err as Error).message}`);
		}
		if (this.workspace && !findWorkspace(config, this.workspace.name)) {
			// The connected workspace was removed: keep the connection, labelled by its address.
			this.workspace = { ...this.workspace, name: workspaceAt(config, this.workspace)?.name ?? formatAddress(this.workspace) };
		}
		this.changed();
	}

	/** Workspace `from` is now called `to`: relabel the connection and move its state. */
	renamedWorkspace(from: string, to: string): void {
		const last = lastSession(this.statePath, from);
		try {
			setLastSession(this.statePath, from, undefined);
			if (last !== undefined) setLastSession(this.statePath, to, last);
		} catch (err) {
			this.flash(`saving ${this.statePath}: ${(err as Error).message}`);
		}
		if (this.workspace?.name === from) this.workspace = { ...this.workspace, name: to };
		this.changed();
	}

	/** Startup chain, workspace → sessions → session: show the workspace's sessions list (Esc walks back up to the workspace picker); once per connection, never over a modal. */
	openInitial(): void {
		if (this.initialOpened === this.generation || this.session.target || this.modals.length > 0) return;
		if (!this.client || !this.whoami || !this.workspace) return;
		this.initialOpened = this.generation;
		this.guard(() => showSessions(this, false, undefined, "up"));
	}

	/** The session last opened on the connected workspace (state.json), for default cursors. */
	lastSessionId(): SessionId | undefined {
		return this.workspace ? lastSession(this.statePath, this.workspace.name) : undefined;
	}

	/** Refetch whoami, sessions, approvals and questions (on connect and after every reconnect; `/api/events` is lossy). */
	async refresh(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			// A node without `ask_user` support has no /api/questions; treat that as no questions.
			const [whoami, sessions, approvals, questions] = await Promise.all([
				client.whoami(),
				this.latest(client, () => client.sessions(), this.sessionsSeq),
				this.latest(client, () => client.approvals(), this.approvalsSeq),
				client.questions().catch(() => []),
			]);
			if (client !== this.client) return;
			this.whoami = whoami;
			this.whoamiAt = Date.now();
			if (sessions) this.sessions = sessions;
			if (approvals) this.approvals = approvals;
			this.questions = questions;
			this.session.rebuild();
		} catch (err) {
			if (client === this.client) this.flash(`${this.workspace?.name}: ${(err as Error).message}`);
		}
		this.changed();
	}

	/**
	 * Fetch a shared list; undefined when the result is stale: a newer fetch started (it will apply), or an event changed
	 * the list meanwhile (refetch, a couple of times, so the snapshot is not older than the event).
	 */
	private async latest<T>(client: ApiClient, fetch: () => Promise<T>, seq: { fetch: number; event: number }): Promise<T | undefined> {
		const mine = ++seq.fetch;
		for (let attempt = 0; ; attempt++) {
			const events = seq.event;
			const value = await fetch();
			if (mine !== seq.fetch || client !== this.client) return undefined;
			if (events === seq.event || attempt >= 2) return value;
		}
	}

	/** Open a session in the Session view and remember it for this workspace (state.json). */
	openSession(id: SessionId): void {
		const summary = this.sessions.find((s) => s.id === id);
		this.session.open({ id, title: summary?.title ?? `#${id}` });
		if (this.workspace && lastSession(this.statePath, this.workspace.name) !== id) {
			try {
				setLastSession(this.statePath, this.workspace.name, id);
			} catch (err) {
				this.flash(`saving ${this.statePath}: ${(err as Error).message}`);
			}
		}
	}

	/** Pending approvals of one conversation, by call id. */
	pendingCalls(conversationId: SessionId): Set<string> {
		return new Set(this.approvals.filter((a) => a.conversationId === conversationId).map((a) => a.callId));
	}

	/** Pending `ask_user` questions of one conversation, by call id. */
	askingCalls(conversationId: SessionId): Set<string> {
		return new Set(this.questions.filter((q) => q.conversationId === conversationId).map((q) => q.callId));
	}

	private onEvent(event: NodeEvent): void {
		switch (event.type) {
			case "approval.requested": {
				this.approvalsSeq.event++;
				const { approval } = event;
				if (!this.approvals.some((a) => a.callId === approval.callId && a.conversationId === approval.conversationId)) {
					this.approvals = [...this.approvals, approval];
				}
				const where = approval.worker ? `${approval.worker} in #${approval.sessionId}` : `#${approval.sessionId}`;
				this.notify(`approval needed: ${approval.tool} (${where})`);
				this.flash(`⚠ approval needed: ${approval.tool} (${where}) · Alt+Shift+A`);
				this.session.rebuild();
				break;
			}
			case "approval.resolved":
				this.approvalsSeq.event++;
				this.approvals = this.approvals.filter((a) => !(a.callId === event.callId && a.conversationId === event.conversationId));
				this.session.rebuild();
				break;
			case "question.asked": {
				const { question } = event;
				if (!this.questions.some((q) => q.callId === question.callId && q.conversationId === question.conversationId)) {
					this.questions = [...this.questions, question];
				}
				const where = question.worker ? `${question.worker} in #${question.sessionId}` : `#${question.sessionId}`;
				this.notify(`question from ${where}: ${question.question}`);
				this.flash(`? question from ${where} · Alt+Shift+U`);
				this.session.rebuild();
				break;
			}
			case "question.answered":
				this.questions = this.questions.filter((q) => !(q.callId === event.callId && q.conversationId === event.conversationId));
				this.session.rebuild();
				break;
			case "session.state":
				this.sessionsSeq.event++;
				this.sessions = this.sessions.map((s) => {
					if (s.id !== event.id) return s;
					const next = { ...s, state: event.state };
					if (event.failure) next.failure = event.failure;
					else delete next.failure;
					return next;
				});
				break;
			case "session.updated":
				this.session.onSessionUpdated(event.id, event.deleted);
				void this.refreshSessions().then(() => this.session.syncTitle(this.sessions));
				break;
			case "worker.state":
				this.session.upsertWorker(event.sessionId, event.worker);
				break;
			case "artifact.published":
				this.flash(`artifact published: ${event.artifact.title} (r${event.artifact.revision}) · /artifacts`);
				break;
			case "schedule.fired":
				this.flash(`schedule ${event.name}: ${event.run.status}`);
				break;
			default:
				return;
		}
		this.changed();
	}

	/** Refetch the session list only. */
	async refreshSessions(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const sessions = await this.latest(client, () => client.sessions(), this.sessionsSeq);
			if (sessions && client === this.client) this.sessions = sessions;
		} catch (err) {
			this.flash((err as Error).message);
		}
		this.changed();
	}

	/** Refetch pending approvals only. */
	async refreshApprovals(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const approvals = await this.latest(client, () => client.approvals(), this.approvalsSeq);
		if (!approvals || client !== this.client) return;
		this.approvals = approvals;
		this.session.rebuild();
		this.changed();
	}

	/** Refetch pending questions only. */
	async refreshQuestions(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const questions = await client.questions();
		if (client !== this.client) return;
		this.questions = questions;
		this.session.rebuild();
		this.changed();
	}

	/** The connected client, or an error for screens that need one. */
	api(): ApiClient {
		if (!this.client) throw new Error("no workspace selected · Ctrl+T");
		return this.client;
	}

	/** Terminal bell plus an OSC 9 desktop notification. */
	notify(text: string): void {
		this.terminal.write(`\x07\x1b]9;tobor: ${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`);
	}

	/** A transient message over the transcript. */
	flash(message: string): void {
		const text = stripTerminalSequences(message).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ");
		this.tui.flash(Array.from(text).slice(0, 300).join(""), 4000);
		this.tui.requestRender();
	}

	/** Run a screen flow, turning errors into a flash. */
	guard(flow: () => Promise<unknown>): void {
		flow().catch((err: unknown) => this.flash(`✗ ${(err as Error).message ?? String(err)}`));
	}

	/** Re-derive header, status and composer label, then render. */
	changed(): void {
		const s = this.session;
		const host = this.workspace ? this.workspace.name : c.dim("no workspace");
		const where = s.target
			? s.target.worker
				? `${s.target.worker.parent.title} ▸ worker ${s.target.worker.name}`
				: `#${s.target.id} ${s.target.title}`
			: "no session";
		const cwd = s.detail?.cwd ?? "";
		this.band.setHeader(`${c.bold(c.accent("tobor"))} ${c.dim("▸")} ${host} ${c.dim("▸")} ${where}`, c.dim(cwd));

		const conn = this.eventsState === "open" && (s.target === undefined || s.watchState === "open");
		const segments = [conn ? c.success("● connected") : c.warning(`○ ${this.eventsState === "open" ? s.watchState : this.eventsState}`)];
		if (s.target) {
			const state = s.state();
			const paint = state === "running" ? c.accent : state === "waiting" ? c.warning : state === "failed" ? c.error : state === "working" ? c.tool : c.dim;
			segments.push(paint(state));
			if (s.detail) segments.push(s.detail.model.split("/").pop() ?? s.detail.model, c.dim(s.detail.approval_mode));
			const usage = s.usage();
			segments.push(c.dim(`$${usage.cost.toFixed(4)} · ${formatTokens(usage.tokens)} tok`));
		}
		const pending = this.approvals.length;
		if (pending > 0) segments.push(c.warning(`⚠ ${pending} approval${pending === 1 ? "" : "s"} · Alt+Shift+A`));
		const asked = this.questions.length;
		if (asked > 0) segments.push(c.warning(`? ${asked} question${asked === 1 ? "" : "s"} · Alt+Shift+U`));
		if (this.restarting) segments.push(c.warning("⟳ node restarting…"));
		else if (this.whoami?.update_available && this.whoami.latest_version) segments.push(c.dim(`↑ ${this.whoami.latest_version} · /upgrade`));
		this.status.set(segments, "? help · / commands");
		s.updateLabel();
		this.tui.requestRender();
	}

	private onInput(data: string): TuiInputListenerResult {
		if (matchesKey(data, KEYS.quit)) {
			// Kitty keyboard protocol reports release/repeat as separate events; only a press counts.
			if (!isKeyRelease(data) && !isKeyRepeat(data)) this.interrupt();
			return { consume: true };
		}
		// Releases are never ours (pi-tui still sees them); matchesKey() would match them as a press.
		if (isKeyRelease(data)) return undefined;
		if (this.modals.length > 0) return undefined;
		this.repeating = isKeyRepeat(data);
		try {
			return this.handleKey(data) ? { consume: true } : undefined;
		} finally {
			this.repeating = false;
		}
	}

	/** `Ctrl+C`: the second press within the window quits from any screen; the first closes the top dialog or clears the composer. */
	private interrupt(): void {
		if (this.quitGate.press(Date.now())) return this.quit();
		const top = this.modals.at(-1);
		if (top) top.cancel();
		else this.session.composer.setText("");
		this.flash("Ctrl+C again to quit");
	}

	private handleKey(data: string): boolean {
		const s = this.session;
		const composer = s.composer;
		if (s.transcript.selecting) {
			if (matchesKey(data, "up")) s.moveSelection(-1);
			else if (matchesKey(data, "down")) s.moveSelection(1);
			else if (this.repeating) return true;
			else if (matchesKey(data, "enter")) s.activateSelection();
			else {
				s.clearSelection();
				return matchesKey(data, "escape");
			}
			return true;
		}
		if (composer.isShowingAutocomplete()) return false;
		const empty = composer.getText() === "";
		if (empty && this.answerKey(data)) return true;
		if (empty && matchesKey(data, "left")) {
			if (this.repeating) return false;
			const now = Date.now();
			if (this.lastLeft > 0 && now - this.lastLeft <= DOUBLE_LEFT_WINDOW_MS) {
				this.lastLeft = 0;
				return this.do(() => showSessions(this));
			}
			this.lastLeft = now;
			return false;
		}
		this.lastLeft = 0;
		if (matchesKey(data, KEYS.navigate) && empty) return s.moveSelection(0);
		if (matchesKey(data, KEYS.help) && empty) return this.do(() => this.help());
		if (matchesBinding(data, KEYS.exit) && empty) {
			if (!this.repeating) this.quit();
			return true;
		}
		if (matchesKey(data, KEYS.abort)) {
			if (this.repeating) return true;
			if (s.target?.worker) {
				this.openSession(s.target.worker.parent.id);
				return true;
			}
			if (s.state() === "running" || s.state() === "waiting") return this.do(() => s.abort());
			// Idle session, empty composer: one level up the hierarchy (sessions list; Esc there goes on to workspaces).
			if (s.target && empty) return this.do(() => showSessions(this, false, undefined, "up"));
			return false;
		}
		if (matchesBinding(data, KEYS.followUp)) return this.do(() => s.queueFollowUp());
		if (matchesBinding(data, KEYS.approvals)) return this.do(() => showApprovals(this));
		if (matchesBinding(data, KEYS.questions)) return this.do(() => showQuestions(this));
		if (matchesBinding(data, KEYS.workers)) return this.do(() => showWorkers(this));
		if (matchesKey(data, KEYS.workerTranscript)) return this.do(() => openWorkerTranscript(this));
		if (matchesBinding(data, KEYS.model)) return this.do(() => pickModel(this));
		if (matchesBinding(data, KEYS.modelCycle)) return this.do(() => s.cycleModel());
		if (matchesKey(data, KEYS.newSession)) return this.do(() => newSession(this));
		if (matchesKey(data, KEYS.sessions)) return this.do(() => showSessions(this));
		if (matchesKey(data, KEYS.workspaces)) return this.do(() => showWorkspaces(this));
		if (matchesKey(data, KEYS.settings)) return this.do(() => showSettings(this));
		return false;
	}

	/** Inline question panel keys (empty composer): Up/Down move the option highlight, Enter answers with it. */
	private answerKey(data: string): boolean {
		const s = this.session;
		const question = s.questions.current();
		if (!question?.options?.length) return false;
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			s.questions.move(matchesKey(data, "up") ? -1 : 1);
			this.tui.requestRender();
			return true;
		}
		if (matchesKey(data, "enter") && s.composer.stagedImages().length === 0) {
			const answer = s.questions.selectedOption();
			if (answer === undefined) return false;
			return this.do(() => s.answerQuestion(question, answer));
		}
		return false;
	}

	/** Hotkey dispatch: swallows the key; ignores auto-repeats and anything while another flow is running. */
	private do(flow: () => Promise<unknown>): true {
		if (!this.repeating) this.guard(() => this.exclusive(flow));
		return true;
	}

	/** Run `flow` unless another exclusive one is active (modals open only after network calls, so `modals` alone is no guard). */
	private exclusive(flow: () => Promise<unknown>): Promise<unknown> {
		if (this.flowActive) return Promise.resolve();
		this.flowActive = true;
		return new Promise((resolve) => resolve(flow())).finally(() => {
			this.flowActive = false;
		});
	}

	/** Run a slash command typed into the composer. */
	async command(line: string): Promise<void> {
		await this.exclusive(() => this.runCommand(line));
	}

	private async runCommand(line: string): Promise<void> {
		const [name = "", ...rest] = line.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const s = this.session;
		switch (name) {
			case "sessions":
				return showSessions(this);
			case "new":
				return newSession(this);
			case "approvals":
				return showApprovals(this);
			case "questions":
				return showQuestions(this);
			case "workers":
				return showWorkers(this);
			case "model":
				return pickModel(this);
			case "artifacts":
				if (arg && arg !== "all") throw new Error("usage: /artifacts [all]");
				return showArtifacts(this, arg === "all" ? "all" : undefined);
			case "schedules":
				return showSchedules(this);
			case "files":
				return showFiles(this);
			case "login":
				return showLogin(this);
			case "workspace":
				return showWorkspaces(this);
			case "settings":
				return showSettings(this);
			case "upgrade":
				return upgradeNode(this);
			case "restart":
				return restartNode(this);
			case "help":
				return this.help();
			case "quit":
				return this.quit();
			case "title":
				if (!arg) throw new Error("usage: /title <title>");
				return s.patch({ title: arg });
			case "archive":
			case "complete":
				await s.patch({ archived: true });
				this.session.close();
				await this.refreshSessions();
				return showSessions(this);
			case "approval": {
				if (arg !== "ask" && arg !== "auto") throw new Error("usage: /approval ask|auto");
				if (arg === "auto" && !(await this.confirmAuto("approval mode", "Switch this session to auto? Tools will run without asking."))) return;
				return s.patch({ approval_mode: arg });
			}
			default:
				throw new Error(`unknown command /${name} · /help`);
		}
	}

	private async help(): Promise<void> {
		const width = Math.max(...HELP.map(([key]) => key.length));
		const lines = [
			...HELP.map(([key, what]) => `${c.accent(key.padEnd(width))}  ${what}`),
			"",
			`${c.accent("commands")}  ${c.dim(COMMANDS.map((cmd) => `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`).join("  "))}`,
		];
		await this.info("help", lines);
	}

	/**
	 * Show a modal and focus it; `cancel` dismisses it as Esc would (used by `Ctrl+C`). Returns a function that closes it.
	 * Every modal is full-screen: a 100% × 100% overlay at the top-left; a Panel stretches to the terminal height, so
	 * every viewport cell is painted and no transcript shows through.
	 */
	openModal(component: Component, cancel: () => void): () => void {
		if (component instanceof Panel) component.stretch(() => this.terminal.rows);
		const handle = this.tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left" });
		this.modals.push({ handle, cancel });
		this.tui.requestRender();
		return () => {
			handle.hide();
			this.modals = this.modals.filter((m) => m.handle !== handle);
			if (this.modals.length === 0) this.tui.setFocus(this.session.composer);
			this.tui.requestRender();
		};
	}

	/** Rows available for a list inside a full-screen modal with `extra` other lines (border, footer and the gap above the list take 4). */
	listRows(extra: number): number {
		return Math.max(3, this.terminal.rows - 4 - extra);
	}

	/** A list modal. Resolves with the chosen value and key (`enter` or one of `keys`), or undefined on Esc. On an empty list, `keys` resolve without a value. */
	pick<T>(
		title: string,
		items: PickItem<T>[],
		options: { lines?: string[]; hint?: string; keys?: string[]; selected?: number; commands?: boolean } = {},
	): Promise<Picked<T> | undefined> {
		const { promise, resolve } = Promise.withResolvers<Picked<T> | undefined>();
		const entries: SelectItem[] = items.map((item, i) => ({
			value: String(i),
			label: item.label,
			...(item.description === undefined ? {} : { description: item.description }),
		}));
		const rows = (): number => this.listRows(options.lines?.length ?? 0);
		let close = (): void => {};
		const finish = (result: Picked<T> | undefined): void => {
			close();
			resolve(result);
		};
		const chosen = (key: string): void => {
			const item = list.getSelectedItem();
			if (item?.value.startsWith(COMMAND_PREFIX)) return finish({ key, command: item.value.slice(COMMAND_PREFIX.length) });
			if (!item && items.length > 0) return; // a filter without matches: Enter does nothing
			const picked = item ? items[Number(item.value)] : undefined;
			finish(picked ? { key, value: picked.value } : items.length === 0 ? { key } : undefined);
		};
		// SelectList has no setItems and its setFilter is a prefix match on value, so a filter rebuilds the list from
		// the matching entries; their values stay the original indexes, so a choice maps back to `items`.
		const makeList = (shown: SelectItem[]): SelectList => {
			const next = new SelectList(shown, rows(), selectListTheme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 48 });
			next.onSelect = () => chosen("enter");
			next.onCancel = () => finish(undefined);
			return next;
		};
		let list = makeList(entries);
		if (options.selected !== undefined) list.setSelectedIndex(options.selected);
		const child: Component = {
			get capturesViewportInput() {
				return list.capturesViewportInput;
			},
			render: (width) => list.render(width),
			handleInput: (data) => list.handleInput(data),
			handleMouse: (event) => list.handleMouse(event),
			invalidate: () => list.invalidate(),
		};
		const baseHint = `${options.hint ?? "Enter select · Esc close"}${items.length === 0 ? "" : options.commands ? " · / filter or command" : " · / filter"}`;
		let query: string | undefined;
		const refilter = (): void => {
			if (query === undefined) {
				list = makeList(entries);
				panel.setHint(baseHint);
			} else {
				const needle = query.toLowerCase();
				const matches = entries.filter((e) => stripTerminalSequences(`${e.label} ${e.description ?? ""}`).toLowerCase().includes(needle));
				const cmds: SelectItem[] = options.commands
					? commandRows(query).map((cmd) => ({ value: `${COMMAND_PREFIX}${cmd.name}`, label: c.accent(`/${cmd.name}`), description: cmd.description }))
					: [];
				list = makeList([...cmds, ...matches]);
				panel.setHint(`/${query}▏ · Enter select · Esc ${query === "" ? "close" : "clear filter"}`);
			}
			this.tui.requestRender();
		};
		const panel = new Panel(title, {
			lines: items.length === 0 ? [...(options.lines ?? []), c.dim("(none)")] : (options.lines ?? []),
			child: items.length === 0 ? undefined : child,
			hint: items.length === 0 ? (options.hint ?? "Enter select · Esc close") : baseHint,
			onKey: (data) => {
				if (items.length === 0 && (matchesKey(data, "enter") || matchesKey(data, "escape"))) {
					finish(undefined);
					return true;
				}
				if (query !== undefined) {
					if (matchesKey(data, "escape")) {
						if (query === "") finish(undefined);
						else {
							query = undefined;
							refilter();
						}
						return true;
					}
					if (matchesKey(data, "backspace")) {
						query = query.slice(0, -1);
						refilter();
						return true;
					}
					const unpasted = data.replace(/\x1b\[20[01]~/g, "");
					const typed =
						unpasted !== data
							? unpasted.replace(/[\x00-\x1f\x7f-\x9f]/g, " ") // bracketed paste: one chunk, newlines become spaces
							: /^[^\x00-\x1f\x7f-\x9f]+$/.test(data)
								? data
								: decodeKittyPrintable(data);
					if (typed && !isKeyRelease(data)) {
						query += typed;
						refilter();
						return true;
					}
					return false;
				}
				if (items.length > 0 && data === "/") {
					query = "";
					refilter();
					return true;
				}
				const key = options.keys?.find((k) => data === k);
				if (key === undefined) return items.length === 0;
				chosen(key);
				return true;
			},
		});
		close = this.openModal(panel, () => finish(undefined));
		return promise;
	}

	/** A one-line text prompt. Resolves with the text (possibly empty), or undefined on Esc. */
	ask(title: string, options: { lines?: string[]; initial?: string; placeholder?: string; hint?: string } = {}): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const input = new Input(options.placeholder ? { placeholder: options.placeholder, placeholderStyle: c.dim } : {});
		if (options.initial) {
			input.setValue(options.initial);
			input.handleInput("\x05"); // Ctrl+E: cursor to the end
		}
		let close = (): void => {};
		const finish = (value: string | undefined): void => {
			close();
			resolve(value);
		};
		input.onSubmit = (value) => finish(value);
		input.onEscape = () => finish(undefined);
		const panel = new Panel(title, {
			lines: options.lines ?? [],
			child: input,
			hint: options.hint ?? "Enter confirm · Esc cancel",
		});
		close = this.openModal(panel, () => finish(undefined));
		return promise;
	}

	/** A yes/no question. */
	async confirm(title: string, lines: string[]): Promise<boolean> {
		const picked = await this.pick(
			title,
			[
				{ value: false, label: "no" },
				{ value: true, label: "yes" },
			],
			{ lines },
		);
		return picked?.value === true;
	}

	/** Confirm switching to auto approval, unless the `confirm_auto` preference is off. */
	async confirmAuto(title: string, question: string): Promise<boolean> {
		return this.config.prefs?.confirm_auto === false || this.confirm(title, [question]);
	}

	/** A read-only message; resolves when closed. */
	info(title: string, lines: string[]): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		let close = (): void => {};
		const done = (): void => {
			close();
			resolve();
		};
		const panel = new Panel(title, {
			lines,
			hint: "Enter/Esc close",
			onKey: (data) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === "q") done();
				return true;
			},
		});
		close = this.openModal(panel, done);
		return promise;
	}

	/** Suspend the UI around a foreground child process such as `$EDITOR`. */
	async suspend<T>(fn: () => T | Promise<T>): Promise<T> {
		this.tui.stop({ preserveScreen: true });
		try {
			return await fn();
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}
}

function openExternal(url: string): void {
	const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

/** `12.3k`-style token count. */
export function formatTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
