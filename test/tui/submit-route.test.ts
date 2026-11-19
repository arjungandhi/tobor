import { describe, expect, it } from "vitest";
import { DraftStore, RequestIds, routeSubmit, shorten } from "../../src/tui/screens/session.js";

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

describe("DraftStore", () => {
	it("keeps a draft per key and hands it back once", () => {
		const drafts = new DraftStore();
		drafts.stash("1", "draft for one");
		drafts.stash("", "no session");
		expect(drafts.take("2")).toBeUndefined();
		expect(drafts.take("1")).toBe("draft for one");
		expect(drafts.take("1")).toBeUndefined();
		expect(drafts.take("")).toBe("no session");
	});

	it("forgets a key stashed with blank text", () => {
		const drafts = new DraftStore();
		drafts.stash("1", "old");
		drafts.stash("1", "  ");
		expect(drafts.take("1")).toBeUndefined();
	});

	it("drops the oldest drafts beyond the cap", () => {
		const drafts = new DraftStore(2);
		drafts.stash("1", "a");
		drafts.stash("2", "b");
		drafts.stash("3", "c");
		expect(drafts.take("1")).toBeUndefined();
		expect(drafts.take("2")).toBe("b");
		expect(drafts.take("3")).toBe("c");
	});
});

describe("shorten", () => {
	it("keeps short text and cuts long text by code points with an ellipsis", () => {
		expect(shorten("hello", 10)).toBe("hello");
		expect(shorten("abcdef", 4)).toBe("abc…");
	});

	it("never splits a surrogate pair", () => {
		const text = "😀".repeat(10);
		expect(shorten(text, 5)).toBe(`${"😀".repeat(4)}…`);
		expect(shorten("😀".repeat(5), 5)).toBe("😀".repeat(5));
	});
});
