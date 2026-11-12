import { describe, expect, it } from "vitest";
import { commandRows } from "../../src/tui/command-rows.js";

const names = (query: string): string[] => commandRows(query).map((cmd) => cmd.name);

describe("commandRows", () => {
	it("matches commands by name prefix, case-insensitively", () => {
		expect(names("sch")).toEqual(["schedules"]);
		expect(names("SCHED")).toEqual(["schedules"]);
		expect(names("s")).toEqual(expect.arrayContaining(["sessions", "schedules", "settings"]));
		expect(names("ched")).toEqual([]);
	});

	it("matches on the first word only and carries the description", () => {
		expect(commandRows("schedules foo")).toEqual([{ name: "schedules", description: "scheduled prompts" }]);
	});

	it("offers nothing for an empty query", () => {
		expect(commandRows("")).toEqual([]);
	});

	it("excludes commands that require arguments but keeps optional ones", () => {
		expect(names("attach")).toEqual([]);
		expect(names("title")).toEqual([]);
		expect(names("approval")).toEqual(["approvals"]);
		expect(names("artifacts")).toEqual(["artifacts"]);
	});
});
