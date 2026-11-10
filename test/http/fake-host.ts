import { request } from "node:http";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { WatchCall, WatchEnd } from "@earendil-works/chord/watch";
import type { ConversationWatch } from "@earendil-works/pi-durable";
import { EventBus } from "../../src/events.js";
import type { Host } from "../../src/host.js";

export type Call = { method: string; args: unknown[] };

/** A controllable watch handle. */
export class FakeWatch {
	listener: ((call: WatchCall<unknown>, ctx: Context) => Promise<void>) | undefined;
	stopped = false;
	private readonly end = Promise.withResolvers<WatchEnd>();
	readonly closed = this.end.promise;
	constructor(readonly value: unknown) {}
	start(listener: (call: WatchCall<unknown>, ctx: Context) => Promise<void>): void {
		this.listener = listener;
	}
	async stop(): Promise<WatchEnd> {
		this.stopped = true;
		this.end.resolve({ kind: "stopped" });
		return { kind: "stopped" };
	}
	finish(end: WatchEnd): void {
		this.end.resolve(end);
	}
	async emit(ops: unknown[]): Promise<void> {
		await this.listener!({ kind: "value", value: this.value, ops: ops as never, retired: false }, BACKGROUND_CONTEXT);
	}
}

/** Build a Host whose services record calls and return `results[method]` (a value or a function of the args). */
export function fakeHost(results: Record<string, unknown> = {}) {
	const calls: Call[] = [];
	const service = (prefix: string) =>
		new Proxy(
			{},
			{
				get(_t, prop: string) {
					const method = `${prefix}.${prop}`;
					return (...args: unknown[]) => {
						calls.push({ method, args });
						const r = results[method];
						const v = typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : r;
						return method === "mcp.status" || method === "artifacts.chrome" ? v : Promise.resolve(v);
					};
				},
			},
		);
	const events = new EventBus();
	const host = {
		home: "/srv/tobor",
		config: {
			listen: { host: "127.0.0.1", port: 0 },
			artifacts_listen: { host: "127.0.0.1", port: 0 },
			artifacts_url: "http://127.0.0.1:4001",
		},
		ctx: BACKGROUND_CONTEXT,
		sessions: service("sessions"),
		approvals: service("approvals"),
		questions: service("questions"),
		workers: service("workers"),
		schedules: service("schedules"),
		artifacts: service("artifacts"),
		mcp: service("mcp"),
		auth: service("auth"),
		agentData: service("agentData"),
		events,
		whoami: () => results.whoami,
	} as unknown as Host;
	return { host, calls, events };
}

export type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: unknown; raw: Buffer };

/** Raw HTTP request (lets tests set Host and Origin freely). */
export function http(
	port: number,
	method: string,
	path: string,
	options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
	const { promise, resolve, reject } = Promise.withResolvers<Res>();
	const payload = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
	const headers: Record<string, string> = { host: "127.0.0.1", ...options.headers };
	if (payload !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
	const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			const raw = Buffer.concat(chunks);
			let body: unknown = raw.toString();
			try {
				body = JSON.parse(raw.toString());
			} catch {}
			resolve({ status: res.statusCode ?? 0, headers: res.headers, body, raw });
		});
	});
	req.on("error", reject);
	if (payload !== undefined) req.end(payload);
	else req.end();
	return promise;
}

export type { ConversationWatch };
