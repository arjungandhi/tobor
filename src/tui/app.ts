import { spawn } from "node:child_process";
import {
	type Component,
	decodeKittyPrintable,
	Editor,
	type Focusable,
	Input,
	isFocusable,
	isKeyRelease,
	isKeyRepeat,
	type KeyId,
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
	ApprovalMode,
	EventsFrame,
	NodeEvent,
	PatchSessionRequest,
	PendingApproval,
	PendingQuestion,
	SessionId,
	SessionSummary,
	WhoamiResponse,
} from "../api/types.js";
import { ApiClient, ApiRequestError, ReconnectingSocket, type SocketState } from "./client.js";
import { commandRows } from "./command-rows.js";
import { Band } from "./components/band.js";
import { FLASH_MS, type Progress, type Severity, severityOf, StatusLine, StatusSlot } from "./components/status.js";
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
import { busyMessage, COMMANDS, flowLabel, HELP, HELP_PROVIDED, hotkeyHint, isModalHotkey, KEYS, keyLabel, matchesBinding, QUIT_WINDOW_MS, QuitGate } from "./keys.js";
import { indexOfValue, pickHint } from "./pick-model.js";
import { type HotkeyName, routeInterrupt, routeKey } from "./router.js";
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
import { c, editorTheme, selectListTheme } from "./theme.js";

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

/** Status text: no escape sequences or control characters, one line, at most 300 characters. */
function cleanStatusText(message: string): string {
	const text = stripTerminalSequences(message).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ");
	return Array.from(text).slice(0, 300).join("");
}

/** `SelectItem` value prefix of a slash command row in `App.pick` (item rows have their index as value). */
/** Backoff before retry number `failures` (0-based) of a failed refresh: 2s, 4s, 8s, … capped at 30s. */
export function refreshRetryDelay(failures: number): number {
	return Math.min(2000 * 2 ** Math.max(0, failures), 30_000);
}

const COMMAND_PREFIX = "cmd:";

/** Set when a slash command is run from the sessions list: `sessionId` is the highlighted row (undefined on an empty list). */
export type CommandFrom = { sessionId?: number };

/** Commands that act on one session. From the sessions list they must target the highlighted row, never the open session. */
const SESSION_SCOPED = new Set(["title", "archive", "complete", "approval", "model", "workers"]);
/** The scoped commands that can take a target id; the others (/model, /workers) are rejected from the list. */
const LIST_TARGETABLE = new Set(["title", "archive", "complete", "approval"]);

/** One choice of `App.pick`. */
export type PickItem<T> = { value: T; label: string; description?: string };

/** Result of `App.pick`: the chosen value and the key that chose it (`enter` or one of `keys`); `command` is a slash command row chosen with `commands`, and its `value` is the row that was highlighted when the filter started (so a command can act on it). */
export type Picked<T> = { key: string; value?: T; command?: string };

/** The TUI: owns the renderer, the active node connection, shared lists, modals and global keys. */
export class App {
	readonly terminal = new ProcessTerminal();
	readonly tui: TuiAltScreen;
	readonly band = new Band();
	readonly status = new StatusLine();
	/** The single status slot (flashes replace each other, progress sticks); painted by `status`. */
	private readonly slot = new StatusSlot();
	private slotTimer: ReturnType<typeof setTimeout> | undefined;
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
	/** Why the events socket is not open (last retry detail); cleared when it opens. */
	eventsDetail: string | undefined;
	/** The events socket has been open on this connection. */
	private eventsEverOpen = false;
	/** An open events socket dropped and has not reopened yet (so the next open is a reconnect worth announcing). */
	private eventsLost = false;
	/** The first-connect failure was already flashed for this connection. */
	private connectFailureShown = false;
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
	/** A modal-opening flow (hotkey or slash command) is running: further ones are refused until it settles or detaches. */
	private flowActive = false;
	/** Names the running flow in the busy message (`approvals`, `/settings`). */
	private flowName: string | undefined;
	/** Bumped by `detachFlow`, so a detached flow's settling does not release a lock a later flow took. */
	private flowEpoch = 0;
	/** Lock-free hotkeys currently running: a second press of the same one is ignored until it settles. */
	private readonly inFlight = new Set<string>();
	/** The key being handled is a Kitty auto-repeat: one-shot hotkeys ignore it. */
	private repeating = false;
	/** Whether the TUI was already stopped (quit or fatal error). */
	private stopped = false;
	/** Fetch/event counters per shared list: a fetch is applied only if nothing newer started or happened meanwhile. */
	private readonly sessionsSeq = { fetch: 0, event: 0 };
	private readonly approvalsSeq = { fetch: 0, event: 0 };
	private readonly questionsSeq = { fetch: 0, event: 0 };
	/** The last questions fetch failed (the previous list was kept). */
	private questionsFailing = false;
	/** The questions fetch failure was already flashed (reset on the next success: one flash per outage). */
	private questionsErrorShown = false;
	/** Pending retry of a failed `refresh`, the number of failures in a row (backoff step), and whether the failure was already flashed. */
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshFailures = 0;
	private refreshErrorShown = false;
	/** The UI is up (set at the end of `begin`): from then on a stray promise rejection is shown, not fatal. */
	private started = false;
	private readonly onFatal = (err: unknown): void => this.fatal(err);
	private readonly onRejection = (reason: unknown): void => {
		if (!this.started || this.stopped) return this.fatal(reason);
		this.flash(`✗ unhandled error: ${reason instanceof Error ? reason.message : String(reason)}`, 8000);
	};

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
		process.on("unhandledRejection", this.onRejection);
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
		} else this.guard(() => showWorkspaces(this));
		const flash = [notice, start.kind === "picker" ? start.reason : undefined].filter(Boolean).join(" · ");
		if (flash) this.flash(flash);
		this.changed();
		this.started = true;
	}

	/** Stop sockets and the renderer once, restoring the terminal. */
	private stopUi(preserveScreen = false): void {
		process.off("uncaughtException", this.onFatal);
		process.off("unhandledRejection", this.onRejection);
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.slotTimer);
		this.cancelRefreshRetry();
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

	/** Leave the TUI (restoring the terminal); `run` resolves with `code`. */
	quit(code = 0): void {
		this.stopUi();
		this.exit?.(code);
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
		this.cancelRefreshRetry();
		this.refreshFailures = 0;
		this.refreshErrorShown = false;
		this.session.close();
		this.workspace = workspace;
		this.whoami = undefined;
		this.whoamiAt = 0;
		this.eventsDetail = undefined;
		this.eventsEverOpen = false;
		this.eventsLost = false;
		this.connectFailureShown = false;
		this.sessions = [];
		this.approvals = [];
		this.questions = [];
		this.questionsFailing = false;
		this.questionsErrorShown = false;
		const client = new ApiClient(baseUrl(workspace));
		this.client = client;
		let firstOpen = true;
		this.events = new ReconnectingSocket<EventsFrame>({
			url: () => client.eventsUrl(),
			onFrame: (frame) => {
				if (frame.t === "event") this.onEvent(frame.event);
				// The node dropped events for this slow client: refetch everything, as after a reconnect.
				else if (frame.t === "resync" && generation === this.generation) void this.refresh();
			},
			onOpen: () => {
				if (generation !== this.generation) return;
				// connect() already started this connection's first refresh; every later open is a reconnect (events were lost).
				if (firstOpen) {
					firstOpen = false;
					return;
				}
				void this.refresh();
			},
			onState: (state, detail) => {
				if (generation !== this.generation) return; // the old connection's socket closing
				if (state === "waiting") {
					if (this.eventsState === "open") {
						this.eventsLost = true;
						this.flash(`events: ${detail ?? "disconnected"}`);
					} else if (!this.eventsEverOpen && !this.connectFailureShown) {
						this.connectFailureShown = true;
						this.flash(`✗ cannot reach ${this.workspace?.name ?? "the node"}: ${detail ?? "connection failed"}`, 8000);
					}
					this.eventsDetail = detail;
				} else if (state === "open") {
					this.eventsEverOpen = true;
					this.eventsDetail = undefined;
					if (this.eventsLost) {
						this.eventsLost = false;
						this.flash("reconnected");
					}
				}
				this.eventsState = state;
				this.changed();
			},
		});
		this.events.start();
		void this.refresh();
		this.changed();
	}

	/** Replace the client config and write it to config.yml. */
	updateConfig(config: ClientConfig): void {
		this.config = config;
		try {
			saveClientConfig(this.configPath, config);
		} catch (err) {
			this.flash(`✗ saving ${this.configPath}: ${(err as Error).message}`);
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
			this.flash(`✗ saving ${this.statePath}: ${(err as Error).message}`);
		}
		if (this.workspace?.name === from) this.workspace = { ...this.workspace, name: to };
		this.changed();
	}

	/** Startup chain, workspace → sessions → session: show the workspace's sessions list (Esc/← walks back up to the workspace picker); once per connection, never over a modal (it is retried when the modals close and when a flow ends: see `retryInitial`). */
	openInitial(): void {
		if (this.initialOpened === this.generation || this.session.target || this.modals.length > 0) return;
		if (!this.client || !this.whoami || !this.workspace) return;
		this.initialOpened = this.generation;
		this.guard(() => showSessions(this));
	}

	/** Try `openInitial` again once the current tick's flow had its chance to open the next dialog; only when nothing is open or running. */
	private retryInitial(): void {
		setTimeout(() => {
			if (this.stopped || this.modals.length > 0 || this.flowActive) return;
			this.openInitial();
		}, 0);
	}

	/** The session last opened on the connected workspace (state.json), for default cursors. */
	lastSessionId(): SessionId | undefined {
		return this.workspace ? lastSession(this.statePath, this.workspace.name) : undefined;
	}

	private cancelRefreshRetry(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	/**
	 * Refetch whoami, sessions, approvals and questions (on connect, after every reconnect and on a `resync` frame;
	 * `/api/events` is lossy). A failure is retried with capped backoff until one succeeds, and opens the initial view once it has.
	 */
	async refresh(): Promise<void> {
		const client = this.client;
		if (!client) return;
		this.cancelRefreshRetry();
		let failure: string | undefined;
		try {
			const [whoami, sessions, approvals, questions] = await Promise.all([
				client.whoami(),
				this.latest(client, () => client.sessions(), this.sessionsSeq),
				this.latest(client, () => client.approvals(), this.approvalsSeq),
				this.fetchQuestions(client),
			]);
			if (client !== this.client) return;
			this.whoami = whoami;
			this.whoamiAt = Date.now();
			if (sessions) this.sessions = sessions;
			if (approvals) this.approvals = approvals;
			if (questions) this.questions = questions;
			this.session.rebuild();
			// A failed questions fetch kept the old list and flashed itself; the refresh still has to be retried.
			if (this.questionsFailing) failure = "";
		} catch (err) {
			if (client !== this.client) return;
			failure = `✗ ${this.workspace?.name}: ${(err as Error).message}`;
		}
		if (client !== this.client) return;
		if (failure === undefined) {
			this.refreshFailures = 0;
			this.refreshErrorShown = false;
		} else {
			if (failure && !this.refreshErrorShown) {
				this.refreshErrorShown = true;
				this.flash(failure);
			}
			if (!this.stopped) this.refreshTimer = setTimeout(() => void this.refresh(), refreshRetryDelay(this.refreshFailures++));
		}
		this.changed();
		this.openInitial();
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

	/**
	 * Fetch the pending questions through the staleness guard. Undefined means "keep the current list": the result is
	 * stale, or the fetch failed (flashed once per outage, never turned into "no questions"). A node without `ask_user`
	 * support has no /api/questions (404): that is no questions.
	 */
	private async fetchQuestions(client: ApiClient): Promise<PendingQuestion[] | undefined> {
		try {
			const questions = await this.latest(
				client,
				() =>
					client.questions().catch((err: unknown) => {
						if (err instanceof ApiRequestError && err.status === 404) return [];
						throw err;
					}),
				this.questionsSeq,
			);
			if (questions && client === this.client) {
				this.questionsFailing = false;
				this.questionsErrorShown = false;
			}
			return questions;
		} catch (err) {
			if (client !== this.client) return undefined;
			this.questionsFailing = true;
			if (!this.questionsErrorShown) {
				this.questionsErrorShown = true;
				this.flash(`✗ questions: ${(err as Error).message}`);
			}
			return undefined;
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
				this.flash(`✗ saving ${this.statePath}: ${(err as Error).message}`);
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
				this.flash(`⚠ approval needed: ${approval.tool} (${where}) · ${keyLabel("approvals")}`);
				this.session.rebuild();
				break;
			}
			case "approval.resolved":
				this.approvalsSeq.event++;
				this.approvals = this.approvals.filter((a) => !(a.callId === event.callId && a.conversationId === event.conversationId));
				this.session.rebuild();
				break;
			case "question.asked": {
				this.questionsSeq.event++;
				const { question } = event;
				if (!this.questions.some((q) => q.callId === question.callId && q.conversationId === question.conversationId)) {
					this.questions = [...this.questions, question];
				}
				const where = question.worker ? `${question.worker} in #${question.sessionId}` : `#${question.sessionId}`;
				this.notify(`question from ${where}: ${question.question}${question.fields?.length ? ` (${question.fields.length} fields)` : ""}`);
				this.flash(`? question from ${where} · ${keyLabel("questions")}`);
				this.session.rebuild();
				break;
			}
			case "question.answered":
				this.questionsSeq.event++;
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
			this.flash(`✗ ${(err as Error).message}`);
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

	/** Refetch pending questions only. Never throws: a failure keeps the current list and is flashed once. */
	async refreshQuestions(): Promise<void> {
		const client = this.client;
		if (!client) return;
		const questions = await this.fetchQuestions(client);
		if (!questions || client !== this.client) return;
		this.questions = questions;
		this.session.rebuild();
		this.changed();
	}

	/** The connected client, or an error for screens that need one. */
	api(): ApiClient {
		if (!this.client) throw new Error(`no workspace selected · ${keyLabel("workspaces")}`);
		return this.client;
	}

	/** Terminal bell plus an OSC 9 desktop notification. */
	notify(text: string): void {
		this.terminal.write(`\x07\x1b]9;tobor: ${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`);
	}

	/**
	 * A transient message in the status line. One at a time: a new message replaces the current one. `✗ `-prefixed
	 * messages are errors (override with `severity`). Sticky progress (`progress`) is not replaced by it.
	 */
	flash(message: string, durationMs = FLASH_MS, severity?: Severity): void {
		const text = cleanStatusText(message);
		this.slot.flash(text, severity ?? severityOf(text), durationMs);
		this.changed();
		this.scheduleSlotExpiry();
	}

	/**
	 * A sticky status entry (`label`) that stays until `done()`, however many flashes come and go meanwhile; the newest
	 * live one is shown. `update(label)` changes the text; `done(message?)` ends it and optionally flashes `message`
	 * (a `✗ ` prefix makes it an error). Both are no-ops after `done`.
	 */
	progress(label: string): Progress {
		const inner = this.slot.progress(cleanStatusText(label));
		this.changed();
		return {
			update: (next) => {
				inner.update(cleanStatusText(next));
				this.changed();
			},
			done: (message) => {
				inner.done(message === undefined ? undefined : typeof message === "string" ? cleanStatusText(message) : { ...message, text: cleanStatusText(message.text) });
				this.changed();
				this.scheduleSlotExpiry();
			},
		};
	}

	/** Repaint when the transient message runs out. */
	private scheduleSlotExpiry(): void {
		clearTimeout(this.slotTimer);
		this.slotTimer = undefined;
		const left = this.slot.expiresIn();
		if (left === undefined || this.stopped) return;
		this.slotTimer = setTimeout(() => {
			this.slotTimer = undefined;
			this.changed();
		}, left + 5);
		this.slotTimer.unref();
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
		const segments = [conn ? c.success("● connected") : c.warning(`○ ${this.connectionText(s.watchState)}`)];
		if (s.target) {
			const state = s.state();
			const paint = state === "running" ? c.accent : state === "waiting" ? c.warning : state === "failed" ? c.error : state === "working" ? c.tool : c.dim;
			segments.push(paint(state));
			if (s.detail) segments.push(s.detail.model.split("/").pop() ?? s.detail.model, c.dim(s.detail.approval_mode));
			const usage = s.usage();
			segments.push(c.dim(`$${usage.cost.toFixed(4)} · ${formatTokens(usage.tokens)} tok`));
		}
		const pending = this.approvals.length;
		if (pending > 0) segments.push(c.warning(`⚠ ${pending} approval${pending === 1 ? "" : "s"} · ${keyLabel("approvals")}`));
		const asked = this.questions.length;
		if (asked > 0) segments.push(c.warning(`? ${asked} question${asked === 1 ? "" : "s"} · ${keyLabel("questions")}`));
		if (this.whoami?.update_available && this.whoami.latest_version) segments.push(c.dim(`↑ ${this.whoami.latest_version} · /upgrade`));
		this.status.set(segments, `${hotkeyHint("help")} · / commands`, this.slot.view());
		s.updateLabel();
		this.tui.requestRender();
	}

	/** Status text of a connection that is not fully up: the events socket's state and retry detail, else the session watch's state. */
	private connectionText(watchState: string): string {
		switch (this.eventsState) {
			case "open":
				return watchState;
			case "waiting":
				return `reconnecting${this.eventsDetail ? ` — ${this.eventsDetail}` : ""}`;
			case "connecting":
				return this.eventsDetail === undefined ? "connecting…" : "reconnecting…";
			default:
				return this.eventsState;
		}
	}

	private onInput(data: string): TuiInputListenerResult {
		if (matchesBinding(data, KEYS.quit)) {
			// Kitty keyboard protocol reports release/repeat as separate events; only a press counts.
			if (!isKeyRelease(data) && !isKeyRepeat(data)) this.interrupt();
			return { consume: true };
		}
		// Releases are never ours (pi-tui still sees them); matchesKey() would match them as a press.
		if (isKeyRelease(data)) return undefined;
		this.repeating = isKeyRepeat(data);
		try {
			return this.handleKey(data) ? { consume: true } : undefined;
		} finally {
			this.repeating = false;
		}
	}

	/** Nothing typed and nothing attached: Esc / Ctrl+C / Ctrl+D then act on the session instead of the composer. */
	private composerEmpty(): boolean {
		const composer = this.session.composer;
		return composer.getText() === "" && composer.stagedImages().length === 0;
	}

	/** Empty the composer: the text and the staged image attachments. */
	private clearComposer(): void {
		this.session.composer.clearAll();
	}

	/** `Ctrl+C`: closes the top dialog or clears the composer (and disarms the quit gate); only a press with nothing to do arms it, and a second such press within the window quits. */
	private interrupt(): void {
		const top = this.modals.at(-1);
		const action = routeInterrupt({ modalOpen: top !== undefined, composerEmpty: this.composerEmpty() });
		const quit = this.quitGate.press(Date.now(), action.arm);
		if (action.type === "closeModal") top?.cancel();
		else if (action.type === "clearComposer") this.clearComposer();
		else if (quit) this.quit();
		else this.flash("Ctrl+C again to quit", QUIT_WINDOW_MS);
	}

	/** Thin interpreter: snapshot the state, let the router decide (`router.ts`), run the action. True when the key is consumed. */
	private handleKey(data: string): boolean {
		const s = this.session;
		const composer = s.composer;
		const action = routeKey(data, {
			modalOpen: this.modals.length > 0,
			selecting: s.transcript.selecting,
			autocompleteOpen: composer.isShowingAutocomplete(),
			composerEmpty: this.composerEmpty(),
			hasStagedImages: composer.stagedImages().length > 0,
			workerView: s.target?.worker !== undefined,
			state: s.state(),
			hasTarget: s.target !== undefined,
			questionOptions: s.questions.options().length > 0,
			repeating: this.repeating,
			now: Date.now(),
			lastLeft: this.lastLeft,
		});
		if (action.type === "armLeft") this.lastLeft = Date.now();
		else if (action.type !== "passLeft") this.lastLeft = 0;
		switch (action.type) {
			case "pass":
			case "armLeft":
			case "passLeft":
				return false;
			case "consume":
				return true;
			case "moveSelection":
				// Entering (0) may fail and then passes through; while navigating, Up/Down must not leak to composer history.
				return s.moveSelection(action.delta) || action.delta !== 0;
			case "activateSelection":
				s.activateSelection();
				return true;
			case "clearSelection":
				s.clearSelection();
				return action.consume;
			case "questionMove":
				s.questions.move(action.delta);
				this.tui.requestRender();
				return true;
			case "questionAnswer": {
				const question = s.questions.current();
				const answer = s.questions.selectedOption();
				if (!question || answer === undefined) return false;
				return this.do("answering the question", () => s.answerQuestion(question, answer));
			}
			case "clearComposer":
				this.clearComposer();
				return true;
			case "backToParent":
				if (s.target?.worker) this.openSession(s.target.worker.parent.id);
				return true;
			case "abort":
				// Not via do(): an abort must not be dropped because another flow is running.
				this.guard(() => s.abort());
				return true;
			case "showSessions":
				return this.do("sessions", () => showSessions(this));
			case "hotkey": {
				const name = action.name;
				if (isModalHotkey(name)) return this.do(flowLabel(name), () => this.hotkey(name));
				return this.inPlace(name);
			}
			case "exit":
				this.quit();
				return true;
		}
	}

	private hotkey(name: HotkeyName): Promise<unknown> {
		const s = this.session;
		switch (name) {
			case "followUp":
				return s.queueFollowUp();
			case "approvals":
				return showApprovals(this);
			case "questions":
				return showQuestions(this);
			case "workers":
				return showWorkers(this);
			case "workerTranscript":
				return openWorkerTranscript(this);
			case "model":
				return pickModel(this);
			case "modelCycle":
				return s.cycleModel();
			case "pasteImage":
				return s.pasteClipboard();
			case "newSession":
				return newSession(this);
			case "sessions":
				return showSessions(this);
			case "workspaces":
				return showWorkspaces(this);
			case "settings":
				return showSettings(this);
			case "help":
				return this.help();
		}
	}

	/** Dialog-opening hotkey dispatch: swallows the key; ignores auto-repeats; flashes the busy message (naming the running flow) while another flow holds the lock. */
	private do(label: string, flow: () => Promise<unknown>): true {
		if (this.repeating) return true;
		if (this.flowActive) this.flash(busyMessage(this.flowName));
		else this.guard(() => this.exclusive(label, flow));
		return true;
	}

	/** A hotkey that opens no dialog (follow-up, next model, paste): runs guarded but without the flow lock; a repeat press waits for the first to settle. */
	private inPlace(name: HotkeyName): true {
		if (this.repeating || this.inFlight.has(name)) return true;
		this.inFlight.add(name);
		this.guard(async () => {
			try {
				await this.hotkey(name);
			} finally {
				this.inFlight.delete(name);
			}
		});
		return true;
	}

	/** Run `flow` under the flow lock (modals open only after network calls, so `modals` alone is no guard); `label` names it in the busy message. Refuses while another holds the lock. */
	private async exclusive(label: string, flow: () => Promise<unknown>): Promise<unknown> {
		if (this.flowActive) throw new Error(busyMessage(this.flowName));
		this.flowActive = true;
		this.flowName = label;
		const epoch = this.flowEpoch;
		try {
			return await flow();
		} finally {
			if (epoch === this.flowEpoch) {
				this.flowActive = false;
				this.flowName = undefined;
				this.retryInitial();
			}
		}
	}

	/**
	 * Release the flow lock from inside the running flow, which carries on (a long wait that opens no dialog, such as the
	 * node restart wait of /upgrade: hotkeys and commands must work meanwhile). Show what it waits for with `progress`.
	 */
	detachFlow(): void {
		this.flowEpoch++;
		this.flowActive = false;
		this.flowName = undefined;
	}

	/** Whether a modal-opening flow is running (hotkeys and composer commands are refused meanwhile). */
	get busy(): boolean {
		return this.flowActive;
	}

	/** Run a slash command typed into the composer. */
	async command(line: string, from?: CommandFrom): Promise<void> {
		await this.exclusive(`/${line.slice(1).split(/\s+/)[0] ?? ""}`, () => this.runCommand(line, from));
	}

	/**
	 * Run a slash command as a continuation of the flow already running, e.g. one chosen from a picker that flow opened.
	 * Only call from within an exclusive flow: `command` would see `flowActive` and silently drop it. A flow started
	 * outside `exclusive` (startup) gets the normal guarded `command`, so the command still holds the flow lock.
	 * `from` is set by the sessions list: session-scoped commands then act on `from.sessionId` (the highlighted row),
	 * never on the open session.
	 */
	async continueCommand(line: string, from?: CommandFrom): Promise<void> {
		if (!this.flowActive) return this.command(line, from);
		await this.runCommand(line, from);
	}

	private async runCommand(line: string, from?: CommandFrom): Promise<void> {
		const [name = "", ...rest] = line.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const s = this.session;
		if (from && SESSION_SCOPED.has(name)) {
			if (from.sessionId === undefined) throw new Error(`/${name}: no session highlighted`);
			if (!LIST_TARGETABLE.has(name)) throw new Error(`/${name} works on the open session: open the session first`);
			return this.commandOnListed(name, arg, from.sessionId);
		}
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
			case "approval": {
				const target = s.target;
				if (!target || target.worker) throw new Error("no session open");
				return this.editSession(name, arg, { label: "this session", title: target.title, mode: s.detail?.approval_mode, patch: (req) => s.patch(req) });
			}
			case "archive":
			case "complete":
				await s.patch({ archived: true });
				this.session.close();
				await this.refreshSessions();
				return showSessions(this);
			default:
				throw new Error(`unknown command /${name} · /help`);
		}
	}

	/** A session-scoped command chosen from the sessions list, applied to the highlighted session (which need not be the open one). */
	private async commandOnListed(name: string, arg: string, id: number): Promise<void> {
		const patch = async (req: PatchSessionRequest): Promise<void> => {
			await this.api().patchSession(id, req);
			await this.refreshSessions();
		};
		switch (name) {
			case "title":
			case "approval": {
				const summary = this.sessions.find((x) => x.id === id);
				const open = this.session.target?.id === id ? this.session : undefined;
				return this.editSession(name, arg, {
					label: `#${id}`,
					title: summary?.title ?? open?.target?.title ?? "",
					mode: summary?.approval_mode ?? open?.detail?.approval_mode,
					patch,
				});
			}
			case "archive":
			case "complete":
				await patch({ archived: true });
				if (this.session.target?.id === id) this.session.close();
				return; // the sessions list is still open and re-shows itself
		}
	}

	/**
	 * /title and /approval on one session, shared by the open session and the sessions list. Without an argument (always the
	 * case from a list row) /title asks for the new title and /approval picks the mode; Esc or an empty title cancels.
	 */
	private async editSession(
		name: "title" | "approval",
		arg: string,
		target: { label: string; title: string; mode: ApprovalMode | undefined; patch: (req: PatchSessionRequest) => Promise<void> },
	): Promise<void> {
		if (name === "title") {
			const title = arg || (await this.ask(`rename ${target.label}`, { initial: target.title }))?.trim();
			if (!title) return;
			return target.patch({ title });
		}
		let mode: string | undefined = arg;
		if (!mode) {
			const picked = await this.pick(
				`${target.label} · approval mode`,
				(["ask", "auto"] as const).map((value) => ({ value, label: value })),
				{ selected: target.mode === "auto" ? 1 : 0 },
			);
			mode = picked?.value;
			if (!mode) return;
		}
		if (mode !== "ask" && mode !== "auto") throw new Error("usage: /approval ask|auto");
		if (mode === "auto" && !(await this.confirmAuto("approval mode", `Switch ${target.label} to auto? Tools will run without asking.`))) return;
		return target.patch({ approval_mode: mode });
	}

	private async help(): Promise<void> {
		const width = Math.max(...[...HELP, ...HELP_PROVIDED].map(([key]) => key.length));
		const row = ([key, what]: readonly [string, string]): string => `${c.accent(key.padEnd(width))}  ${what}`;
		const lines = [
			...HELP.map(row),
			"",
			c.dim("provided by the terminal / pi-tui"),
			...HELP_PROVIDED.map(row),
			"",
			`${c.accent("commands")}  ${c.dim(COMMANDS.map((cmd) => `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`).join("  "))}`,
		];
		await this.info("help", lines);
	}

	/**
	 * Show a modal and focus it; `cancel` dismisses it as Esc would (used by `Ctrl+C`). Returns a function that closes it.
	 * Every modal is a full-width overlay at the top-left; a Panel stretches to the terminal height minus the status row,
	 * so no transcript shows through and the status line (messages, progress) stays visible and is never painted over.
	 */
	openModal(component: Component, cancel: () => void): () => void {
		if (component instanceof Panel) component.stretch(() => Math.max(1, this.terminal.rows - 1));
		const handle = this.tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left" });
		this.modals.push({ handle, cancel });
		this.tui.requestRender();
		return () => {
			handle.hide();
			this.modals = this.modals.filter((m) => m.handle !== handle);
			if (this.modals.length === 0) {
				this.tui.setFocus(this.session.composer);
				this.retryInitial();
			}
			this.tui.requestRender();
		};
	}

	/** Rows available for a list inside a modal with `extra` other lines (border, footer, the gap above the list and the status row take 5). */
	listRows(extra: number): number {
		return Math.max(3, this.terminal.rows - 5 - extra);
	}

	/**
	 * A list modal. Resolves with the chosen value and key (`enter` or one of `keys`), or undefined on Esc. On an empty list, `keys` resolve without a value; Enter does nothing.
	 * `keys` entries are a single character (matched literally) or a named key id such as "left" / "right" (matched with `matchesKey`).
	 * `/` starts a filter, which keeps the selected row while it is still shown; Esc clears the filter, a second Esc closes the list.
	 * `emptyHint` is the footer of an empty list (default "Esc back"; name the `keys` that still work there).
	 * The list follows terminal resizes: it is rebuilt at the new height with the selected row kept.
	 */
	pick<T>(
		title: string,
		items: PickItem<T>[],
		options: { lines?: string[]; hint?: string; emptyHint?: string; keys?: string[]; selected?: number; commands?: boolean } = {},
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
			if (item?.value.startsWith(COMMAND_PREFIX)) return finish({ key, command: item.value.slice(COMMAND_PREFIX.length), ...(anchor === undefined ? {} : { value: anchor }) });
			if (!item && items.length > 0) return; // a filter without matches: Enter does nothing
			const picked = item ? items[Number(item.value)] : undefined;
			finish(picked ? { key, value: picked.value } : items.length === 0 ? { key } : undefined);
		};
		// SelectList has no setItems and its setFilter is a prefix match on value, so a filter rebuilds the list from
		// the matching entries; their values stay the original indexes, so a choice maps back to `items`.
		let shown = entries;
		/** The item row highlighted when the filter started: what a slash command chosen from the filter acts on. */
		let anchor: T | undefined;
		let builtRows = rows();
		const makeList = (): SelectList => {
			const next = new SelectList(shown, builtRows, selectListTheme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 48 });
			next.onSelect = () => chosen("enter");
			next.onCancel = () => finish(undefined);
			return next;
		};
		let list = makeList();
		if (options.selected !== undefined) list.setSelectedIndex(options.selected);
		/** Show `next` rows at the current terminal height, keeping the selected row when it is still shown (a filter changed, or a resize). */
		const rebuild = (next: SelectItem[]): void => {
			const previous = list.getSelectedItem()?.value;
			shown = next;
			builtRows = rows();
			list = makeList();
			list.setSelectedIndex(indexOfValue(shown, previous));
		};
		const child: Component = {
			get capturesViewportInput() {
				return list.capturesViewportInput;
			},
			render: (width) => {
				if (rows() !== builtRows) rebuild(shown); // the terminal was resized: a shrink must not hide the selected row
				return list.render(width);
			},
			handleInput: (data) => list.handleInput(data),
			handleMouse: (event) => list.handleMouse(event),
			invalidate: () => list.invalidate(),
		};
		const hintFor = (filter: string | undefined): string =>
			pickHint({ itemCount: items.length, query: filter, hint: options.hint ?? "Enter select · Esc close", emptyHint: options.emptyHint ?? "Esc back", commands: options.commands === true });
		let query: string | undefined;
		const refilter = (): void => {
			if (query === undefined) rebuild(entries);
			else {
				const needle = query.toLowerCase();
				const matches = entries.filter((e) => stripTerminalSequences(`${e.label} ${e.description ?? ""}`).toLowerCase().includes(needle));
				const cmds: SelectItem[] = options.commands
					? commandRows(query).map((cmd) => ({ value: `${COMMAND_PREFIX}${cmd.name}`, label: c.accent(`/${cmd.name}`), description: cmd.description }))
					: [];
				rebuild([...cmds, ...matches]);
			}
			panel.setHint(hintFor(query));
			this.tui.requestRender();
		};
		const panel = new Panel(title, {
			lines: items.length === 0 ? [...(options.lines ?? []), c.dim("(none)")] : (options.lines ?? []),
			child: items.length === 0 ? undefined : child,
			hint: hintFor(undefined),
			onKey: (data) => {
				if (items.length === 0 && (matchesKey(data, "enter") || matchesKey(data, "escape"))) {
					if (matchesKey(data, "escape")) finish(undefined); // Enter on an empty list does nothing
					return true;
				}
				if (query !== undefined) {
					if (matchesKey(data, "escape")) {
						query = undefined; // Esc leaves the filter first, even an empty one; only the next Esc closes the list
						refilter();
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
					const at = list.getSelectedItem();
					anchor = at && !at.value.startsWith(COMMAND_PREFIX) ? items[Number(at.value)]?.value : undefined;
					query = "";
					refilter();
					return true;
				}
				const key = options.keys?.find((k) => (k.length === 1 ? data === k : matchesKey(data, k as KeyId)));
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

	/** A multi-line text prompt. Enter saves, Shift+Enter inserts a newline; resolves with the text (possibly empty), or undefined on Esc. */
	askMultiline(title: string, options: { lines?: string[]; initial?: string; hint?: string } = {}): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		if (options.initial) editor.setText(options.initial);
		let close = (): void => {};
		const finish = (value: string | undefined): void => {
			close();
			resolve(value);
		};
		editor.onSubmit = (value) => finish(value);
		const panel = new Panel(title, {
			lines: options.lines ?? [],
			child: editor,
			hint: options.hint ?? "Enter save · Shift+Enter newline · Esc cancel",
			onKey: (data) => {
				if (!matchesKey(data, "escape")) return false;
				finish(undefined);
				return true;
			},
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
