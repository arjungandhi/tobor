import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/tui/keys.js";

describe("slash commands", () => {
	it("lists /upgrade and /restart once each", () => {
		const names = COMMANDS.map((cmd) => cmd.name);
		expect(names).toContain("upgrade");
		expect(names).toContain("restart");
		expect(new Set(names).size).toBe(names.length);
	});
});
