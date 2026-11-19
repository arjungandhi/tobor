import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ReconnectingSocket, type SocketState } from "../../src/tui/client.js";

type Frame = { n: number };

let wss: WebSocketServer | undefined;
let sock: ReconnectingSocket<Frame> | undefined;

afterEach(async () => {
	sock?.close();
	sock = undefined;
	for (const c of wss?.clients ?? []) c.terminate();
	await new Promise((r) => (wss ? wss.close(r) : r(undefined)));
	wss = undefined;
});

async function serve(onConnection: (ws: WebSocket, count: number) => void): Promise<string> {
	let count = 0;
	wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	wss.on("connection", (ws) => onConnection(ws, ++count));
	await new Promise((r) => wss?.once("listening", r));
	return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe("ReconnectingSocket", () => {
	it("treats a malformed frame as a protocol error: reports, drops and reconnects", async () => {
		const url = await serve((ws, count) => {
			if (count === 1) ws.send("{not json");
			else ws.send(JSON.stringify({ n: 2 }));
		});
		const errors: string[] = [];
		const states: [SocketState, string | undefined][] = [];
		const frames: Frame[] = [];
		sock = new ReconnectingSocket<Frame>({
			url: () => url,
			onFrame: (f) => frames.push(f),
			onError: (m) => errors.push(m),
			onState: (s, d) => states.push([s, d]),
			minDelayMs: 10,
			maxDelayMs: 10,
		});
		sock.start();
		await until(() => frames.length === 1);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^protocol error: malformed frame/);
		const waiting = states.find(([s]) => s === "waiting");
		expect(waiting?.[1]).toContain("protocol error: malformed frame");
		expect(frames).toEqual([{ n: 2 }]);
	});

	it("an explicit reconnect() skips the backoff and does not count as a failed attempt", async () => {
		const opens: number[] = [];
		const url = await serve((_ws, count) => opens.push(count));
		const states: SocketState[] = [];
		sock = new ReconnectingSocket<Frame>({
			url: () => url,
			onFrame: () => {},
			onState: (s) => states.push(s),
			minDelayMs: 60_000, // an organic retry would never happen within the test
			maxDelayMs: 60_000,
		});
		sock.start();
		await until(() => opens.length === 1);
		const t0 = Date.now();
		sock.reconnect();
		await until(() => opens.length === 2);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(states).not.toContain("waiting");
		expect((sock as unknown as { attempt: number }).attempt).toBe(0);
	});

	it("reconnect() while waiting out a backoff connects at once", async () => {
		const opens: number[] = [];
		const url = await serve((ws, count) => {
			opens.push(count);
			if (count === 1) ws.terminate(); // organic failure -> backoff
		});
		const states: SocketState[] = [];
		sock = new ReconnectingSocket<Frame>({ url: () => url, onFrame: () => {}, onState: (s) => states.push(s), minDelayMs: 60_000, maxDelayMs: 60_000 });
		sock.start();
		await until(() => states.includes("waiting"));
		sock.reconnect();
		await until(() => opens.length === 2);
	});

	it("keeps the backoff for organic failures", async () => {
		const url = await serve((ws) => ws.terminate());
		const details: string[] = [];
		sock = new ReconnectingSocket<Frame>({
			url: () => url,
			onFrame: () => {},
			onState: (s, d) => {
				if (s === "waiting" && d) details.push(d);
			},
			minDelayMs: 1000,
			maxDelayMs: 15_000,
		});
		sock.start();
		await until(() => details.length === 1);
		expect(details[0]).toMatch(/retry in 1s/);
		expect((sock as unknown as { attempt: number }).attempt).toBe(1);
	});

	it("drops a silent link after ~1.5 ping intervals and exposes staleness", async () => {
		// A server that never answers pings (ws would auto-pong, so swallow it at the frame level via a raw socket pause).
		const url = await serve((ws) => {
			(ws as unknown as { _socket: { pause(): void } })._socket.pause();
		});
		const errors: string[] = [];
		let waitingDetail: string | undefined;
		let staleSeen = false;
		sock = new ReconnectingSocket<Frame>({
			url: () => url,
			onFrame: () => {},
			onError: (m) => errors.push(m),
			onState: (s, d) => {
				if (s === "waiting") waitingDetail ??= d;
			},
			pingMs: 100,
			minDelayMs: 10_000,
			maxDelayMs: 10_000,
		});
		sock.start();
		await until(() => (sock?.lastReceivedAt ?? 0) > 0);
		const t0 = Date.now();
		await until(() => {
			staleSeen ||= sock?.stale === true;
			return waitingDetail !== undefined;
		});
		expect(staleSeen).toBe(true);
		expect(waitingDetail).toContain("connection timed out");
		expect(Date.now() - t0).toBeLessThan(400);
		expect(sock.lastReceivedAt).toBe(0);
	});
});
