import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { hardWrap, oneLine, oneLineStyled, sanitizeText } from "../../src/tui/sanitize.js";

describe("sanitizeText", () => {
	it("removes cursor movement without eating visible text", () => {
		expect(sanitizeText("\x1b[1Aprogress 50%\n\x1b[2Kdone")).toBe("progress 50%\ndone");
	});

	it("removes private-mode and SGR sequences", () => {
		expect(sanitizeText("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
		expect(sanitizeText("\x1b[1;31mred\x1b[0m plain")).toBe("red plain");
	});

	it("removes a CSI cut off at the end of the text", () => {
		expect(sanitizeText("tail\x1b[12")).toBe("tail");
	});

	it("removes two-byte ESC sequences", () => {
		expect(sanitizeText("\x1b(Bplain\x1b=text")).toBe("plaintext");
	});

	it("removes OSC strings ended by BEL or ST", () => {
		expect(sanitizeText("\x1b]0;evil title\x07shown")).toBe("shown");
		expect(sanitizeText("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
	});

	it("removes DCS, APC and PM strings, including an unterminated one at the end", () => {
		expect(sanitizeText("a\x1bPdata\x1b\\b\x1b_apc\x07c\x1b^pm\x1b\\d")).toBe("abcd");
		expect(sanitizeText("keep\x1b]0;never ends")).toBe("keep");
	});

	it("resolves carriage returns as overwrites", () => {
		expect(sanitizeText("a\rb")).toBe("b");
		expect(sanitizeText("10%\r50%\r100%\nnext")).toBe("100%\nnext");
	});

	it("does not lose a line that ends in CRLF", () => {
		expect(sanitizeText("one\r\ntwo\r\n")).toBe("one\ntwo\n");
	});

	it("expands tabs to four spaces", () => {
		expect(sanitizeText("a\tb")).toBe("a    b");
	});

	it("strips BEL, NUL, backspace, DEL, lone ESC and C1 controls but keeps newlines", () => {
		expect(sanitizeText("a\x07b\x00c\x08d\x7fe\x1b\nf\x85g\x9bh\ni")).toBe("abcde\nfgh\ni");
	});

	it("leaves ordinary and wide text alone", () => {
		expect(sanitizeText("héllo 字 ✓\n  indented")).toBe("héllo 字 ✓\n  indented");
	});
});

describe("oneLine", () => {
	it("collapses newlines and whitespace to single spaces", () => {
		expect(oneLine("  first\nsecond \t third\r\n")).toBe("first second third");
	});

	it("sanitizes before collapsing", () => {
		expect(oneLine("\x1b]0;t\x07a\x1b[2K\nb")).toBe("a b");
	});

	it("never returns a newline or escape", () => {
		expect(oneLine("x\n\x1b[1Ay\x1b[?25l\n\nz")).not.toMatch(/[\n\x1b]/);
	});
});

describe("oneLineStyled", () => {
	it("keeps SGR styling but removes every other escape and newline", () => {
		expect(oneLineStyled("\x1b[1;36mtobor\x1b[0m \x1b[2Aa\nb\x1b]0;t\x07")).toBe("\x1b[1;36mtobor\x1b[0m a b");
	});

	it("leaves plain single-line text unchanged", () => {
		expect(oneLineStyled(" host │ cwd ")).toBe(" host │ cwd ");
	});
});

describe("hardWrap", () => {
	it("keeps leading indentation", () => {
		expect(hardWrap("    indented code", 10)).toEqual(["    indent", "ed code"]);
	});

	it("keeps short and empty lines whole", () => {
		expect(hardWrap("short", 10)).toEqual(["short"]);
		expect(hardWrap("", 10)).toEqual([""]);
	});

	it("never exceeds the width and loses no text", () => {
		const text = "  a字b字字cdefghij  ";
		for (const width of [1, 2, 3, 5, 8]) {
			const pieces = hardWrap(text, width);
			for (const piece of pieces) expect(visibleWidth(piece)).toBeLessThanOrEqual(width === 1 ? 2 : width);
			if (width > 1) expect(pieces.join("")).toBe(text);
		}
	});
});
