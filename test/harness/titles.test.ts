import { describe, expect, it } from "vitest";
import { cleanTitle, resolveTitleModel } from "../../src/server/harness/titles.js";
import { fauxModels } from "./helpers.js";

describe("cleanTitle", () => {
	it("strips quotes, label and trailing punctuation and collapses whitespace", () => {
		expect(cleanTitle('  "Fix   the\tbuild."\nextra line')).toBe("Fix the build");
		expect(cleanTitle("Title: 'Refactor auth flow!'")).toBe("Refactor auth flow");
		expect(cleanTitle("")).toBe("");
		expect(cleanTitle("x".repeat(80))).toHaveLength(60);
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
});
