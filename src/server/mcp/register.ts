// MCP tools as pi-durable tools named `mcp__<server>__<tool>`.
import type { JsonValue } from "@earendil-works/chord/json";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { compile, obj } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolModule } from "../../tools/registry.js";
import { mcpToolName } from "./approval.js";
import type { McpServerClient, McpToolInfo } from "./client.js";

/** `details` of an MCP tool result. */
export type McpToolDetails = {
	server: string;
	tool: string;
	/** Content blocks other than text and image (audio, resources, links). */
	content?: JsonValue[];
	structured?: JsonValue;
};

/** One `defineTool` per listed tool of every client; tools of a down server stay and return error results. */
export function mcpToolModule(clients: Iterable<McpServerClient>): ToolModule {
	const tools: Tool[] = [];
	const seen = new Set<string>();
	for (const client of clients) {
		for (const info of client.tools) {
			const name = mcpToolName(client.name, info.name);
			if (seen.has(name)) continue;
			seen.add(name);
			tools.push(mcpTool(client, info));
		}
	}
	return { tools };
}

/** The pi-durable tool for one MCP tool. */
export function mcpTool(client: McpServerClient, info: McpToolInfo): Tool {
	const tool = info.name;
	const details = (extra: Partial<McpToolDetails> = {}): JsonValue => ({ server: client.name, tool, ...extra }) as JsonValue;
	return defineTool<object>({
		name: mcpToolName(client.name, tool),
		description: info.description ?? `${tool} (MCP server ${client.name})`,
		parameters: parameters(info.inputSchema),
		replay: "unsafe",
		async execute(args, _api, context): Promise<ToolExecutionResult> {
			let result: CallToolResult;
			try {
				result = await client.callTool(tool, args as Record<string, unknown>, context.abortSignal);
			} catch (err) {
				const text = err instanceof Error ? err.message : String(err);
				return { isError: true, output: [{ type: "text", text }], details: details() };
			}
			return toResult(result, details);
		},
	});
}

/** Map an MCP `CallToolResult`: text and images to `output`, everything else to `details`. */
export function toResult(
	result: CallToolResult,
	details: (extra?: Partial<McpToolDetails>) => JsonValue,
): ToolExecutionResult {
	const output: (TextContent | ImageContent)[] = [];
	const other: JsonValue[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") output.push({ type: "text", text: block.text });
		else if (block.type === "image") output.push({ type: "image", data: block.data, mimeType: block.mimeType });
		else other.push(block as JsonValue);
	}
	const structured = result.structuredContent as JsonValue | undefined;
	if (output.length === 0) {
		const text =
			structured !== undefined
				? JSON.stringify(structured)
				: other.length > 0
					? `(${other.length} non-text content block${other.length === 1 ? "" : "s"})`
					: "(no output)";
		output.push({ type: "text", text });
	}
	return {
		output,
		...(result.isError ? { isError: true } : {}),
		details: details({
			...(other.length > 0 ? { content: other } : {}),
			...(structured !== undefined ? { structured } : {}),
		}),
	};
}

/** The server's JSON Schema as-is when pi-schema compiles it, else an open object. */
function parameters(schema: Record<string, unknown>): object {
	try {
		compile(schema, { formats, coerce: true, unresolvedRefs: "reject" });
		return schema;
	} catch {
		return obj({}, { open: true });
	}
}
