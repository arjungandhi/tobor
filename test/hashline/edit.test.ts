import { describe, expect, it } from "vitest";
import { numbered, setup, tagOf } from "./helpers.js";

/** A setup with `f.txt` (20 numbered lines) fully read; returns its tag. */
async function readFile(text = numbered(20), path = "f.txt") {
	const t = setup();
	t.env.set(path, text);
	const tag = tagOf(await t.read(path));
	return { t, tag };
}

describe("edit: success", () => {
	it("replaces lines, returns the new tag, a ±2 preview and diff details", async () => {
		const { t, tag } = await readFile();
		const r = await t.edit(`[f.txt#${tag}]\nPUT 10.=11:\n+ten`);
		expect(r.isError).toBe(false);
		const fresh = tagOf(r);
		expect(fresh).not.toBe(tag);
		expect(r.text).toBe(`[f.txt#${fresh}]\n8:line8\n9:line9\n10:ten\n11:line12\n12:line13`);
		expect(r.details).toEqual({ diff: "--- f.txt\n+++ f.txt\n@@ -10,2 +10,1 @@\n-line10\n-line11\n+ten\n", firstChangedLine: 10 });
		expect(t.env.text("f.txt")).toBe(numbered(20).replace("line10\nline11\n", "ten\n"));
	});

	it("applies every PUT form against the tagged snapshot in one call, merging same-path sections", async () => {
		const { t, tag } = await readFile("a\nb\nc\n");
		const r = await t.edit(`[f.txt#${tag}]\nPUT <1:\n+head\nPUT 2.=2:\n+B\n[f.txt#${tag}]\nPUT >2:\n+after-b\nPUT >$:\n+tail`);
		expect(r.isError).toBe(false);
		expect(t.env.text("f.txt")).toBe("head\na\nB\nafter-b\nc\ntail\n");
	});

	it("round-trips a CRLF file with a BOM and no final newline byte-exact", async () => {
		const original = "\uFEFFa\r\nb\r\nc\nd";
		const { t, tag } = await readFile(original);
		const r = await t.edit(`[f.txt#${tag}]\nPUT 2.=2:\n+B\n+B2\nPUT >$:\n+e`);
		expect(r.isError).toBe(false);
		expect(t.env.text("f.txt")).toBe("\uFEFFa\r\nB\r\nB2\r\nc\nd\r\ne");
		const again = await t.edit(`[f.txt#${tagOf(r)}]\nPUT 1.=1:\n+a`);
		expect(again.isError).toBe(false);
		expect(t.env.text("f.txt")).toBe("\uFEFFa\r\nB\r\nB2\r\nc\nd\r\ne");
	});

	it("remaps seen lines through the edit, then adds the preview rows", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(30));
		const tag = tagOf(await t.read("f.txt:1-3,28-30"));
		const r = await t.edit(`[f.txt#${tag}]\nPUT 2.=2:\n+x\n+y\n+z`);
		const fresh = tagOf(r);
		expect((await t.edit(`[f.txt#${fresh}]\nPUT 32.=32:\n+last`)).isError).toBe(false);
	});

	it("keeps seen lines moved by an edit and drops the rest", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(30));
		const tag = tagOf(await t.read("f.txt:1-3,28-30"));
		const fresh = tagOf(await t.edit(`[f.txt#${tag}]\nPUT 2.=2:\n+x\n+y\n+z`));
		expect((await t.edit(`[f.txt#${fresh}]\nPUT 15.=15:\n+mid`)).details.errorKind).toBe("unseen_lines");
		expect((await t.edit(`[f.txt#${fresh}]\nPUT 30.=30:\n+moved-28`)).isError).toBe(false);
		expect(t.env.text("f.txt")!.split("\n")[29]).toBe("moved-28");
	});

	it("accepts the current file's tag without a record, with nothing seen", async () => {
		const t = setup();
		t.env.set("f.txt", "a\nb\n");
		const tag = tagOf(await t.read("f.txt"));
		t.useConversation(2);
		expect((await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+A`)).details.errorKind).toBe("unseen_lines");
		const r = await t.edit(`[f.txt#${tag.toLowerCase()}]\nPUT >$:\n+c`);
		expect(r.isError).toBe(false);
		expect(t.env.text("f.txt")).toBe("a\nb\nc\n");
	});

	it("writes through a temp file and rename in the target directory", async () => {
		const { t, tag } = await readFile("a\n", "dir/f.txt");
		await t.edit(`[dir/f.txt#${tag}]\nPUT 1.=1:\n+b`);
		expect(t.env.log).toHaveLength(2);
		expect(t.env.log[0]).toMatch(/^write \/work\/dir\/\.f\.txt\.tobor-\w+\.tmp$/);
		expect(t.env.log[1]).toMatch(/^rename \/work\/dir\/\.f\.txt\.tobor-\w+\.tmp \/work\/dir\/f\.txt$/);
		expect([...t.env.files.keys()]).toEqual(["/work/dir/f.txt"]);
	});

	it("falls back to copy then unlink when the rename crosses devices", async () => {
		const { t, tag } = await readFile("a\n");
		t.env.failRename = () => "EXDEV: cross-device link not permitted";
		const r = await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+b`);
		expect(r.isError).toBe(false);
		expect(t.env.text("f.txt")).toBe("b\n");
		expect([...t.env.files.keys()]).toEqual(["/work/f.txt"]);
	});

	it("warns when body rows carry copied N: prefixes", async () => {
		const { t, tag } = await readFile("a\n");
		const r = await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+1:a`);
		expect(r.text).toContain("Warnings:\n- f.txt line 2: body rows start with N: prefixes");
	});
});

describe("edit: REM and MV", () => {
	it("deletes a file with REM", async () => {
		const { t, tag } = await readFile("a\n");
		const r = await t.edit(`[f.txt#${tag}]\nREM`);
		expect(r.text).toBe("Deleted f.txt");
		expect(t.env.files.size).toBe(0);
	});

	it("moves the edited result, creating parents, and the new tag works on the destination", async () => {
		const { t, tag } = await readFile("a\nb\n");
		const r = await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+A\nMV "new dir/g.txt"`);
		expect(r.isError).toBe(false);
		expect(t.env.text("f.txt")).toBeUndefined();
		expect(t.env.text("new dir/g.txt")).toBe("A\nb\n");
		const fresh = tagOf(r);
		expect(r.text).toContain(`Moved f.txt to new dir/g.txt\n[new dir/g.txt#${fresh}]\n1:A\n2:b`);
		expect((await t.edit(`[new dir/g.txt#${fresh}]\nPUT 2.=2:\n+B`)).isError).toBe(false);
		expect((await t.edit(`[f.txt#${tag}]\nREM`)).details.errorKind).toBe("file_not_found");
	});

	it("lands additive targets before any deletion", async () => {
		const t = setup();
		for (const f of ["a", "b", "c"]) t.env.set(`${f}.txt`, `${f}\n`);
		const tags = await Promise.all(["a", "b", "c"].map(async (f) => tagOf(await t.read(`${f}.txt`))));
		const r = await t.edit(`[a.txt#${tags[0]}]\nREM\n[b.txt#${tags[1]}]\nPUT 1.=1:\n+B\n[c.txt#${tags[2]}]\nMV d.txt`);
		expect(r.isError).toBe(false);
		const kinds = t.env.log.map((l) => l.split(" ")[0]);
		expect(kinds).toEqual(["write", "rename", "write", "rename", "remove", "remove"]);
		expect(t.env.log.slice(4)).toEqual(["remove /work/a.txt", "remove /work/c.txt"]);
		expect([...t.env.files.keys()].sort()).toEqual(["/work/b.txt", "/work/d.txt"]);
	});

	it.each([
		["MV f.txt", /also a source or destination/],
		["MV other.txt", /already exists/],
	])("rejects a bad MV destination (%s)", async (op, message) => {
		const { t, tag } = await readFile("a\n");
		t.env.set("other.txt", "o\n");
		const r = await t.edit(`[f.txt#${tag}]\n${op}`);
		expect(r.details.errorKind).toBe("parse");
		expect(r.text).toMatch(message);
	});

	it("rejects REM with PUT, two REM/MV ops, and conflicting tags for one path", async () => {
		const { t, tag } = await readFile("a\n");
		expect((await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+x\nREM`)).text).toMatch(/REM cannot be combined with PUT/);
		expect((await t.edit(`[f.txt#${tag}]\nREM\nMV g.txt`)).text).toMatch(/at most one REM or MV/);
		expect((await t.edit(`[f.txt#${tag}]\nREM\n[./f.txt#ABCD]\nREM`)).text).toMatch(/use one tag per file/);
	});
});

describe("edit: error kinds", () => {
	it.each([
		["[f.txt]", "has no #TAG"],
		["[f.txt#AUTO]", "has placeholder tag #AUTO"],
		["[f.txt#????]", "has placeholder tag #????"],
	])("missing_tag for %s, replying with the current tag", async (head, message) => {
		const { t, tag } = await readFile("a\n");
		const r = await t.edit(`${head}\nREM`);
		expect(r.isError).toBe(true);
		expect(r.details.errorKind).toBe("missing_tag");
		expect(r.text).toBe(`f.txt ${message}. Current [f.txt#${tag}]`);
	});

	it("unknown_tag when the tag matches neither a record nor the file", async () => {
		const { t, tag } = await readFile("a\n");
		const bogus = tag === "0000" ? "0001" : "0000";
		const r = await t.edit(`[f.txt#${bogus}]\nREM`);
		expect(r.details.errorKind).toBe("unknown_tag");
		expect(r.text).toBe(`Unknown tag #${bogus} for f.txt. Current [f.txt#${tag}]`);
	});

	it("stale_tag with the fresh header and anchored lines ±3, which become seen", async () => {
		const { t, tag } = await readFile();
		t.env.set("f.txt", numbered(20).replace("line1\n", "changed\n"));
		const r = await t.edit(`[f.txt#${tag}]\nPUT 10.=10:\n+x`);
		expect(r.details.errorKind).toBe("stale_tag");
		const fresh = tagOf(r);
		expect(fresh).not.toBe(tag);
		expect(r.text).toBe(
			`f.txt changed since #${tag}; re-anchor on the current version:\n[f.txt#${fresh}]\n${[7, 8, 9, 10, 11, 12, 13].map((n) => `${n}:line${n}`).join("\n")}`,
		);
		expect((await t.edit(`[f.txt#${fresh}]\nPUT 13.=13:\n+x`)).isError).toBe(false);
	});

	it("other_file_tag when the tag was recorded for another path", async () => {
		const t = setup();
		t.env.set("a.txt", "a\n");
		t.env.set("b.txt", "b\n");
		const aTag = tagOf(await t.read("a.txt"));
		const r = await t.edit(`[b.txt#${aTag}]\nREM`);
		expect(r.details.errorKind).toBe("other_file_tag");
		expect(r.text).toMatch(new RegExp(`^Tag #${aTag} belongs to a\\.txt, not b\\.txt\\. Current \\[b\\.txt#[0-9A-F]{4}\\]$`));
	});

	it("unseen_lines with the ranges to re-read", async () => {
		const t = setup();
		t.env.set("f.txt", numbered(20));
		const tag = tagOf(await t.read("f.txt:1-2,3-3"));
		const r = await t.edit(`[f.txt#${tag}]\nPUT 5.=7:\n+x\nPUT >9:\n+y`);
		expect(r.details.errorKind).toBe("unseen_lines");
		expect(r.text).toBe(`f.txt: lines 5-7, 9 have not been read under #${tag}; read f.txt:5-7,9 first`);
	});

	it("out_of_range with the file length", async () => {
		const { t, tag } = await readFile("a\nb\n");
		const r = await t.edit(`[f.txt#${tag}]\nPUT 2.=3:\n+x`);
		expect(r.details.errorKind).toBe("out_of_range");
		expect(r.text).toBe("f.txt: line 2: PUT 2.=3 is out of range; the file has 2 lines");
	});

	it("parse for overlapping ranges", async () => {
		const { t, tag } = await readFile();
		const r = await t.edit(`[f.txt#${tag}]\nPUT 1.=3:\n+x\nPUT 3.=4:\n+y`);
		expect(r.details.errorKind).toBe("parse");
		expect(r.text).toMatch(/overlaps/);
	});

	it("header_only for a section without ops", async () => {
		const { t, tag } = await readFile();
		expect((await t.edit(`[f.txt#${tag}]`)).details.errorKind).toBe("header_only");
	});

	it("file_not_found, io and invalid_utf8 from the filesystem", async () => {
		const t = setup();
		expect((await t.edit("[nope.txt#ABCD]\nREM")).details.errorKind).toBe("file_not_found");
		t.env.addDir("/work/dir");
		expect((await t.edit("[dir#ABCD]\nREM")).details.errorKind).toBe("io");
		t.env.set("bad.txt", new Uint8Array([0xc3, 0x28]));
		expect((await t.edit("[bad.txt#ABCD]\nREM")).details.errorKind).toBe("invalid_utf8");
	});

	it("write_failed when a rename fails, reporting what was already written", async () => {
		const t = setup();
		t.env.set("a.txt", "a\n");
		t.env.set("b.txt", "b\n");
		const aTag = tagOf(await t.read("a.txt"));
		const bTag = tagOf(await t.read("b.txt"));
		t.env.failRename = (_s, d) => (d.endsWith("b.txt") ? "EIO: i/o error" : undefined);
		const r = await t.edit(`[a.txt#${aTag}]\nPUT 1.=1:\n+A\n[b.txt#${bTag}]\nPUT 1.=1:\n+B`);
		expect(r.details.errorKind).toBe("write_failed");
		expect(r.text).toBe("Failed to write b.txt: EIO: i/o error. Already written: a.txt.");
		expect(t.env.text("a.txt")).toBe("A\n");
		expect(t.env.text("b.txt")).toBe("b\n");
		expect([...t.env.files.keys()].sort()).toEqual(["/work/a.txt", "/work/b.txt"]);
	});

	it("write_failed when a deletion fails, after the additive writes landed", async () => {
		const t = setup();
		t.env.set("a.txt", "a\n");
		const tag = tagOf(await t.read("a.txt"));
		t.env.failRemove = () => true;
		const r = await t.edit(`[a.txt#${tag}]\nMV b.txt`);
		expect(r.details.errorKind).toBe("write_failed");
		expect(r.text).toMatch(/^Failed to write \(delete\) a\.txt: EACCES.*Already written: b\.txt\.$/);
	});

	it("reports every failing section", async () => {
		const t = setup();
		t.env.set("a.txt", "a\n");
		const r = await t.edit("[a.txt#AUTO]\nREM\n[b.txt#ABCD]\nREM");
		expect(r.details.errorKind).toBe("missing_tag");
		expect(r.text).toMatch(/Current \[a\.txt#[0-9A-F]{4}\]\n\nb\.txt: ENOENT/);
	});
});

describe("edit: no_change", () => {
	it("returns a diagnostic twice, then errors on the third identical no-op", async () => {
		const { t, tag } = await readFile("a\nb\n");
		const patch = `[f.txt#${tag}]\nPUT 1.=1:\n+a`;
		for (let i = 0; i < 2; i++) {
			const r = await t.edit(patch);
			expect(r.isError).toBe(false);
			expect(r.diagnostics.map((d) => d.code)).toEqual(["no_change"]);
			expect(r.text).toBe(`No change: the result is identical to [f.txt#${tag}]; nothing was written.`);
		}
		const third = await t.edit(patch);
		expect(third.isError).toBe(true);
		expect(third.details.errorKind).toBe("no_change");
		expect(t.env.log).toEqual([]);
	});

	it("restarts the count on a different no-op or a real change", async () => {
		const { t, tag } = await readFile("a\nb\n");
		const p1 = `[f.txt#${tag}]\nPUT 1.=1:\n+a`;
		const p2 = `[f.txt#${tag}]\nPUT 2.=2:\n+b`;
		await t.edit(p1);
		await t.edit(p1);
		expect((await t.edit(p2)).isError).toBe(false);
		expect((await t.edit(p1)).isError).toBe(false);
		await t.edit(p1);
		const fresh = tagOf(await t.edit(`[f.txt#${tag}]\nPUT 1.=1:\n+A`));
		const back = `[f.txt#${fresh}]\nPUT 1.=1:\n+A`;
		await t.edit(back);
		expect((await t.edit(back)).isError).toBe(false);
	});

	it("rejects a whole multi-section batch when any section is a no-op", async () => {
		const t = setup();
		t.env.set("a.txt", "a\n");
		t.env.set("b.txt", "b\n");
		const aTag = tagOf(await t.read("a.txt"));
		const bTag = tagOf(await t.read("b.txt"));
		const r = await t.edit(`[a.txt#${aTag}]\nPUT 1.=1:\n+A\n[b.txt#${bTag}]\nPUT 1.=1:\n+b`);
		expect(r.details.errorKind).toBe("no_change");
		expect(r.text).toMatch(/whole edit was rejected/);
		expect(t.env.text("a.txt")).toBe("a\n");
	});
});

describe("write wrapper", () => {
	it("prepends [path#TAG] and records seen = all", async () => {
		const t = setup();
		const r = await t.write("/work/n.txt", "a\nb\nc\n");
		const tag = tagOf(r);
		expect(r.text).toBe(`[n.txt#${tag}]\nSuccessfully wrote to /work/n.txt`);
		expect((await t.edit(`[n.txt#${tag}]\nPUT 3.=3:\n+C`)).isError).toBe(false);
	});

	it("strips copied N: prefixes only when every non-blank row has one, rising by 1", async () => {
		const t = setup();
		await t.write("a.txt", "4:x\n5:\n6:  y\n");
		expect(t.env.text("a.txt")).toBe("x\n\n  y\n");
		await t.write("b.txt", "1:x\n3:y\n");
		expect(t.env.text("b.txt")).toBe("1:x\n3:y\n");
		await t.write("c.txt", "1:x\ny\n");
		expect(t.env.text("c.txt")).toBe("1:x\ny\n");
	});

	it("invalidates older snapshots of the path", async () => {
		const t = setup();
		t.env.set("f.txt", "a\n");
		const old = tagOf(await t.read("f.txt"));
		await t.write("f.txt", "b\n");
		expect((await t.edit(`[f.txt#${old}]\nREM`)).details.errorKind).toBe("unknown_tag");
	});
});
