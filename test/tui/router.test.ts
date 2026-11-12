import { describe, expect, it } from "vitest";
import { QuitGate } from "../../src/tui/keys.js";
import { type KeyAction, type RouteContext, routeInterrupt, routeKey } from "../../src/tui/router.js";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ENTER = "\r";
const CTRL_L = "\x0c";
const CTRL_N = "\x0e";
const CTRL_D = "\x04";

const idle: RouteContext = {
	modalOpen: false,
	selecting: false,
	autocompleteOpen: false,
	composerEmpty: true,
	hasStagedImages: false,
	workerView: false,
	state: "idle",
	hasTarget: true,
	questionOptions: false,
	repeating: false,
	busy: false,
	now: 10_000,
	lastLeft: 0,
};
const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({ ...idle, ...over });
const route = (data: string, over: Partial<RouteContext> = {}): KeyAction => routeKey(data, ctx(over));

describe("routeKey: Esc priority", () => {
	it("passes while a modal is open", () => {
		expect(route(ESC, { modalOpen: true, state: "running" })).toEqual({ type: "pass" });
	});

	it("clears the transcript selection first", () => {
		expect(route(ESC, { selecting: true, state: "running", composerEmpty: false })).toEqual({ type: "clearSelection", consume: true });
	});

	it("goes back from a worker view", () => {
		expect(route(ESC, { workerView: true, state: "running" })).toEqual({ type: "backToParent" });
	});

	it("passes to the composer while its completion menu shows", () => {
		expect(route(ESC, { autocompleteOpen: true, composerEmpty: false, state: "running" })).toEqual({ type: "pass" });
	});

	it("clears a slash command without completions instead of aborting", () => {
		// '/zz': no matches, so the menu is not showing, but the composer has text.
		expect(route(ESC, { composerEmpty: false, autocompleteOpen: false, state: "running" })).toEqual({ type: "clearComposer" });
		expect(route(ESC, { composerEmpty: false, autocompleteOpen: false, state: "waiting" })).toEqual({ type: "clearComposer" });
	});

	it("Esc with the menu open closes the menu (pass); the next Esc clears the leftover text", () => {
		const open = { composerEmpty: false, autocompleteOpen: true, state: "running" } as const;
		expect(route(ESC, open)).toEqual({ type: "pass" });
		expect(route(ESC, { ...open, autocompleteOpen: false })).toEqual({ type: "clearComposer" });
	});

	it("clears text even during the async window before the menu opens, in every session state", () => {
		// The editor opens its menu asynchronously: text just typed, `autocompleteOpen` still false.
		for (const state of ["idle", "running", "waiting", "failed"] as const) {
			expect(route(ESC, { composerEmpty: false, autocompleteOpen: false, state })).toEqual({ type: "clearComposer" });
		}
	});

	it("staged images alone do not count as composer text: Esc aborts / goes up and the images stay", () => {
		// Current behavior: `composerEmpty` ignores attachments, and no action touches them.
		expect(route(ESC, { hasStagedImages: true, state: "running" })).toEqual({ type: "abort" });
		expect(route(ESC, { hasStagedImages: true })).toEqual({ type: "showSessions", up: true });
	});

	it("clears text on an idle session too", () => {
		expect(route(ESC, { composerEmpty: false })).toEqual({ type: "clearComposer" });
	});

	it("aborts a running or waiting session when the composer is empty", () => {
		expect(route(ESC, { state: "running" })).toEqual({ type: "abort" });
		expect(route(ESC, { state: "waiting" })).toEqual({ type: "abort" });
	});

	it("opens the sessions list from an idle session with an empty composer", () => {
		expect(route(ESC)).toEqual({ type: "showSessions", up: true });
		expect(route(ESC, { state: "failed" })).toEqual({ type: "showSessions", up: true });
	});

	it("passes with nothing to do", () => {
		expect(route(ESC, { hasTarget: false })).toEqual({ type: "pass" });
	});

	it("ignores an auto-repeat", () => {
		expect(route(ESC, { state: "running", repeating: true })).toEqual({ type: "consume" });
		expect(route(ESC, { workerView: true, repeating: true })).toEqual({ type: "consume" });
		expect(route(ESC, { selecting: true, repeating: true })).toEqual({ type: "consume" });
		expect(route(ESC, { composerEmpty: false, repeating: true })).toEqual({ type: "consume" });
	});
});

describe("routeKey: busy flows", () => {
	it("still aborts while a flow is active", () => {
		expect(route(ESC, { state: "running", busy: true })).toEqual({ type: "abort" });
		expect(route(ESC, { state: "waiting", busy: true })).toEqual({ type: "abort" });
	});

	it("flashes instead of silently dropping flow-opening keys", () => {
		expect(route(CTRL_N, { busy: true })).toEqual({ type: "busyFlash" });
		expect(route(CTRL_L, { busy: true })).toEqual({ type: "busyFlash" });
		expect(route("?", { busy: true })).toEqual({ type: "busyFlash" });
		expect(route(ESC, { busy: true })).toEqual({ type: "busyFlash" });
		expect(route(LEFT, { busy: true, lastLeft: 9_800 })).toEqual({ type: "busyFlash" });
	});

	it("flashes a question answer", () => {
		expect(route(ENTER, { busy: true, questionOptions: true })).toEqual({ type: "busyFlash" });
	});

	it("does not touch non-flow keys", () => {
		expect(route(ESC, { busy: true, composerEmpty: false })).toEqual({ type: "clearComposer" });
		expect(route(ESC, { busy: true, workerView: true })).toEqual({ type: "backToParent" });
		expect(route(UP, { busy: true })).toEqual({ type: "moveSelection", delta: 0 });
	});

	it("does not flash on an auto-repeat", () => {
		expect(route(CTRL_N, { busy: true, repeating: true })).toEqual({ type: "consume" });
	});
});

describe("routeKey: modals", () => {
	it("passes every key", () => {
		for (const key of [ESC, UP, DOWN, LEFT, ENTER, CTRL_L, CTRL_N, CTRL_D, "?", "a"]) {
			for (const over of [{}, { selecting: true }, { busy: true }, { state: "running" as const }, { questionOptions: true }]) {
				expect(route(key, { ...over, modalOpen: true })).toEqual({ type: "pass" });
			}
		}
	});
});

describe("routeKey: hotkeys and one-shot keys", () => {
	it("maps a hotkey", () => {
		expect(route(CTRL_N)).toEqual({ type: "hotkey", name: "newSession" });
		expect(route(CTRL_L)).toEqual({ type: "hotkey", name: "sessions" });
		expect(route("?")).toEqual({ type: "hotkey", name: "help" });
	});

	it("maps hotkeys with text in the composer, but not help/exit/navigate", () => {
		expect(route(CTRL_N, { composerEmpty: false })).toEqual({ type: "hotkey", name: "newSession" });
		expect(route("?", { composerEmpty: false })).toEqual({ type: "pass" });
		expect(route(CTRL_D, { composerEmpty: false })).toEqual({ type: "pass" });
		expect(route(UP, { composerEmpty: false })).toEqual({ type: "pass" });
	});

	it("does not fire one-shot actions on a repeat", () => {
		for (const key of [CTRL_N, CTRL_L, "?", CTRL_D]) expect(route(key, { repeating: true })).toEqual({ type: "consume" });
		expect(route(ENTER, { repeating: true, questionOptions: true })).toEqual({ type: "consume" });
	});

	it("exits on Ctrl+D with an empty composer", () => {
		expect(route(CTRL_D)).toEqual({ type: "exit" });
	});

	it("passes completion-menu keys through every other binding", () => {
		expect(route(CTRL_N, { autocompleteOpen: true, composerEmpty: false })).toEqual({ type: "pass" });
	});

	it("passes unbound keys", () => {
		expect(route("a")).toEqual({ type: "pass" });
	});
});

describe("routeKey: transcript selection", () => {
	it("navigates and activates", () => {
		expect(route(UP)).toEqual({ type: "moveSelection", delta: 0 });
		expect(route(UP, { selecting: true })).toEqual({ type: "moveSelection", delta: -1 });
		expect(route(DOWN, { selecting: true })).toEqual({ type: "moveSelection", delta: 1 });
		expect(route(ENTER, { selecting: true })).toEqual({ type: "activateSelection" });
	});

	it("keeps moving on a repeat but never activates", () => {
		expect(route(UP, { selecting: true, repeating: true })).toEqual({ type: "moveSelection", delta: -1 });
		expect(route(ENTER, { selecting: true, repeating: true })).toEqual({ type: "consume" });
	});

	it("leaves selection on any other key, which then reaches the composer", () => {
		expect(route("a", { selecting: true })).toEqual({ type: "clearSelection", consume: false });
	});
});

describe("routeKey: ←← gesture and question panel", () => {
	it("arms on the first Left and opens the sessions list on the second", () => {
		expect(route(LEFT)).toEqual({ type: "armLeft" });
		expect(route(LEFT, { lastLeft: 9_700 })).toEqual({ type: "showSessions", up: false });
		expect(route(LEFT, { lastLeft: 9_000 })).toEqual({ type: "armLeft" });
	});

	it("ignores Left with text and a repeating Left", () => {
		expect(route(LEFT, { composerEmpty: false, lastLeft: 9_900 })).toEqual({ type: "pass" });
		expect(route(LEFT, { repeating: true })).toEqual({ type: "passLeft" });
	});

	it("moves and answers the question panel only with an empty composer", () => {
		const q = { questionOptions: true };
		expect(route(UP, q)).toEqual({ type: "questionMove", delta: -1 });
		expect(route(DOWN, q)).toEqual({ type: "questionMove", delta: 1 });
		expect(route(ENTER, q)).toEqual({ type: "questionAnswer" });
		expect(route(ENTER, { ...q, hasStagedImages: true })).toEqual({ type: "pass" });
		expect(route(ENTER, { ...q, composerEmpty: false })).toEqual({ type: "pass" });
	});
});

describe("Ctrl+C", () => {
	it("closes a modal or clears the composer without arming the quit gate", () => {
		expect(routeInterrupt({ modalOpen: true, composerEmpty: true })).toEqual({ type: "closeModal", arm: false });
		expect(routeInterrupt({ modalOpen: true, composerEmpty: false })).toEqual({ type: "closeModal", arm: false });
		expect(routeInterrupt({ modalOpen: false, composerEmpty: false })).toEqual({ type: "clearComposer", arm: false });
	});

	it("arms the gate only when it had nothing to do", () => {
		expect(routeInterrupt({ modalOpen: false, composerEmpty: true })).toEqual({ type: "idle", arm: true });
	});

	const press = (gate: QuitGate, now: number, c: { modalOpen: boolean; composerEmpty: boolean }): boolean =>
		gate.press(now, routeInterrupt(c).arm);

	it("does not quit on two modal-closing presses within the window", () => {
		const gate = new QuitGate();
		expect(press(gate, 0, { modalOpen: true, composerEmpty: true })).toBe(false);
		expect(press(gate, 100, { modalOpen: true, composerEmpty: true })).toBe(false);
	});

	it("does not quit on a clear followed by an idle press, then needs two idle presses", () => {
		const gate = new QuitGate();
		expect(press(gate, 0, { modalOpen: false, composerEmpty: false })).toBe(false);
		expect(press(gate, 100, { modalOpen: false, composerEmpty: true })).toBe(false);
		expect(press(gate, 200, { modalOpen: false, composerEmpty: true })).toBe(true);
	});

	it("quits on a double press from an idle empty state", () => {
		const gate = new QuitGate();
		expect(press(gate, 0, { modalOpen: false, composerEmpty: true })).toBe(false);
		expect(press(gate, 300, { modalOpen: false, composerEmpty: true })).toBe(true);
	});
});
