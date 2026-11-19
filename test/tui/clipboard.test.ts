import { describe, expect, it } from "vitest";
import { offersText, pickImageType, stripPasteMarkers } from "../../src/tui/clipboard.js";

describe("pickImageType", () => {
	it("prefers PNG over the other accepted image types", () => {
		expect(pickImageType("image/jpeg\nimage/png\ntext/html\n")).toBe("image/png");
		expect(pickImageType("image/webp\nimage/gif\n")).toBe("image/gif");
		expect(pickImageType("image/webp\n")).toBe("image/webp");
	});

	it("ignores types attachments do not accept and non-image clipboards", () => {
		expect(pickImageType("image/bmp\nimage/svg+xml\n")).toBeUndefined();
		expect(pickImageType("text/plain\nUTF8_STRING\n")).toBeUndefined();
		expect(pickImageType("")).toBeUndefined();
	});

	it("tolerates CRLF and case differences", () => {
		expect(pickImageType("TEXT/PLAIN\r\nImage/PNG\r\n")).toBe("image/png");
	});
});

describe("offersText", () => {
	it("is true for plain-text types", () => {
		expect(offersText("text/plain;charset=utf-8\ntext/html\n")).toBe(true);
		expect(offersText("UTF8_STRING\n")).toBe(true);
	});

	it("is false for images and rich text only", () => {
		expect(offersText("image/png\n")).toBe(false);
		expect(offersText("text/html\n")).toBe(false);
	});
});

describe("stripPasteMarkers", () => {
	it("removes both bracketed-paste markers", () => {
		expect(stripPasteMarkers("a\x1b[201~b\x1b[200~c")).toBe("abc");
	});

	it("removes markers spliced together by an earlier removal", () => {
		expect(stripPasteMarkers("\x1b[2\x1b[201~01~x")).toBe("x");
	});

	it("leaves ordinary text and other escapes alone", () => {
		expect(stripPasteMarkers("plain \x1b[31mred\x1b[0m")).toBe("plain \x1b[31mred\x1b[0m");
	});
});
