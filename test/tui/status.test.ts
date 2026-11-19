import { describe, expect, it } from "vitest";
import { StatusLine, StatusSlot, severityOf } from "../../src/tui/components/status.js";

const clock = () => {
	const t = { now: 1_000 };
	return { t, slot: new StatusSlot(() => t.now) };
};

describe("StatusSlot", () => {
	it("shows one transient message; a new one replaces it", () => {
		const { slot } = clock();
		slot.flash("first");
		slot.flash("second");
		expect(slot.view().message).toEqual({ text: "second", severity: "info" });
	});

	it("replaces an error with an info message and back", () => {
		const { slot } = clock();
		slot.flash("✗ boom");
		expect(slot.view().message?.severity).toBe("error");
		slot.flash("fine");
		expect(slot.view().message).toEqual({ text: "fine", severity: "info" });
	});

	it("infers severity from the ✗ prefix unless given", () => {
		expect(severityOf("✗ no")).toBe("error");
		expect(severityOf("ok")).toBe("info");
		const { slot } = clock();
		slot.flash("plain", "error");
		expect(slot.view().message?.severity).toBe("error");
	});

	it("expires after its duration (default 4 s)", () => {
		const { t, slot } = clock();
		slot.flash("a");
		t.now += 3_999;
		expect(slot.view().message?.text).toBe("a");
		expect(slot.expiresIn()).toBe(1);
		t.now += 1;
		expect(slot.view().message).toBeUndefined();
		expect(slot.expiresIn()).toBeUndefined();
	});

	it("honours a custom duration; a replacement restarts the clock", () => {
		const { t, slot } = clock();
		slot.flash("short", "info", 500);
		t.now += 400;
		slot.flash("longer", "info", 500);
		t.now += 400;
		expect(slot.view().message?.text).toBe("longer");
		t.now += 100;
		expect(slot.view().message).toBeUndefined();
	});

	it("keeps progress through flashes until done()", () => {
		const { t, slot } = clock();
		const p = slot.progress("restarting node…");
		slot.flash("one");
		slot.flash("✗ two");
		t.now += 60_000;
		expect(slot.view()).toEqual({ progress: "restarting node…" });
		slot.flash("three");
		expect(slot.view()).toEqual({ progress: "restarting node…", message: { text: "three", severity: "info" } });
		p.done();
		expect(slot.view().progress).toBeUndefined();
	});

	it("update() relabels; done(msg) flashes msg; both are no-ops afterwards", () => {
		const { slot } = clock();
		const p = slot.progress("a");
		p.update("b");
		expect(slot.view().progress).toBe("b");
		p.done("✗ failed");
		expect(slot.view()).toEqual({ message: { text: "✗ failed", severity: "error" } });
		p.update("c");
		p.done("again");
		expect(slot.view()).toEqual({ message: { text: "✗ failed", severity: "error" } });
	});

	it("shows the newest of several progress entries and falls back when it ends", () => {
		const { slot } = clock();
		const a = slot.progress("a");
		const b = slot.progress("b");
		expect(slot.view().progress).toBe("b");
		b.done();
		expect(slot.view().progress).toBe("a");
		a.done();
		expect(slot.view()).toEqual({});
	});
});

describe("StatusLine", () => {
	const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

	it("paints progress, then the message, then the segments, one row of exactly the width", () => {
		const line = new StatusLine();
		line.set(["● connected"], "? help", { progress: "restarting node…", message: { text: "✗ oops", severity: "error" } });
		const [row, ...rest] = line.render(80);
		expect(rest).toEqual([]);
		expect(strip(row ?? "")).toMatch(/^ ⟳ restarting node… │ ✗ oops │ ● connected\s+\? help$/);
		expect(strip(row ?? "").length).toBe(80);
	});

	it("drops the hint, then truncates, on a narrow terminal; never exceeds the width", () => {
		const line = new StatusLine();
		line.set(["● connected"], "? help", { message: { text: "x".repeat(100), severity: "info" } });
		const [row] = line.render(30);
		expect(strip(row ?? "").length).toBeLessThanOrEqual(30);
		expect(strip(row ?? "")).not.toContain("help");
	});

	it("repaints when only the slot changes", () => {
		const line = new StatusLine();
		line.set(["a"], "", { message: { text: "one", severity: "info" } });
		expect(strip(line.render(40)[0] ?? "")).toContain("one");
		line.set(["a"], "", { message: { text: "two", severity: "info" } });
		expect(strip(line.render(40)[0] ?? "")).toContain("two");
		line.set(["a"], "");
		expect(strip(line.render(40)[0] ?? "")).not.toContain("two");
	});
});
