// One MCP server connection: stdio or streamable HTTP, tool listing and calls, reconnect with backoff.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpStatus } from "../../api/types.js";
import type { McpServerSpec } from "../../config/schema.js";
import { VERSION } from "../../version.js";

/** One tool as the server lists it. */
export type McpToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown> };

/** Builds the transport for a server; tests substitute in-memory transports. */
export type McpTransportFactory = (server: string, spec: McpServerSpec) => Transport;

/** Thrown by `callTool` when the server is not connected. */
export class McpUnavailableError extends Error {
	constructor(server: string, reason: string | undefined) {
		super(`MCP server ${server} is unavailable${reason ? `: ${reason}` : ""}`);
		this.name = "McpUnavailableError";
	}
}

export type McpClientOptions = {
	/** Default: stdio or streamable HTTP per `spec.type`. */
	transport?: McpTransportFactory;
	/** Timeout of `initialize` and `tools/list`. Default 10s. */
	connectTimeoutMs?: number;
	/** Timeout of one `tools/call`. Default 10 minutes. */
	callTimeoutMs?: number;
	/** Reconnect delays: doubling from `initialMs` up to `maxMs`. Default 1s to 60s. */
	backoff?: { initialMs: number; maxMs: number };
	/** Called on every status or tool-list change. */
	onChange?: (client: McpServerClient) => void;
};

const STDERR_TAIL = 2_000;

/** A client for one configured server that keeps itself connected until `close()`. */
export class McpServerClient {
	status: McpStatus = "connecting";
	error: string | undefined;
	/** Last listed tools; kept while the server is down so registrations stay stable. */
	tools: McpToolInfo[] = [];

	private client: Client | undefined;
	private closed = false;
	private attempt = 0;
	private timer: NodeJS.Timeout | undefined;
	private stderr = "";
	private readonly options: Required<Omit<McpClientOptions, "onChange" | "transport">> &
		Pick<McpClientOptions, "onChange" | "transport">;

	constructor(
		readonly name: string,
		readonly spec: McpServerSpec,
		options: McpClientOptions = {},
	) {
		this.options = {
			connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
			callTimeoutMs: options.callTimeoutMs ?? 600_000,
			backoff: options.backoff ?? { initialMs: 1_000, maxMs: 60_000 },
			...(options.onChange ? { onChange: options.onChange } : {}),
			...(options.transport ? { transport: options.transport } : {}),
		};
	}

	/** Call a tool; throws `McpUnavailableError` while disconnected, rejects on protocol and transport errors. */
	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		const client = this.client;
		if (!client || this.status !== "connected") throw new McpUnavailableError(this.name, this.error);
		try {
			return (await client.callTool({ name: tool, arguments: args }, undefined, {
				timeout: this.options.callTimeoutMs,
				...(signal ? { signal } : {}),
			})) as CallToolResult;
		} catch (err) {
			if (!(err instanceof McpError) && !signal?.aborted && this.client === client) this.drop(client, message(err));
			throw err;
		}
	}

	/** Stop reconnecting and close the connection. */
	async close(): Promise<void> {
		this.closed = true;
		clearTimeout(this.timer);
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => {});
	}

	/** One connection attempt; resolves either way (a failure schedules reconnects). */
	async start(): Promise<void> {
		if (this.closed) return;
		this.set("connecting", undefined);
		this.stderr = "";
		let transport: Transport;
		try {
			transport = this.transport();
		} catch (err) {
			this.fail(message(err));
			return;
		}
		const client = new Client(
			{ name: "tobor", version: VERSION },
			{
				listChanged: {
					tools: {
						autoRefresh: false,
						onChanged: () => {
							if (this.client === client) void this.refresh(client);
						},
					},
				},
			},
		);
		client.onclose = () => {
			if (this.client === client) this.drop(client, this.withStderr("connection closed"));
		};
		try {
			await client.connect(transport, { timeout: this.options.connectTimeoutMs });
			const tools = await this.listAll(client);
			if (this.closed) {
				await client.close().catch(() => {});
				return;
			}
			this.client = client;
			this.attempt = 0;
			this.tools = tools;
			this.set("connected", undefined);
		} catch (err) {
			await client.close().catch(() => {});
			this.fail(this.withStderr(message(err)));
		}
	}

	private transport(): Transport {
		if (this.options.transport) return this.options.transport(this.name, this.spec);
		const spec = this.spec;
		if (spec.type === "http") {
			return new StreamableHTTPClientTransport(new URL(spec.url), {
				requestInit: { headers: spec.headers ?? {} },
			});
		}
		const t = new StdioClientTransport({
			command: spec.command,
			args: spec.args ?? [],
			env: { ...getDefaultEnvironment(), ...spec.env },
			stderr: "pipe",
		});
		t.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
		});
		return t;
	}

	private async listAll(client: Client): Promise<McpToolInfo[]> {
		const out: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : {}, { timeout: this.options.connectTimeoutMs });
			for (const t of page.tools) {
				out.push({
					name: t.name,
					...(t.description ? { description: t.description } : {}),
					inputSchema: t.inputSchema as Record<string, unknown>,
				});
			}
			cursor = page.nextCursor;
		} while (cursor);
		return out;
	}

	private async refresh(client: Client): Promise<void> {
		try {
			const tools = await this.listAll(client);
			if (this.client !== client) return;
			this.tools = tools;
			this.options.onChange?.(this);
		} catch {
			// A failing refresh keeps the previous list; a dead connection surfaces through onclose.
		}
	}

	private drop(client: Client, reason: string): void {
		if (this.client !== client) return;
		this.client = undefined;
		void client.close().catch(() => {});
		this.fail(reason);
	}

	private fail(reason: string): void {
		this.set("error", reason);
		if (this.closed) return;
		const { initialMs, maxMs } = this.options.backoff;
		const delay = Math.min(maxMs, initialMs * 2 ** this.attempt);
		this.attempt++;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.start(), delay);
		this.timer.unref();
	}

	private set(status: McpStatus, error: string | undefined): void {
		if (this.status === status && this.error === error) return;
		this.status = status;
		this.error = error;
		this.options.onChange?.(this);
	}

	private withStderr(reason: string): string {
		const tail = this.stderr.trim().split("\n").slice(-3).join("\n");
		return tail ? `${reason}\n${tail}` : reason;
	}
}

/** Whether an error from `callTool` means the connection failed rather than the tool. */
export function isConnectionError(err: unknown): boolean {
	return err instanceof McpUnavailableError || (err instanceof McpError && err.code === ErrorCode.ConnectionClosed);
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
