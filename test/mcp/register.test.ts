import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerClient } from "../../src/server/mcp/client.js";
import { mcpToolModule } from "../../src/server/mcp/register.js";
import type { Tool } from "../../src/tools/registry.js";
import { ECHO_SCHEMA, echoServer } from "./fixtures/echo-server.js";

type Harnessed = {
	client: McpServerClient;
	servers: Server[];
	tools: Map<string, Tool>;
	/** Resolves when the client reaches `status`. */
	reach: (status: McpServerClient["status"]) => Promise<void>;
};

const open: McpServerClient[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((c) => c.close()));
});

async function connect(options: { up?: () => boolean } = {}): Promise<Harnessed> {
	const servers: Server[] = [];
	const waiters: { status: string; resolve: () => void }[] = [];
	const client = new McpServerClient(
		"echo",
		{ type: "stdio", command: "unused" },
		{
			backoff: { initialMs: 1, maxMs: 2 },
			onChange: (c) => {
				for (const w of waiters.splice(0)) {
					if (w.status === c.status) w.resolve();
					else waiters.push(w);
				}
			},
			connectTimeoutMs: 2_000,
			transport: () => {
				if (options.up && !options.up()) throw new Error("server down");
				const [a, b] = InMemoryTransport.createLinkedPair();
				const server = echoServer();
				servers.push(server);
				void server.connect(b);
				return a;
			},
		},
	);
	open.push(client);
	await client.start();
	const tools = new Map(mcpToolModule([client]).tools.map((t) => [t.name, t]));
	const reach = (status: McpServerClient["status"]): Promise<void> => {
		if (client.status === status) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ status, resolve });
		return promise;
	};
	return { client, servers, tools, reach };
}

function run(tool: Tool | undefined, args: object) {
	if (!tool) throw new Error("tool missing");
	return tool.execute(args as never, {} as never, { abortSignal: undefined } as never);
}

describe("MCP tool registration", () => {
	it("registers mcp__<server>__<tool> with the schema passed through", async () => {
		const { client, tools } = await connect();
		expect(client.status).toBe("connected");
		expect([...tools.keys()]).toEqual([
			"mcp__echo__echo",
			"mcp__echo__fail",
			"mcp__echo__pic",
			"mcp__echo__env",
			"mcp__echo__crash",
		]);
		const echo = tools.get("mcp__echo__echo")!;
		expect(echo.parameters).toEqual(ECHO_SCHEMA);
		expect(echo.description).toBe("Echo text back");
		expect(echo.replay).toBe("unsafe");
		expect(tools.get("mcp__echo__fail")!.description).toBe("fail (MCP server echo)");
	});

	it("round-trips a call", async () => {
		const { tools } = await connect();
		const result = await run(tools.get("mcp__echo__echo"), { text: "hi", times: 2 });
		expect(result.isError).toBeUndefined();
		expect(result.output).toEqual([{ type: "text", text: "hihi" }]);
		expect(result.details).toEqual({ server: "echo", tool: "echo" });
	});

	it("maps tool errors and non-text content", async () => {
		const { tools } = await connect();
		const fail = await run(tools.get("mcp__echo__fail"), {});
		expect(fail.isError).toBe(true);
		expect(fail.output).toEqual([{ type: "text", text: "it broke" }]);
		const pic = await run(tools.get("mcp__echo__pic"), {});
		expect(pic.output).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		expect(pic.details).toEqual({
			server: "echo",
			tool: "pic",
			content: [{ type: "resource_link", uri: "file:///x", name: "x" }],
		});
	});

	it("returns an error result while the server is down, then reconnects", async () => {
		let up = true;
		const { client, servers, tools, reach } = await connect({ up: () => up });
		up = false;
		await servers[0]!.close();
		await reach("error");
		const down = await run(tools.get("mcp__echo__echo"), { text: "x" });
		expect(down.isError).toBe(true);
		expect(down.output).toEqual([{ type: "text", text: expect.stringContaining("MCP server echo is unavailable") }]);
		up = true;
		await reach("connected");
		const back = await run(tools.get("mcp__echo__echo"), { text: "ok" });
		expect(back.output).toEqual([{ type: "text", text: "ok" }]);
		expect(servers.length).toBeGreaterThan(1);
	});

	it("falls back to an open object for schemas pi-schema cannot compile", async () => {
		const { client } = await connect();
		client.tools = [{ name: "odd", inputSchema: { type: "object", properties: { a: { type: "string", pattern: "(" } } } }];
		const [odd] = mcpToolModule([client]).tools;
		expect(odd!.parameters).toMatchObject({ type: "object" });
		expect(odd!.parameters).not.toHaveProperty("properties.a");
	});
});
