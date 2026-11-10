import { describe, expect, it } from "vitest";
import { isGated, MCP_SERVER_NAME, mcpToolName, parseMcpToolName } from "../../src/server/mcp/approval.js";

describe("mcp tool names", () => {
	it("prefixes and sanitizes", () => {
		expect(mcpToolName("github", "list_issues")).toBe("mcp__github__list_issues");
		expect(mcpToolName("fs", "read.file/v2")).toBe("mcp__fs__read_file_v2");
	});

	it("parses at the first double underscore after the prefix", () => {
		expect(parseMcpToolName("mcp__github__list__issues")).toEqual({ server: "github", tool: "list__issues" });
		expect(parseMcpToolName("mcp__my_srv__x")).toEqual({ server: "my_srv", tool: "x" });
		expect(parseMcpToolName("bash")).toBeUndefined();
		expect(parseMcpToolName("mcp__github__")).toBeUndefined();
		expect(parseMcpToolName("mcp____x")).toBeUndefined();
	});

	it("restricts server names so parsing is unambiguous", () => {
		expect(MCP_SERVER_NAME.test("my_srv-2")).toBe(true);
		expect(MCP_SERVER_NAME.test("a__b")).toBe(false);
		expect(MCP_SERVER_NAME.test("_a")).toBe(false);
		expect(MCP_SERVER_NAME.test("a.b")).toBe(false);
	});
});

describe("isGated", () => {
	const approval = {
		auto: "auto" as const,
		ask: "ask" as const,
		github: { allow: ["list_issues", "get.thing"], ask: ["create_issue"] },
		both: { allow: ["x"], ask: ["x"] },
	};

	it("defaults to ask for unlisted servers", () => {
		expect(isGated("mcp__other__t", approval)).toBe(true);
		expect(isGated("mcp__other__t", {})).toBe(true);
	});

	it("maps auto and ask", () => {
		expect(isGated("mcp__auto__t", approval)).toBe(false);
		expect(isGated("mcp__ask__t", approval)).toBe(true);
	});

	it("maps allow and ask lists, unlisted tools ask", () => {
		expect(isGated("mcp__github__list_issues", approval)).toBe(false);
		expect(isGated("mcp__github__get_thing", approval)).toBe(false);
		expect(isGated("mcp__github__create_issue", approval)).toBe(true);
		expect(isGated("mcp__github__delete_repo", approval)).toBe(true);
		expect(isGated("mcp__both__x", approval)).toBe(true);
	});

	it("never loosens approval for project servers", () => {
		expect(isGated("mcp__auto__t", approval, new Set(["auto"]))).toBe(true);
		expect(isGated("mcp__github__list_issues", approval, new Set(["github"]))).toBe(true);
	});

	it("ignores non-MCP tools and prototype keys", () => {
		expect(isGated("bash", approval)).toBe(false);
		expect(isGated("mcp__toString__t", approval)).toBe(true);
	});
});
