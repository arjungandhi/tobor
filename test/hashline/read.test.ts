import { describe, expect, it } from "vitest";
import { parseSelector, planRanges, READ_LIMIT } from "../../src/tools/read.js";
import { numbered, setup, tagOf } from "./helpers.js";

const rows = (text: string) =>
	text
		.split("\n")
		.filter((l) => /^\d+:/.test(l))
		.map((l) => Number(l.slice(0, l.indexOf(":"))));

describe("parseSelector", () => {
	it.each([
		["a.ts", { path: "a.ts", raw: false, ranges: [] }],
		["a.ts:5", { path: "a.ts", raw: false, ranges: [{ kind: "from", start: 5 }] }],
		["a.ts:5-", { path: "a.ts", raw: false, ranges: [{ kind: "from", start: 5 }] }],
		["a.ts:2-4", { path: "a.ts", raw: false, ranges: [{ kind: "span", start: 2, end: 4 }] }],
		["a.ts:2+3", { path: "a.ts", raw: false, ranges: [{ kind: "span", start: 2, end: 4 }] }],
		["a.ts:-7", { path: "a.ts", raw: false, ranges: [{ kind: "tail", count: 7 }] }],
		["a.ts:raw", { path: "a.ts", raw: true, ranges: [] }],
		["a.ts:2-4:raw", { path: "a.ts", raw: true, ranges: [{ kind: "span", start: 2, end: 4 }] }],
		[
			"a:b.ts:9,1-2",
			{
				path: "a:b.ts",
				raw: false,
				ranges: [
					{ kind: "from", start: 9 },
					{ kind: "span", start: 1, end: 2 },
				],
			},
		],
		["notes:todo", { path: "notes:todo", raw: false, ranges: [] }],
	])("parses %j", (arg, selector) => {
		expect(parseSelector(arg)).toEqual({ ok: true, selector });
	});

	it.each([
		["a:0", "Line selector 0 is invalid; lines are 1-indexed. Use :1."],
		["a:0-3", "Line selector 0 is invalid; lines are 1-indexed. Use :1."],
		["a:5-3", "Invalid range :5-3; the end must not be before the start."],
		["a:5+0", "Invalid range :5+0; the count must be at least 1."],
		["a:-0", "Invalid range :-0; the count must be at least 1."],
	])("rejects %j", (arg, message) => {
		expect(parseSelector(arg)).toEqual({ ok: false, message });
	});
});

describe("planRanges", () => {
	it("adds 1 leading and 3 trailing context lines to a single bounded range, clamped", () => {
		expect(planRanges([{ kind: "span", start: 5, end: 6 }], 20, false)).toEqual({ kind: "lines", ranges: [[4, 9]] });
		expect(planRanges([{ kind: "span", start: 1, end: 2 }], 3, false)).toEqual({ kind: "lines", ranges: [[1, 3]] });
		expect(planRanges([{ kind: "span", start: 5, end: 6 }], 20, true)).toEqual({ kind: "lines", ranges: [[5, 6]] });
	});

	it("sorts and merges lists exactly, without context", () => {
		const plan = planRanges(
			[
				{ kind: "span", start: 10, end: 12 },
				{ kind: "span", start: 1, end: 2 },
				{ kind: "span", start: 3, end: 4 },
				{ kind: "span", start: 11, end: 15 },
			],
			20,
			false,
		);
		expect(plan).toEqual({
			kind: "lines",
			ranges: [
				[1, 4],
				[10, 15],
			],
		});
	});

	it("caps open-ended reads and reports the next line", () => {
		expect(planRanges([], 1000, false)).toEqual({ kind: "lines", ranges: [[1, READ_LIMIT]], next: READ_LIMIT + 1 });
		expect(planRanges([{ kind: "from", start: 900 }], 1000, false)).toEqual({ kind: "lines", ranges: [[900, 1000]] });
		expect(planRanges([{ kind: "tail", count: 3 }], 10, false)).toEqual({ kind: "lines", ranges: [[8, 10]] });
	});

	it("is out of bounds when nothing starts inside the file", () => {
		expect(planRanges([{ kind: "from", start: 11 }], 10, false)).toEqual({ kind: "out_of_bounds" });
		expect(planRanges([{ kind: "span", start: 11, end: 12 }], 10, false)).toEqual({ kind: "out_of_bounds" });
	});
});

describe("read tool", () => {
	it("renders [path#TAG] and N:TEXT rows, cwd-relative", async () => {
		const t = setup();
		t.env.set("src/a.ts", "one\ntwo\n");
		const r = await t.read("/work/src/a.ts");
		expect(r.isError).toBe(false);
		expect(r.text).toBe(`[src/a.ts#${tagOf(r)}]\n1:one\n2:two`);
		const outside = await t.read("/elsewhere/x.txt");
		expect(outside.details.errorKind).toBe("file_not_found");
		t.env.set("/elsewhere/x.txt", "x");
		expect((await t.read("/elsewhere/x.txt")).text).toMatch(/^\[\/elsewhere\/x\.txt#[0-9A-F]{4}\]\n1:x$/);
	});

	it("stops open-ended reads at 300 lines with a continuation hint", async () => {
		const t = setup();
		t.env.set("big.txt", numbered(310));
		const r = await t.read("big.txt");
		expect(rows(r.text)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
		expect(r.text.endsWith("\n[… more lines; continue with big.txt:301]")).toBe(true);
		const rest = await t.read("big.txt:301");
		expect(rows(rest.text)).toEqual(Array.from({ length: 10 }, (_, i) => i + 301));
		expect(rest.text).not.toContain("more lines");
	});

	it("shows context for a single bounded range, none for lists or tails", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(20));
		expect(rows((await t.read("f.txt:5-6")).text)).toEqual([4, 5, 6, 7, 8, 9]);
		expect(rows((await t.read("f.txt:5+2")).text)).toEqual([4, 5, 6, 7, 8, 9]);
		expect(rows((await t.read("f.txt:5-6,10")).text)).toEqual([5, 6, ...Array.from({ length: 11 }, (_, i) => i + 10)]);
		expect(rows((await t.read("f.txt:2,1-1")).text)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(rows((await t.read("f.txt:-2")).text)).toEqual([19, 20]);
		expect(rows((await t.read("f.txt:19-25")).text)).toEqual([18, 19, 20]);
	});

	it("answers an out-of-bounds start with a hint, not an error", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(5));
		const r = await t.read("f.txt:9");
		expect(r.isError).toBe(false);
		expect(r.text).toMatch(/^\[f\.txt#[0-9A-F]{4}\]\nFile has 5 lines; try :1 or :5$/);
		t.env.set("empty.txt", "");
		expect((await t.read("empty.txt")).text).toMatch(/\n\(empty file\)$/);
		expect((await t.read("empty.txt:2")).text).toMatch(/\nFile has 0 lines$/);
	});

	it("errors on :0", async () => {
		const t = setup();
		t.env.set("f.txt", "a\n");
		const r = await t.read("f.txt:0");
		expect(r.isError).toBe(true);
		expect(r.text).toBe("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	});

	it("returns verbatim text for :raw, whole or by range, with no header", async () => {
		const t = setup();
		t.env.set("f.txt", "a\r\nb\nc\r\nd");
		expect((await t.read("f.txt:raw")).text).toBe("a\r\nb\nc\r\nd");
		expect((await t.read("f.txt:2-3:raw")).text).toBe("b\nc\r\n");
	});

	it("cuts lines over 2000 characters and does not mark them seen", async () => {
		const t = setup();
		t.env.set("long.txt", `short\n${"x".repeat(2500)}\n`);
		const r = await t.read("long.txt");
		const tag = tagOf(r);
		expect(r.text.split("\n")[2]).toBe(`2:${"x".repeat(2000)}…`);
		const edit = await t.edit(`[long.txt#${tag}]\nPUT 2.=2:\n+y`);
		expect(edit.details.errorKind).toBe("unseen_lines");
		expect((await t.edit(`[long.txt#${tag}]\nPUT 1.=1:\n+S`)).isError).toBe(false);
	});

	it("gives a notice for binary files unless :raw", async () => {
		const t = setup();
		t.env.set("bin.dat", new Uint8Array([1, 2, 0, 3]));
		const r = await t.read("bin.dat");
		expect(r.isError).toBe(false);
		expect(r.text).toBe("bin.dat is a binary file (4 bytes); not shown. Use bin.dat:raw to read it as text.");
		expect((await t.read("bin.dat:raw")).text).toBe("\u0001\u0002\u0000\u0003");
	});

	it("errors on invalid UTF-8", async () => {
		const t = setup();
		t.env.set("bad.txt", new Uint8Array([0x61, 0xff, 0x0a]));
		expect((await t.read("bad.txt")).details.errorKind).toBe("invalid_utf8");
	});

	it("lists directories without a tag", async () => {
		const t = setup();
		t.env.set("d/b.txt", "");
		t.env.set("d/a.txt", "");
		t.env.set("d/sub/c.txt", "");
		expect((await t.read("d")).text).toBe("a.txt\nb.txt\nsub/");
	});

	it("refuses $TOBOR_HOME except .tobor/", async () => {
		const home = "/srv/tobor";
		const t = setup(home);
		t.env.set(`${home}/auth.json`, "{}");
		t.env.set(`${home}/.tobor/config.yml`, "a: 1\n");
		const denied = await t.read(`${home}/auth.json`);
		expect(denied.isError).toBe(true);
		expect(denied.text).toMatch(/Access denied/);
		expect((await t.read(home)).isError).toBe(true);
		expect((await t.read(`${home}/.tobor/config.yml`)).text).toMatch(/1:a: 1/);
	});

	it("unions seen lines across reads of the same tag", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(20));
		const tag = tagOf(await t.read("f.txt:1-2,4-4"));
		expect((await t.edit(`[f.txt#${tag}]\nPUT 10.=10:\n+x`)).details.errorKind).toBe("unseen_lines");
		await t.read("f.txt:10-10,12-12");
		expect((await t.edit(`[f.txt#${tag}]\nPUT 10.=10:\n+x`)).isError).toBe(false);
	});
});
