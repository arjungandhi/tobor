import { describe, expect, it } from "vitest";
import { indexOfValue, pickHint } from "../../src/tui/pick-model.js";

const rows = [{ value: "0" }, { value: "3" }, { value: "7" }];

describe("indexOfValue", () => {
	it("finds the previously selected row by value, wherever it moved to", () => {
		expect(indexOfValue(rows, "7")).toBe(2);
		expect(indexOfValue([{ value: "7" }], "7")).toBe(0);
	});

	it("falls back to the first row when there was no selection or it is no longer shown", () => {
		expect(indexOfValue(rows, undefined)).toBe(0);
		expect(indexOfValue(rows, "9")).toBe(0);
		expect(indexOfValue([], "3")).toBe(0);
	});
});

describe("pickHint", () => {
	const base = { itemCount: 3, query: undefined, hint: "Enter select · n new · Esc close", emptyHint: "Esc back", commands: false };

	it("adds the filter advert to the caller's hint", () => {
		expect(pickHint(base)).toBe("Enter select · n new · Esc close · / filter");
		expect(pickHint({ ...base, commands: true })).toBe("Enter select · n new · Esc close · / filter or command");
	});

	it("says filtering is on and that Esc clears it, without advertising row actions", () => {
		const hint = pickHint({ ...base, query: "ab" });
		expect(hint).toContain("filtering /ab");
		expect(hint).toContain("Esc clear filter");
		expect(hint).not.toContain("n new");
		expect(pickHint({ ...base, query: "" })).toContain("Esc clear filter");
	});

	it("shows only the empty-state hint on an empty list", () => {
		expect(pickHint({ ...base, itemCount: 0 })).toBe("Esc back");
		expect(pickHint({ ...base, itemCount: 0, emptyHint: "n new · Esc back" })).toBe("n new · Esc back");
	});
});
