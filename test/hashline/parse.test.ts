import { describe, expect, it } from "vitest";
import { parsePatch } from "../../src/tools/hashline/parse.js";

const ok = (input: string) => {
	const r = parsePatch(input);
	if (!r.ok) throw new Error(r.error.message);
	return r.sections;
};
const error = (input: string) => {
	const r = parsePatch(input);
	if (r.ok) throw new Error("expected a parse error");
	return r.error;
};

describe("parsePatch", () => {
	it("parses every v3.0 op and target", () => {
		const s = ok(
			[
				"[a.txt#ABCD]",
				"PUT 2.=3:",
				"+x",
				"+",
				"++plus",
				"+-minus",
				"PUT <1:",
				"+head",
				"PUT >4:",
				"+after",
				"PUT >$:",
				"+tail",
				"MV dir/b.txt",
				"[c#d.txt#0F0F]",
				"REM",
				'[e.txt#1234]',
				'MV "with space/f.txt"',
			].join("\n"),
		);
		expect(s).toHaveLength(3);
		expect(s[0]!.path).toBe("a.txt");
		expect(s[0]!.tag).toBe("ABCD");
		expect(s[0]!.ops).toEqual([
			{ kind: "put", target: { kind: "replace", start: 2, end: 3 }, body: ["x", "", "+plus", "-minus"], line: 2 },
			{ kind: "put", target: { kind: "before", line: 1 }, body: ["head"], line: 7 },
			{ kind: "put", target: { kind: "after", line: 4 }, body: ["after"], line: 9 },
			{ kind: "put", target: { kind: "append" }, body: ["tail"], line: 11 },
			{ kind: "mv", dest: "dir/b.txt", line: 13 },
		]);
		expect(s[1]!.path).toBe("c#d.txt");
		expect(s[1]!.ops).toEqual([{ kind: "rem", line: 15 }]);
		expect(s[2]!.ops).toEqual([{ kind: "mv", dest: "with space/f.txt", line: 17 }]);
	});

	it("strips the Begin/End Patch wrapper, CRLF input and blank lines between ops", () => {
		const s = ok("*** Begin Patch\r\n[a#ABCD]\r\n\r\nPUT >$:\r\n+x\r\n\r\nREM\r\n*** End Patch\r\n");
		expect(s[0]!.ops.map((o) => o.kind)).toEqual(["put", "rem"]);
	});

	it("keeps a header without # as an untagged section", () => {
		expect(ok("[a.txt]\nREM")[0]!.tag).toBeUndefined();
	});

	it.each([
		["[a#ABCD]\nPUT 3*:\n+x", /block anchors \(\*\) are not supported; use an explicit range N\.=M/],
		["[a#ABCD]\nPUT >3*:\n+x", /block anchors/],
		["[a#ABCD]\nCUT 1.=2", /CUT, pastes and registers are not supported/],
		["[a#ABCD]\nPUT <3 @reg", /CUT, pastes and registers are not supported/],
		["[a#ABCD]\nPUT <3", /CUT, pastes and registers/],
		["[a#ABCD]\nPUT 1.=2:\n", /needs at least one \+ row/],
		["[a#ABCD]\nPUT 1.=2:\nREM", /line 2: PUT … : needs at least one \+ row/],
		["[a#ABCD]\nREM\n+x", /body row under REM/],
		["[a#ABCD]\nMV b\n+x", /body row under MV/],
		["[a#ABCD]\n+x", /body row before any op/],
		["+x", /outside a section/],
		["PUT >$:\n+x", /expected a \[PATH#TAG\] header/],
		["[a#ABCD]\n@@ -1,2 +1,2 @@", /unified-diff rows/],
		["[a#ABCD]\n-old", /unified-diff rows/],
		["[a#ABCD]\nPUT 1.=1:\n+x\n context", /unified-diff rows/],
		["[a#ABCD]\nPUT 1.=1:\n+x\n\n+y", /empty line inside a PUT body/],
		["[a#ABCD]\nMV", /bad MV destination/],
		["[a#ABCD]\nMV a b", /bad MV destination/],
		['[a#ABCD]\nMV "a b', /bad MV destination/],
		["[a#ABCD]\nPUT x:\n+y", /bad PUT target/],
		["[a#ABCD]\nPUT 1-2:\n+y", /bad PUT target/],
		["[a#ABCD]\nFROB", /unknown op/],
		["[#ABCD]\nREM", /path is empty/],
		["[a#ABCD\nREM", /bad header/],
		["", /empty patch/],
	])("rejects %j", (input, message) => {
		const e = error(input);
		expect(e.kind).toBe("parse");
		expect(e.message).toMatch(message);
	});

	it("reports a section without ops as header_only", () => {
		expect(error("[a#ABCD]\n[b#ABCD]\nREM").kind).toBe("header_only");
		expect(error("[a#ABCD]").kind).toBe("header_only");
	});
});
