import { describe, expect, it } from "vitest";
import { applyPuts, checkPuts, previewRanges, type Put, remapSeen } from "../../src/tools/hashline/apply.js";
import { decodeText, dominantTerm, encodeText, isBinary, normalizedText, splitText } from "../../src/tools/hashline/lineio.js";
import type { Target } from "../../src/tools/hashline/parse.js";
import { hashText } from "../../src/tools/hashline/tag.js";

const enc = new TextEncoder();
const put = (target: Target, ...body: string[]): Put => ({ kind: "put", target, body, line: 1 });
const apply = (text: string, ...puts: Put[]) => encodeText(applyPuts(splitText(text), puts).file);

describe("line IO", () => {
	it.each(["", "a", "a\n", "a\r\nb\nc", "a\r\nb\r\n", "x\ry\n", "\n\n", "\r\n"])("round-trips %j byte-exact", (text) => {
		expect(encodeText(decodeText(enc.encode(text))!)).toBe(text);
	});

	it("keeps per-line terminators and treats a lone CR as text", () => {
		const f = splitText("a\r\nb\nc\rd");
		expect(f.lines).toEqual(["a", "b", "c\rd"]);
		expect(f.terms).toEqual(["\r\n", "\n", ""]);
	});

	it("strips and restores a BOM", () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("hi\r\n")]);
		const f = decodeText(bytes)!;
		expect(f.bom).toBe(true);
		expect(f.lines).toEqual(["hi"]);
		expect(encodeText(f)).toBe("\uFEFFhi\r\n");
	});

	it("rejects invalid UTF-8 and spots NUL bytes", () => {
		expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toBeUndefined();
		expect(isBinary(new Uint8Array([0x61, 0, 0x62]))).toBe(true);
		expect(isBinary(enc.encode("text"))).toBe(false);
	});

	it("hashes LF-normalised content, so CRLF and LF share a tag", () => {
		const crlf = hashText(normalizedText(splitText("a\r\nb\r\n")));
		const lf = hashText(normalizedText(splitText("a\nb\n")));
		expect(crlf).toEqual(lf);
		expect(crlf.tag).toMatch(/^[0-9A-F]{4}$/);
		expect(crlf.fullHash.slice(0, 4).toUpperCase()).toBe(crlf.tag);
		expect(hashText("a\nb").tag === crlf.tag && hashText("a\nb").fullHash === crlf.fullHash).toBe(false);
	});

	it("picks the dominant terminator, LF on ties", () => {
		expect(dominantTerm(splitText("a\r\nb\r\nc\n"))).toBe("\r\n");
		expect(dominantTerm(splitText("a\r\nb\n"))).toBe("\n");
		expect(dominantTerm(splitText(""))).toBe("\n");
	});
});

describe("applyPuts", () => {
	const five = "1\n2\n3\n4\n5\n";

	it("replaces, inserts before/after, appends; numbers refer to the original", () => {
		expect(apply(five, put({ kind: "replace", start: 2, end: 3 }, "x"))).toBe("1\nx\n4\n5\n");
		expect(apply(five, put({ kind: "before", line: 1 }, "h"))).toBe("h\n1\n2\n3\n4\n5\n");
		expect(apply(five, put({ kind: "after", line: 5 }, "t"))).toBe("1\n2\n3\n4\n5\nt\n");
		expect(apply(five, put({ kind: "append" }, "t", ""))).toBe("1\n2\n3\n4\n5\nt\n\n");
		expect(
			apply(five, put({ kind: "replace", start: 4, end: 4 }, "D"), put({ kind: "replace", start: 1, end: 1 }, "A", "A2"), put({ kind: "after", line: 2 }, "b")),
		).toBe("A\nA2\n2\nb\n3\nD\n5\n");
	});

	it("orders same-gap inserts by input order, before a replacement there", () => {
		expect(apply(five, put({ kind: "replace", start: 3, end: 3 }, "R"), put({ kind: "after", line: 2 }, "a"), put({ kind: "before", line: 3 }, "b"))).toBe(
			"1\n2\na\nb\nR\n4\n5\n",
		);
	});

	it("gives new lines the dominant terminator and keeps the others", () => {
		expect(apply("a\r\nb\r\nc\n", put({ kind: "after", line: 1 }, "x"))).toBe("a\r\nx\r\nb\r\nc\n");
		expect(apply("a\r\nb\r\n", put({ kind: "replace", start: 2, end: 2 }, "B", "C"))).toBe("a\r\nB\r\nC\r\n");
	});

	it("preserves a missing final newline", () => {
		expect(apply("a\nb", put({ kind: "append" }, "c"))).toBe("a\nb\nc");
		expect(apply("a\nb", put({ kind: "replace", start: 2, end: 2 }, "B"))).toBe("a\nB");
		expect(apply("a\nb", put({ kind: "before", line: 2 }, "x"))).toBe("a\nx\nb");
	});

	it("fills an empty file at the head or end", () => {
		expect(apply("", put({ kind: "before", line: 1 }, "x"))).toBe("x\n");
		expect(apply("", put({ kind: "append" }, "x"))).toBe("x\n");
	});

	it("reports the line map, changed ranges, hunks and first changed line", () => {
		const r = applyPuts(splitText(five), [put({ kind: "replace", start: 2, end: 3 }, "x"), put({ kind: "after", line: 4 }, "y", "z")]);
		expect(r.map).toEqual([1, undefined, undefined, 3, 6]);
		expect(r.changed).toEqual([
			[2, 2],
			[4, 5],
		]);
		expect(r.firstChangedLine).toBe(2);
		expect(r.hunks).toBe("@@ -2,2 +2,1 @@\n-2\n-3\n+x\n@@ -4,0 +4,2 @@\n+y\n+z\n");
		expect(previewRanges(r.changed, 6)).toEqual([[1, 6]]);
	});
});

describe("checkPuts", () => {
	it.each<[Target, number]>([
		[{ kind: "replace", start: 0, end: 1 }, 3],
		[{ kind: "replace", start: 2, end: 4 }, 3],
		[{ kind: "replace", start: 3, end: 2 }, 3],
		[{ kind: "before", line: 4 }, 3],
		[{ kind: "after", line: 0 }, 3],
		[{ kind: "after", line: 1 }, 0],
		[{ kind: "before", line: 2 }, 0],
	])("rejects %j in a %i-line file as out_of_range", (target, lines) => {
		const e = checkPuts([put(target, "x")], lines);
		expect(e?.kind).toBe("out_of_range");
		expect(e?.message).toContain(`the file has ${lines} lines`);
	});

	it("accepts <1 and >$ on an empty file", () => {
		expect(checkPuts([put({ kind: "before", line: 1 }, "x"), put({ kind: "append" }, "y")], 0)).toBeUndefined();
	});

	it("rejects overlapping ranges and inserts inside a replaced range", () => {
		expect(checkPuts([put({ kind: "replace", start: 1, end: 3 }, "x"), put({ kind: "replace", start: 3, end: 4 }, "y")], 5)?.kind).toBe("parse");
		expect(checkPuts([put({ kind: "replace", start: 2, end: 4 }, "x"), put({ kind: "after", line: 2 }, "y")], 5)?.message).toMatch(/falls inside/);
		expect(checkPuts([put({ kind: "replace", start: 2, end: 4 }, "x"), put({ kind: "before", line: 4 }, "y")], 5)?.kind).toBe("parse");
		expect(checkPuts([put({ kind: "replace", start: 2, end: 4 }, "x"), put({ kind: "before", line: 2 }, "y"), put({ kind: "after", line: 4 }, "z")], 5)).toBeUndefined();
		expect(checkPuts([put({ kind: "replace", start: 1, end: 2 }, "x"), put({ kind: "replace", start: 3, end: 3 }, "y")], 5)).toBeUndefined();
	});
});

describe("remapSeen", () => {
	it("moves seen lines through the map and drops replaced ones", () => {
		expect(remapSeen(new Set([1, 2, 4, 5]), [1, undefined, undefined, 3, 6])).toEqual(new Set([1, 3, 6]));
		expect(remapSeen("all", [1])).toBe("all");
	});
});
