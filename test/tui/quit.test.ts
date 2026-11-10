import { describe, expect, it } from "vitest";
import { QUIT_WINDOW_MS, QuitGate } from "../../src/tui/keys.js";

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
});
