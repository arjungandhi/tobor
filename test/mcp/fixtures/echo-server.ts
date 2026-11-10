// A tiny MCP server: `echo`, `fail`, `pic`, `env` and `crash` tools. Used in-memory and as a stdio child.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The echo tool's input schema, as the server lists it. */
export const ECHO_SCHEMA = {
	type: "object",
	properties: { text: { type: "string", description: "Text to echo" }, times: { type: "integer", minimum: 1 } },
	required: ["text"],
	additionalProperties: false,
};

/** A fresh server instance (one per connection). */
export function echoServer(): Server {
	const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{ name: "echo", description: "Echo text back", inputSchema: ECHO_SCHEMA },
			{ name: "fail", inputSchema: { type: "object" } },
			{ name: "pic", inputSchema: { type: "object" } },
			{ name: "env", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
			{ name: "crash", inputSchema: { type: "object" } },
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, (req) => {
		const args = req.params.arguments ?? {};
		switch (req.params.name) {
			case "echo":
				return { content: [{ type: "text", text: String(args.text).repeat(Number(args.times ?? 1)) }] };
			case "fail":
				return { isError: true, content: [{ type: "text", text: "it broke" }] };
			case "pic":
				return {
					content: [
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						{ type: "resource_link", uri: "file:///x", name: "x" },
					],
				};
			case "env":
				return { content: [{ type: "text", text: process.env[String(args.name)] ?? "<unset>" }] };
			case "crash":
				process.exit(1);
		}
		throw new Error(`unknown tool ${req.params.name}`);
	});
	return server;
}

if (process.argv.includes("--stdio")) await echoServer().connect(new StdioServerTransport());
