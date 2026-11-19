import { describe, expect, it } from "vitest";
import { QUIT_WINDOW_MS, QuitGate } from "../../src/tui/keys.js";
import { routeInterrupt } from "../../src/tui/router.js";

describe("QuitGate", () => {
	it("arms on the first press and quits on a second press inside the window", () => {
		const gate = new QuitGate();
		expect(gate.press(1_000)).toBe(false);
		expect(gate.press(1_000 + 300)).toBe(true);
	});

	it("re-arms instead of quitting when the second press comes too late", () => {
		const gate = new QuitGate();
		expect(gate.press(0)).toBe(false);
		expect(gate.press(QUIT_WINDOW_MS)).toBe(false);
		expect(gate.press(QUIT_WINDOW_MS + 499)).toBe(true);
	});

	it("uses a half second window", () => {
		expect(QUIT_WINDOW_MS).toBe(500);
		const gate = new QuitGate();
		gate.press(10_000);
		expect(gate.press(10_000 + 499)).toBe(true);
	});

	it("does not arm on a press made with arm = false", () => {
		const gate = new QuitGate();
		expect(gate.press(0, false)).toBe(false);
		expect(gate.press(100)).toBe(false);
		expect(gate.press(200)).toBe(true);
	});

	it("never quits on a press that does not arm, even inside the window, and disarms the gate", () => {
		const gate = new QuitGate();
		expect(gate.press(0)).toBe(false);
		expect(gate.press(100, false)).toBe(false);
		// the earlier arm is gone: the next idle press arms again instead of quitting
		expect(gate.press(200)).toBe(false);
		expect(gate.press(300)).toBe(true);
	});

	it("arm, then a modal-closing press, then idle: does not quit and re-arms", () => {
		const gate = new QuitGate();
		const press = (now: number, c: { modalOpen: boolean; composerEmpty: boolean }): boolean => gate.press(now, routeInterrupt(c).arm);
		expect(press(0, { modalOpen: false, composerEmpty: true })).toBe(false);
		expect(press(100, { modalOpen: true, composerEmpty: true })).toBe(false);
		expect(press(200, { modalOpen: false, composerEmpty: true })).toBe(false);
		expect(press(300, { modalOpen: false, composerEmpty: true })).toBe(true);
	});
});
