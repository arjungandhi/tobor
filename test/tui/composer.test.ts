import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Composer } from "../../src/tui/components/composer.js";
import type { StagedImage } from "../../src/tui/attachments.js";

const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } } as never;
const source = { api: () => undefined, target: () => ({ kind: "none" as const }) };
const image = (name: string): StagedImage => ({ name, bytes: 1, attachment: { type: "image", data: "AA==", mimeType: "image/png" } });
const top = (composer: Composer, width = 80): string => stripTerminalSequences(composer.render(width).find((l) => l.includes("──")) ?? "");

describe("Composer", () => {
	it("clearAll empties the text and unstages every image", () => {
		const composer = new Composer(tui, source);
		composer.setText("hello");
		composer.stage(image("a.png"));
		composer.stage(image("b.png"));
		composer.clearAll();
		expect(composer.getExpandedText()).toBe("");
		expect(composer.stagedImages()).toEqual([]);
	});

	it("draws the cue right-aligned in the top border within the width, keeping it when the label is long", () => {
		const composer = new Composer(tui, source);
		composer.setLabel("running · Enter steers · Ctrl+Q queues · Esc clears / aborts");
		expect(top(composer)).not.toContain("new output");
		composer.cue = () => "↓ new output";
		for (const width of [80, 50, 30]) {
			const line = top(composer, width);
			expect(line).toContain("↓ new output");
			expect(visibleWidth(line)).toBe(width);
		}
		expect(top(composer, 80)).toMatch(/↓ new output ─$/);
		composer.cue = () => "";
		expect(top(composer)).not.toContain("new output");
	});
});
