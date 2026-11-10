// MCP tool names and the `config.yml: mcp.approval` mapping.
import type { McpApprovalPolicy } from "../../config/schema.js";

/** Server names usable in `mcp__<server>__<tool>`: letters, digits, `-`, single `_`. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** The registered name of an MCP tool; characters a model API rejects become `_`. */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Split a registered name into server and (sanitized) tool; undefined for non-MCP names. */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
	if (!name.startsWith("mcp__")) return undefined;
	const rest = name.slice(5);
	const at = rest.indexOf("__");
	if (at <= 0 || at + 2 >= rest.length) return undefined;
	return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/**
 * Whether a call to the MCP tool `toolName` needs approval in `ask` mode. Unlisted servers and tools ask; `auto` and
 * `allow` lists apply to node servers only, so a project server never loosens approval. Non-MCP names are not gated here.
 */
export function isGated(
	toolName: string,
	approval: Readonly<Record<string, McpApprovalPolicy>>,
	projectServers: ReadonlySet<string> = new Set(),
): boolean {
	const parsed = parseMcpToolName(toolName);
	if (!parsed) return false;
	if (projectServers.has(parsed.server)) return true;
	const policy = Object.hasOwn(approval, parsed.server) ? approval[parsed.server] : undefined;
	if (policy === undefined || policy === "ask") return true;
	if (policy === "auto") return false;
	const listed = (names: string[]) => names.some((n) => mcpToolName(parsed.server, n) === toolName);
	if (listed(policy.ask)) return true;
	return !listed(policy.allow);
}
