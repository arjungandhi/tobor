import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHEAP_MODEL, parseModelRef } from "../../src/config/schema.js";
import { cleanTitle, resolveTitleModel } from "../../src/server/harness/titles.js";
import { fauxModels } from "./helpers.js";

describe("cleanTitle", () => {
	it("strips quotes, label and trailing punctuation and collapses whitespace", () => {
		expect(cleanTitle('  "Fix   the\tbuild."\nextra line')).toBe("Fix the build");
		expect(cleanTitle("Title: 'Refactor auth flow!'")).toBe("Refactor auth flow");
		expect(cleanTitle("")).toBe("");
		expect(cleanTitle("x".repeat(80))).toHaveLength(60);
	});

	it("removes control characters so a title cannot inject terminal escapes", () => {
		expect(cleanTitle("Fix \x1b[31mred\x1b[0m build\x07")).toBe("Fix [31mred[0m build");
		expect(cleanTitle("\x1b]0;pwned\x07Real title")).toBe("]0;pwnedReal title");
		expect(cleanTitle("a\x7fb\x00c")).toBe("abc");
	});

	it("strips list markers and markdown around the label", () => {
		expect(cleanTitle("- Fix the build")).toBe("Fix the build");
		expect(cleanTitle("* Fix the build")).toBe("Fix the build");
		expect(cleanTitle("1. Fix the build")).toBe("Fix the build");
		expect(cleanTitle("**Title:** Foo")).toBe("Foo");
		expect(cleanTitle("- **Title:** \"Foo\".")).toBe("Foo");
	});

	it("re-strips punctuation exposed by the 60-character cut", () => {
		expect(cleanTitle(`${"x".repeat(58)}, tail`)).toBe("x".repeat(58));
		expect(cleanTitle(`${"x".repeat(59)} tail`)).toBe("x".repeat(59));
	});
});

describe("resolveTitleModel", () => {
	const session = { provider: "faux", modelId: "m" };
	it("prefers the configured model, then falls back to the session's, else undefined", async () => {
		const { models } = fauxModels();
		expect((await resolveTitleModel(models, "faux-title/t", session))?.id).toBe("t");
		// default cheap model (anthropic) is not registered in the faux registry
		expect((await resolveTitleModel(models, undefined, session))?.id).toBe("m");
		expect((await resolveTitleModel(models, "nope/none", session))?.id).toBe("m");
		expect(await resolveTitleModel(models, "nope/none", undefined)).toBeUndefined();
		expect(await resolveTitleModel(models, "nope/none", { provider: "x", modelId: "y" })).toBeUndefined();
	});

	it("falls back to the cheap default when the configured model is unavailable, before the session's model", async () => {
		const { models } = fauxModels();
		const cheap = parseModelRef(DEFAULT_CHEAP_MODEL)!;
		models.setProvider(fauxProvider({ provider: cheap.provider, models: [{ id: cheap.modelId }] }).provider);
		expect((await resolveTitleModel(models, "nope/none", session))?.id).toBe(cheap.modelId);
		expect((await resolveTitleModel(models, undefined, session))?.id).toBe(cheap.modelId);
		expect((await resolveTitleModel(models, "faux-title/t", session))?.id).toBe("t");
	});
});
