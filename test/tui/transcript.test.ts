import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { argsSummary, ToolSlotView, wrapTail } from "../../src/tui/components/tool-slot.js";
import { Transcript } from "../../src/tui/components/transcript.js";
import type { Block, ToolBlock } from "../../src/tui/replica.js";
import { pdfPath } from "../../src/tui/screens/artifacts.js";
import { fieldRows, parseTiming } from "../../src/tui/screens/schedules.js";

const plain = (lines: string[]): string[] => lines.map((line) => stripTerminalSequences(line).trimEnd());

function tool(overrides: Partial<ToolBlock> = {}): ToolBlock {
	return { kind: "tool", key: "t:1", callId: "1", name: "bash", args: { command: "make test" }, status: "running", output: "", ...overrides };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Transcript", () => {
	const base: Block[] = [
		{ kind: "earlier", key: "earlier" },
		{ kind: "user", key: "u:1", text: "hello" },
		{ kind: "assistant", key: "a:2:0", text: "first answer", streaming: false },
		tool(),
		{ kind: "assistant", key: "live:0", text: "stream", streaming: true },
	];

	it("renders a queued message dimmed with a marker, and swaps it for the placed user block", () => {
		const t = new Transcript();
		t.update([{ kind: "queued", key: "q:1", text: "later", mode: "followUp" }]);
		expect(plain(t.render(60))).toEqual(["", "▌ later", "▌ queued · after this run"]);
		t.update([{ kind: "user", key: "u:5", text: "later" }]);
		expect(plain(t.render(60))).toEqual(["", "▌ later"]);
	});

	it("re-renders only the block whose text changed", () => {
		const t = new Transcript();
		t.update(base);
		const before = t.render(60);
		const setText = vi.spyOn(Markdown.prototype, "setText");
		const next = base.map((b) => (b.key === "live:0" ? { ...b, text: "streaming more" } : { ...b }));
		t.update(next);
		expect(setText).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("streaming more");
		const after = t.render(60);
		expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
		expect(plain(after).at(-1)).toBe("streaming more");
		for (const line of after) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("drops views for blocks that disappear and keeps order", () => {
		const t = new Transcript();
		t.update(base);
		t.update([base[1] as Block, { kind: "assistant", key: "a:3:0", text: "final", streaming: false }]);
		expect(plain(t.render(40)).filter((l) => l !== "")).toEqual(["▌ hello", "final"]);
	});

	it("navigates selectable blocks newest-first and activates them", () => {
		const t = new Transcript();
		t.update(base);
		expect(t.selecting).toBe(false);
		expect(t.moveSelection(0)).toBe(true);
		expect(t.selectedLine()).toBeGreaterThan(0);
		expect(t.activate()).toEqual({ kind: "toggled" });
		t.moveSelection(-1);
		expect(t.activate()).toEqual({ kind: "earlier" });
		expect(t.selectedLine()).toBe(0);
		t.moveSelection(-5);
		expect(t.activate()).toEqual({ kind: "earlier" });
		t.clearSelection();
		expect(t.selecting).toBe(false);
		expect(t.activate()).toBeUndefined();
	});

	it("has nothing to select without tools or markers", () => {
		const t = new Transcript();
		t.update([{ kind: "user", key: "u:1", text: "hi" }]);
		expect(t.moveSelection(0)).toBe(false);
	});

	it("shows the empty text when there are no blocks", () => {
		const t = new Transcript();
		t.setEmptyText("nothing here");
		expect(plain(t.render(30))).toEqual(["", "  nothing here"]);
	});
});

describe("ToolSlotView", () => {
	const output = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

	it("shows the output tail with a count of hidden lines, and everything when expanded", () => {
		const view = new ToolSlotView(tool({ output, droppedLines: 100 }));
		const collapsed = plain(view.render(50));
		expect(collapsed[1]).toBe(" ◐ bash $ make test");
		expect(collapsed[2]).toBe("   ⋮ 107 earlier lines · Enter expands");
		expect(collapsed.slice(3)).toEqual(["  line 8", "  line 9", "  line 10", "  line 11", "  line 12"]);
		view.toggle();
		const expanded = plain(view.render(50));
		expect(expanded).toContain("  line 1");
		expect(expanded).toContain("   … first 100 lines hidden");
	});

	it("expanded output keeps the tail when it exceeds the row cap, and says the first lines are hidden", () => {
		const long = Array.from({ length: 400 }, (_, i) => `row ${i + 1}`).join("\n");
		const view = new ToolSlotView(tool({ output: long }));
		view.toggle();
		const lines = plain(view.render(50));
		expect(lines[2]).toBe("   … first 100 lines hidden");
		expect(lines[3]).toBe("  row 101");
		expect(lines.at(-1)).toBe("  row 400");
		expect(lines).toHaveLength(2 + 1 + 300);
	});

	it("wrapTail counts wrapped rows, and a partly cut line is not counted as hidden", () => {
		expect(wrapTail(["a", "bbbbbb", "c"], 3, 3)).toEqual({ rows: ["bbb", "bbb", "c"], hidden: 1 });
		expect(wrapTail(["a", "bbbbbb", "c"], 3, 2)).toEqual({ rows: ["bbb", "c"], hidden: 1 });
		expect(wrapTail(["a", "b"], 3, 5)).toEqual({ rows: ["a", "b"], hidden: 0 });
	});

	it("expanded view shows a multi-line command in full, while collapsed shows only its first line", () => {
		const view = new ToolSlotView(tool({ args: { command: "set -e\necho one\necho two" } }));
		expect(plain(view.render(50))).toEqual(["", " ◐ bash $ set -e"]);
		view.toggle();
		expect(plain(view.render(50)).slice(1)).toEqual([" ◐ bash $ set -e", "  $ set -e", "  echo one", "  echo two"]);
	});

	it("a single-line command is not repeated when expanded, other args still are", () => {
		const view = new ToolSlotView(tool({ args: { command: "make test" } }));
		view.toggle();
		expect(plain(view.render(50))).toHaveLength(2);
		const withTimeout = new ToolSlotView(tool({ args: { command: "a\nb", timeout: 5 } }));
		withTimeout.toggle();
		const text = plain(withTimeout.render(50)).join("\n");
		expect(text).toContain("  b");
		expect(text).toContain('"timeout": 5');
		expect(text).not.toContain('"command"');
	});

	it("marks approval, strips terminal escapes from output, and fits the width", () => {
		const view = new ToolSlotView(tool({ status: "approval", output: "\x1b[31mred\x1b[0m\tx\r\n" }));
		const lines = view.render(30);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(plain(lines)[1]).toMatch(/^ ⚠ bash \$ make test awaiting/);
		expect(plain(lines)[2]).toBe("  red    x");
	});

	it("re-renders only when the block changed", () => {
		const args = { command: "make test" };
		const view = new ToolSlotView(tool({ args, output: "a" }));
		const first = view.render(40);
		view.update(tool({ args, output: "a" }));
		expect(view.render(40)).toBe(first);
		view.update(tool({ args, output: "a\nb" }));
		expect(view.render(40)).not.toBe(first);
	});

	it.each([
		["bash", { command: "ls -la\necho hi" }, "$ ls -la"],
		["read", { path: "src/a.ts", offset: 3 }, "src/a.ts"],
		["task", { tasks: [{}, {}] }, "2 worker(s)"],
		["mcp__x__y", { q: 1 }, '{"q":1}'],
		["bash", undefined, ""],
	])("argsSummary(%s)", (name, args, expected) => {
		expect(argsSummary(name, args)).toBe(expected);
	});
});

describe("screen helpers", () => {
	it("parseTiming takes 5-field cron or a date", () => {
		expect(parseTiming(" 0 9 * * 1-5 ")).toEqual({ cron: "0 9 * * 1-5" });
		expect(parseTiming("2026-12-01T09:00:00Z")).toEqual({ at: "2026-12-01T09:00:00.000Z" });
		expect(() => parseTiming("every day")).toThrow("not a 5-field cron");
	});

	it("fieldRows shows current values and truncates a long multi-line prompt", () => {
		const s = { id: "s1", name: "nightly", cron: "0 9 * * *", tz: "UTC", cwd: "/w", prompt: `first\nsecond`, model: "a/b", approval_mode: "auto", enabled: true, runs: [] } as unknown as Parameters<typeof fieldRows>[0];
		const rows = fieldRows(s);
		expect(rows.map((r) => r.field)).toEqual(["name", "timing", "tz", "cwd", "prompt", "model", "approval_mode", "misfire_grace"]);
		expect(rows[1]!.description).toBe("cron 0 9 * * *");
		expect(rows[4]!.description).toBe("first…");
		expect(rows[5]!.description).toBe("a/b");
		expect(rows[7]!.description).toContain("2h");
	});

	it("pdfPath names the file after project, slug and revision", () => {
		const rev = { projectId: "demo", slug: "a/b report", revision: 3 } as Parameters<typeof pdfPath>[0];
		expect(pdfPath(rev, "/dl")).toBe("/dl/demo-a_b_report-r3.pdf");
	});
});
