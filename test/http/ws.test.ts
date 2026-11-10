import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HostError } from "../../src/host.js";
import { type Listener, startApi } from "../../src/server/http/server.js";
import { FakeWatch, fakeHost } from "./fake-host.js";

let servers: Listener[] = [];
afterEach(async () => {
	await Promise.all(servers.map((s) => s.close()));
	servers = [];
});

/** Connect and collect frames; resolves once open (or with the HTTP status on rejection). */
async function connect(port: number, path: string) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
	const frames: unknown[] = [];
	const waiters: (() => void)[] = [];
	ws.on("message", (d) => {
		frames.push(JSON.parse(String(d)));
		for (const w of waiters.splice(0)) w();
	});
	const closed = Promise.withResolvers<void>();
	ws.on("close", () => closed.resolve());
	const opened = Promise.withResolvers<number>();
	ws.on("open", () => opened.resolve(101));
	ws.on("unexpected-response", (_req, res) => opened.resolve(res.statusCode ?? 0));
	ws.on("error", () => opened.resolve(0));
	const status = await opened.promise;
	const until = async (n: number) => {
		while (frames.length < n) {
			const p = Promise.withResolvers<void>();
			waiters.push(p.resolve);
			await p.promise;
		}
	};
	return { ws, frames, status, until, closed: closed.promise };
}

async function start(results: Record<string, unknown>) {
	const f = fakeHost(results);
	const s = await startApi(f.host);
	servers.push(s);
	return { ...f, port: s.address.port };
}

describe("watch socket", () => {
	it("sends snapshot then ops in order, end on watch end, passes window", async () => {
		const watch = new FakeWatch({ entries: [1] });
		const { port, calls } = await start({ "sessions.watch": watch });
		const from = encodeURIComponent(JSON.stringify({ tail: 10 }));
		const c = await connect(port, `/api/sessions/5/watch?from=${from}`);
		expect(c.status).toBe(101);
		await c.until(1);
		expect(c.frames[0]).toEqual({ t: "snapshot", value: { entries: [1] } });
		expect(calls[0]?.method).toBe("sessions.watch");
		expect(calls[0]?.args.slice(0, 2)).toEqual([5, { tail: 10 }]);
		await watch.emit([["s", ["a"], 1]]);
		await watch.emit([]);
		await watch.emit([["s", ["b"], 2]]);
		c.ws.send(JSON.stringify({ t: "ping" }));
		await c.until(4);
		expect(c.frames.slice(1)).toEqual([
			{ t: "ops", ops: [["s", ["a"], 1]] },
			{ t: "ops", ops: [["s", ["b"], 2]] },
			{ t: "pong" },
		]);
		watch.finish({ kind: "ended" });
		await c.closed;
		expect(c.frames.at(-1)).toEqual({ t: "end", reason: "ended" });
	});

	it("stops the watch when the client closes", async () => {
		const watch = new FakeWatch({});
		const { port } = await start({ "sessions.watch": watch });
		const c = await connect(port, "/api/sessions/5/watch");
		await c.until(1);
		c.ws.close();
		await c.closed;
		for (let i = 0; i < 50 && !watch.stopped; i++) await new Promise((r) => setImmediate(r));
		expect(watch.stopped).toBe(true);
	});

	it("ends with the error code when the watch cannot start", async () => {
		const { port } = await start({ "sessions.watch": () => Promise.reject(new HostError(404, "not_found", "no session")) });
		const c = await connect(port, "/api/sessions/9/watch");
		await c.closed;
		expect(c.frames).toEqual([{ t: "end", reason: "not_found" }]);
	});

	it("rejects bad from and unknown paths before upgrading", async () => {
		const { port } = await start({});
		expect((await connect(port, "/api/sessions/5/watch?from=%7Bnope")).status).toBe(400);
		expect((await connect(port, "/api/nope")).status).toBe(404);
	});
});

describe("events socket", () => {
	it("forwards bus events and unsubscribes on close", async () => {
		const { port, events } = await start({});
		const c = await connect(port, "/api/events");
		expect(c.status).toBe(101);
		const event = { type: "session.updated", id: 3 } as const;
		events.emit(event);
		await c.until(1);
		expect(c.frames).toEqual([{ t: "event", event }]);
		c.ws.close();
		await c.closed;
		events.emit(event);
	});
});
