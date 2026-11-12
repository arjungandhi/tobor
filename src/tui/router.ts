import { matchesKey } from "@earendil-works/pi-tui";
import type { SessionState } from "../api/types.js";
import { DOUBLE_LEFT_WINDOW_MS, KEYS, matchesBinding } from "./keys.js";

/** Hotkeys that open a flow (usually a modal); the interpreter maps each to its screen. */
export type HotkeyName =
	| "followUp"
	| "approvals"
	| "questions"
	| "workers"
	| "workerTranscript"
	| "model"
	| "modelCycle"
	| "newSession"
	| "sessions"
	| "workspaces"
	| "settings"
	| "help";

/** What the key router decided; executed by `App.handleKey`. */
export type KeyAction =
	/** Not ours: the focused component (composer, modal) handles the key. */
	| { type: "pass" }
	/** Swallow the key and do nothing (auto-repeat of a one-shot key). */
	| { type: "consume" }
	/** Left on an empty composer that did not complete the ←← gesture: remember the time, let the composer see it. */
	| { type: "armLeft" }
	/** A repeating Left: not ours, and it must not disturb the ←← gesture. */
	| { type: "passLeft" }
	/** Transcript selection: move by `delta` (0 enters navigation at the newest block). */
	| { type: "moveSelection"; delta: -1 | 0 | 1 }
	| { type: "activateSelection" }
	/** Leave transcript selection; `consume` is false when the key should also reach the composer. */
	| { type: "clearSelection"; consume: boolean }
	/** Inline question panel: move the highlight / answer with it. */
	| { type: "questionMove"; delta: -1 | 1 }
	| { type: "questionAnswer" }
	/** Esc: empty the composer. */
	| { type: "clearComposer" }
	/** Esc in a worker transcript: back to the director. */
	| { type: "backToParent" }
	/** Abort the running session (never gated by flows). */
	| { type: "abort" }
	/** Open the sessions list; `up` makes Esc there continue to the workspaces. */
	| { type: "showSessions"; up: boolean }
	| { type: "hotkey"; name: HotkeyName }
	/** A flow-opening key while another flow runs: tell the user instead of dropping it silently. */
	| { type: "busyFlash" }
	| { type: "exit" };

/** Everything the router needs to know; a plain snapshot, so routing is a pure function. */
export type RouteContext = {
	/** A modal is open: it handles its own keys. */
	modalOpen: boolean;
	/** The transcript is in block-selection mode. */
	selecting: boolean;
	/** The composer's completion menu is showing (async editor state: never trust it alone for destructive keys). */
	autocompleteOpen: boolean;
	composerEmpty: boolean;
	/** Staged attachments (Enter on the question panel then belongs to the composer). */
	hasStagedImages: boolean;
	/** A worker transcript is open. */
	workerView: boolean;
	state: SessionState;
	/** A session (or worker transcript) is open. */
	hasTarget: boolean;
	/** The inline question panel has options to pick from. */
	questionOptions: boolean;
	/** The key is a Kitty auto-repeat. */
	repeating: boolean;
	/** Another modal-opening flow is running. */
	busy: boolean;
	/** `Date.now()` and when the last bare Left on an empty composer happened (0: none). */
	now: number;
	lastLeft: number;
};

/** Hotkey bindings in dispatch order. */
const HOTKEYS: readonly (readonly [HotkeyName, (data: string) => boolean])[] = [
	["followUp", (d) => matchesBinding(d, KEYS.followUp)],
	["approvals", (d) => matchesBinding(d, KEYS.approvals)],
	["questions", (d) => matchesBinding(d, KEYS.questions)],
	["workers", (d) => matchesBinding(d, KEYS.workers)],
	["workerTranscript", (d) => matchesKey(d, KEYS.workerTranscript)],
	["model", (d) => matchesBinding(d, KEYS.model)],
	["modelCycle", (d) => matchesBinding(d, KEYS.modelCycle)],
	["newSession", (d) => matchesKey(d, KEYS.newSession)],
	["sessions", (d) => matchesKey(d, KEYS.sessions)],
	["workspaces", (d) => matchesKey(d, KEYS.workspaces)],
	["settings", (d) => matchesKey(d, KEYS.settings)],
];

/** A flow-opening key: ignored when repeating, flashed while another flow runs, else `action`. */
function flow(ctx: RouteContext, action: KeyAction): KeyAction {
	if (ctx.repeating) return { type: "consume" };
	return ctx.busy ? { type: "busyFlash" } : action;
}

/**
 * Esc, in strict priority order: modal (its own) → transcript selection → worker view back → open completion menu
 * (the composer closes it) → text in the composer (clear it, never abort) → abort a running session → one level up
 * (sessions list) from an idle session → the composer.
 */
function routeEscape(ctx: RouteContext): KeyAction {
	if (ctx.selecting) return ctx.repeating ? { type: "consume" } : { type: "clearSelection", consume: true };
	if (ctx.repeating) return { type: "consume" };
	if (ctx.workerView) return { type: "backToParent" };
	if (ctx.autocompleteOpen) return { type: "pass" };
	if (!ctx.composerEmpty) return { type: "clearComposer" };
	if (ctx.state === "running" || ctx.state === "waiting") return { type: "abort" };
	if (ctx.hasTarget) return flow(ctx, { type: "showSessions", up: true });
	return { type: "pass" };
}

/** Decide what a key press does. Pure: no side effects, no UI types. */
export function routeKey(data: string, ctx: RouteContext): KeyAction {
	if (ctx.modalOpen) return { type: "pass" };
	if (matchesKey(data, KEYS.abort)) return routeEscape(ctx);
	if (ctx.selecting) {
		if (matchesKey(data, "up")) return { type: "moveSelection", delta: -1 };
		if (matchesKey(data, "down")) return { type: "moveSelection", delta: 1 };
		if (ctx.repeating) return { type: "consume" };
		if (matchesKey(data, "enter")) return { type: "activateSelection" };
		return { type: "clearSelection", consume: false };
	}
	if (ctx.autocompleteOpen) return { type: "pass" };
	const empty = ctx.composerEmpty;
	if (empty && ctx.questionOptions) {
		if (matchesKey(data, "up")) return { type: "questionMove", delta: -1 };
		if (matchesKey(data, "down")) return { type: "questionMove", delta: 1 };
		if (matchesKey(data, "enter") && !ctx.hasStagedImages) return flow(ctx, { type: "questionAnswer" });
	}
	if (empty && matchesKey(data, "left")) {
		if (ctx.repeating) return { type: "passLeft" };
		if (ctx.lastLeft > 0 && ctx.now - ctx.lastLeft <= DOUBLE_LEFT_WINDOW_MS) return flow(ctx, { type: "showSessions", up: false });
		return { type: "armLeft" };
	}
	if (empty && matchesKey(data, KEYS.navigate)) return { type: "moveSelection", delta: 0 };
	if (empty && matchesKey(data, KEYS.help)) return flow(ctx, { type: "hotkey", name: "help" });
	if (empty && matchesBinding(data, KEYS.exit)) return ctx.repeating ? { type: "consume" } : { type: "exit" };
	for (const [name, matches] of HOTKEYS) if (matches(data)) return flow(ctx, { type: "hotkey", name });
	return { type: "pass" };
}

/** What `Ctrl+C` does: close the top dialog, clear the composer, or nothing. Only "nothing" arms the quit gate. */
export type InterruptAction = { type: "closeModal" | "clearComposer" | "idle"; arm: boolean };

export function routeInterrupt(ctx: { modalOpen: boolean; composerEmpty: boolean }): InterruptAction {
	if (ctx.modalOpen) return { type: "closeModal", arm: false };
	if (!ctx.composerEmpty) return { type: "clearComposer", arm: false };
	return { type: "idle", arm: true };
}
