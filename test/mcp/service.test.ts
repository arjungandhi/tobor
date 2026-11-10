import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeEvent } from "../../src/api/types.js";
import type { Config } from "../../src/config/schema.js";
import { EventBus } from "../../src/events.js";
import { expandSpec, McpServiceImpl, type McpServiceOptions } from "../../src/server/mcp/service.js";
import type { ToolModule } from "../../src/tools/registry.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { echoServer } from "./fixtures/echo-server.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));
const stdio = (env?: Record<string, string>) => ({
	type: "stdio",
	command: process.execPath,
	args: [fixture, "--stdio"],
	...(env ? { env } : {}),
});

let dir = "";
let service: McpServiceImpl | undefined;
afterEach(async () => {
	await service?.close();
	service = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup(node: unknown, project?: unknown, extra: Partial<McpServiceOptions> = {}) {
	dir = await mkdtemp(join(tmpdir(), "tobor-mcp-"));
	const nodeFile = join(dir, "node", "mcp.json");
	await mkdir(join(dir, "node"), { recursive: true });
	await writeFile(nodeFile, JSON.stringify(node));
	if (project !== undefined) {
		await mkdir(join(dir, "proj", ".tobor"), { recursive: true });
		await writeFile(join(dir, "proj", ".tobor", "mcp.json"), JSON.stringify(project));
	}
	const events: NodeEvent[] = [];
	const bus = new EventBus();
	bus.onAny((e) => events.push(e));
	const installs: ToolModule[] = [];
	service = new McpServiceImpl({
		nodeFile,
		...(project !== undefined ? { projectRoot: join(dir, "proj") } : {}),
		env: () => ({ TOKEN: "s3cret" }),
		config: () => ({ mcp: { approval: { echo: { allow: ["echo"], ask: [] }, local: "auto" } } }) as unknown as Config,
		events: bus,
		install: (m) => installs.push(m),
		client: { connectTimeoutMs: 15_000 },
		...extra,
	});
	await service.reload();
	return { service, events, installs, nodeFile };
}

describe("McpServiceImpl", () => {
	it("connects stdio servers, expands ${VAR} and installs their tools", async () => {
		const { service, events, installs } = await setup({ servers: { echo: stdio({ SECRET: "${TOKEN}" }) } });
		const [row] = service.status();
		expect(row).toMatchObject({ server: "echo", type: "stdio", status: "connected", tools: 5 });
		expect(row!.toolNames).toContain("mcp__echo__echo");
		expect(events.some((e) => e.type === "mcp.status" && e.status.status === "connected")).toBe(true);
		expect(installs).toHaveLength(1);
		const env = installs[0]!.tools.find((t) => t.name === "mcp__echo__env")!;
		const result = await env.execute({ name: "SECRET" } as never, {} as never, { abortSignal: undefined } as never);
		expect(result.output).toEqual([{ type: "text", text: "s3cret" }]);
		expect(service.needsApproval("mcp__echo__echo")).toBe(false);
		expect(service.needsApproval("mcp__echo__fail")).toBe(true);
	});

	it("reports undefined variables and invalid entries without connecting", async () => {
		const { service } = await setup({
			servers: { bad: { type: "http", url: "http://x/${NOPE}" }, "a.b": stdio(), worse: { type: "ftp" } },
		});
		expect(service.status()).toEqual([
			{
				server: "bad",
				type: "http",
				status: "error",
				error: "undefined variable NOPE (env_file)",
				tools: 0,
				toolNames: [],
			},
		]);
		expect(service.errors.map((e) => e.path)).toEqual([
			expect.stringContaining("servers.worse.type"),
			expect.stringContaining("servers.a.b"),
		]);
	});

	it("keeps project servers disconnected until approved, and always gated", async () => {
		const project = { servers: { local: stdio() } };
		const { service } = await setup({ servers: {} }, project);
		expect(service.status()).toEqual([
			expect.objectContaining({ server: "local", status: "error", error: "project server awaiting approval to connect" }),
		]);
		await service.close();
		const approved = await setup({ servers: {} }, project, { approveConnect: () => true });
		expect(approved.service.status()[0]).toMatchObject({ server: "local", status: "connected" });
		expect(approved.service.needsApproval("mcp__local__echo")).toBe(true);
	});

	it("reload keeps unchanged clients and drops removed servers", async () => {
		const { service, events, installs, nodeFile } = await setup({ servers: { echo: stdio() } });
		const seen = events.length;
		await service.reload();
		expect(events.slice(seen)).toEqual([]);
		expect(installs).toHaveLength(2);
		expect(service.status()[0]!.status).toBe("connected");
		await writeFile(nodeFile, JSON.stringify({ servers: {} }));
		await service.reload();
		expect(service.status()).toEqual([]);
		expect(installs.at(-1)!.tools).toEqual([]);
	});

	it("connects http servers with static headers", async () => {
		const headers: IncomingHttpHeaders[] = [];
		const http = createServer((req, res) => {
			headers.push(req.headers);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			res.on("close", () => void transport.close());
			void echoServer()
				.connect(transport)
				.then(() => transport.handleRequest(req, res));
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
			const { service, installs } = await setup({
				servers: { remote: { type: "http", url, headers: { Authorization: "Bearer ${TOKEN}" } } },
			});
			expect(service.status()[0]).toMatchObject({ server: "remote", type: "http", status: "connected", tools: 5 });
			const echo = installs[0]!.tools.find((t) => t.name === "mcp__remote__echo")!;
			const result = await echo.execute({ text: "hey" } as never, {} as never, { abortSignal: undefined } as never);
			expect(result.output).toEqual([{ type: "text", text: "hey" }]);
			expect(headers.length).toBeGreaterThan(0);
			expect(headers.every((h) => h.authorization === "Bearer s3cret")).toBe(true);
		} finally {
			await service?.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		}
	});

	it("returns an error result after the server process dies", async () => {
		const { service, installs } = await setup({ servers: { echo: stdio() } }, undefined, {
			client: { connectTimeoutMs: 15_000, backoff: { initialMs: 60_000, maxMs: 60_000 } },
		});
		const tools = new Map(installs[0]!.tools.map((t) => [t.name, t]));
		const ctx = { abortSignal: undefined } as never;
		const crash = await tools.get("mcp__echo__crash")!.execute({} as never, {} as never, ctx);
		expect(crash.isError).toBe(true);
		expect(service.status()[0]!.status).toBe("error");
		const echo = await tools.get("mcp__echo__echo")!.execute({ text: "x" } as never, {} as never, ctx);
		expect(echo.isError).toBe(true);
	});
});

describe("expandSpec", () => {
	it("expands command, args, env, url and headers", () => {
		const vars = { A: "1", B: "two" };
		expect(expandSpec({ type: "stdio", command: "${A}", args: ["x${B}y"], env: { K: "${A}${B}" } }, vars)).toEqual({
			spec: { type: "stdio", command: "1", args: ["xtwoy"], env: { K: "1two" } },
		});
		expect(
			expandSpec({ type: "http", url: "https://h/${A}", headers: { Authorization: "Bearer ${B}" } }, vars),
		).toEqual({ spec: { type: "http", url: "https://h/1", headers: { Authorization: "Bearer two" } } });
	});

	it("leaves $VAR and unmatched braces alone and reports every missing name", () => {
		expect(expandSpec({ type: "stdio", command: "$A ${", args: ["${X}", "${Y}"] }, { A: "1" })).toEqual({
			spec: { type: "stdio", command: "$A ${", args: ["", ""] },
			error: "undefined variables X, Y (env_file)",
		});
	});
});
