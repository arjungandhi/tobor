import { describe, expect, it } from "vitest";
import { RequestIds, routeSubmit } from "../../src/tui/screens/session.js";

describe("routeSubmit", () => {
	it("sends plain text as a prompt and slash text as a command when no question is pending", () => {
		expect(routeSubmit("hello", false)).toBe("prompt");
		expect(routeSubmit("/sessions", false)).toBe("command");
		expect(routeSubmit("/tmp/x", false)).toBe("command");
	});

	it("answers a pending question with plain text", () => {
		expect(routeSubmit("yes", true)).toBe("answer");
	});

	it("answers a pending question with a path starting with a slash", () => {
		expect(routeSubmit("/tmp/x", true)).toBe("answer");
		expect(routeSubmit("/sessionsfoo", true)).toBe("answer");
	});

	it("runs a known command even while a question is pending", () => {
		expect(routeSubmit("/sessions", true)).toBe("command");
		expect(routeSubmit("/title new name", true)).toBe("command");
	});

	it("keeps /attach special-cased", () => {
		expect(routeSubmit("/attach a.png", false)).toBe("attach");
		expect(routeSubmit("/attach clear", true)).toBe("attach");
		expect(routeSubmit("/attachment", true)).toBe("answer");
	});

	it("falls through to a prompt for empty text with a question pending", () => {
		expect(routeSubmit("", true)).toBe("prompt");
	});
});

describe("RequestIds", () => {
	it("reuses the id for the same text until it succeeds", () => {
		const ids = new RequestIds();
		const first = ids.for("hello");
		expect(ids.for("hello")).toBe(first);
		ids.done();
		expect(ids.for("hello")).not.toBe(first);
	});

	it("issues a fresh id when the text diverges", () => {
		const ids = new RequestIds();
		const first = ids.for("hello");
		const other = ids.for("hello world");
		expect(other).not.toBe(first);
		expect(ids.for("hello")).not.toBe(first);
	});
});
