import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { withCancel } from "@earendil-works/chord/context";
import type { WatchEnd } from "@earendil-works/chord/watch";
import { WebSocket, WebSocketServer } from "ws";
import type { EventsFrame, WatchFrame, WatchWindow } from "../../api/types.js";
import type { Host } from "../../host.js";
import { toApiError } from "./json.js";

/** Pause sending while a socket buffers more than this. */
export const WS_HIGH_WATER = 1024 * 1024;

/** Close an events socket whose buffer stays above `WS_HIGH_WATER` this long, so the client reconnects and refetches. */
export const WS_SATURATED_CLOSE_MS = 30_000;

/** How often a dirty events socket checks whether its buffer has drained. */
const RESYNC_POLL_MS = 100;

const WATCH_PATH = /^\/api\/sessions\/(\d+)\/watch$/;

/** Owns the API's WebSocket endpoints (`/api/sessions/:id/watch`, `/api/events`). */
export class ApiSockets {
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

	constructor(private readonly host: Host) {}

	/** Handle an HTTP upgrade: route or reject. */
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(req.url ?? "/", "http://local");
		if (url.pathname === "/api/events") {
			this.wss.handleUpgrade(req, socket, head, (ws) => this.events(ws));
			return;
		}
		const m = WATCH_PATH.exec(url.pathname);
		if (!m) return reject(socket, 404, "no such socket");
		let window: WatchWindow | undefined;
		const from = url.searchParams.get("from");
		if (from !== null && from !== "") {
			try {
				window = JSON.parse(from) as WatchWindow;
			} catch {
				return reject(socket, 400, "from must be JSON");
			}
			if (typeof window !== "object" || window === null) return reject(socket, 400, "from must be a JSON object");
		}
		const id = Number(m[1]);
		this.wss.handleUpgrade(req, socket, head, (ws) => void this.watch(ws, id, window));
	}

	/** Close every socket (shutdown). */
	close(): void {
		for (const ws of this.wss.clients) ws.close(1001, "shutting down");
		this.wss.close();
	}

	private async watch(ws: WebSocket, id: number, window: WatchWindow | undefined): Promise<void> {
		const { context, cancel } = withCancel(this.host.ctx);
		let closed = false;
		let stop: (() => void) | undefined;
		ws.on("close", () => {
			closed = true;
			stop?.();
			cancel();
		});
		ws.on("message", (data) => {
			if (isPing(data)) sendFrame(ws, { t: "pong" });
		});
		let handle;
		try {
			handle = await this.host.sessions.watch(id, window, context);
		} catch (error) {
			const { body } = toApiError(error);
			endSocket(ws, body.code ?? body.error);
			cancel();
			return;
		}
		const h = handle;
		stop = () => void h.stop();
		if (closed) {
			stop();
			return;
		}
		sendFrame(ws, { t: "snapshot", value: h.value });
		h.start(async (call) => {
			if (call.kind !== "value" || call.ops.length === 0) return;
			await drained(ws);
			if (ws.readyState === WebSocket.OPEN) sendFrame(ws, { t: "ops", ops: call.ops });
		});
		void h.closed.then((end) => {
			endSocket(ws, endReason(end));
			cancel();
		});
	}

	private events(ws: WebSocket): void {
		const bp = new EventBackpressure();
		let timer: NodeJS.Timeout | undefined;
		const stopTimer = () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		};
		const tick = () => {
			if (ws.readyState !== WebSocket.OPEN) return stopTimer();
			const action = bp.poll(ws.bufferedAmount, Date.now());
			if (action === "resync") {
				stopTimer();
				sendFrame(ws, { t: "resync" });
			} else if (action === "close") {
				stopTimer();
				ws.terminate(); // the close frame would queue behind the saturated buffer
			}
		};
		const off = this.host.events.onAny((event) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			if (bp.offer(ws.bufferedAmount, Date.now()) === "drop") {
				timer ??= setInterval(tick, RESYNC_POLL_MS);
				return;
			}
			sendFrame(ws, { t: "event", event });
		});
		ws.on("message", (data) => {
			if (isPing(data)) sendFrame(ws, { t: "pong" });
		});
		ws.on("close", () => {
			off();
			stopTimer();
		});
	}
}

/**
 * Per-connection backpressure bookkeeping for the lossy events socket. A dropped event marks the connection dirty;
 * once the buffer drains, one `resync` is due (however many events were dropped); a buffer that stays saturated past
 * `WS_SATURATED_CLOSE_MS` calls for a close instead.
 */
export class EventBackpressure {
	private dirtySince: number | undefined;

	/** An event is about to be sent with `buffered` bytes queued: send it, or drop it (marking the connection dirty). */
	offer(buffered: number, now: number): "send" | "drop" {
		if (buffered <= WS_HIGH_WATER) return "send";
		this.dirtySince ??= now;
		return "drop";
	}

	/** Periodic check while dirty: `resync` (send one frame, now clean), `close` (saturated too long) or `none`. */
	poll(buffered: number, now: number, closeAfterMs = WS_SATURATED_CLOSE_MS): "none" | "resync" | "close" {
		if (this.dirtySince === undefined) return "none";
		if (buffered <= WS_HIGH_WATER) {
			this.dirtySince = undefined;
			return "resync";
		}
		return now - this.dirtySince >= closeAfterMs ? "close" : "none";
	}
}

/** Resolve once the socket buffers at most `WS_HIGH_WATER` bytes (or is no longer open). */
export async function drained(ws: WebSocket): Promise<void> {
	while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > WS_HIGH_WATER) {
		await sleep(10);
	}
}

function sendFrame(ws: WebSocket, frame: WatchFrame | EventsFrame): void {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function endSocket(ws: WebSocket, reason: string): void {
	sendFrame(ws, { t: "end", reason });
	if (ws.readyState === WebSocket.OPEN) ws.close(1000);
}

function endReason(end: WatchEnd): string {
	if (end.kind === "listener_error") return `listener_error: ${end.error.message}`;
	if (end.kind === "failed") return `failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`;
	return end.kind;
}

function isPing(data: WebSocket.RawData): boolean {
	try {
		const frame = JSON.parse(String(data)) as { t?: unknown };
		return frame.t === "ping";
	} catch {
		return false;
	}
}

function reject(socket: Duplex, status: number, message: string): void {
	const body = JSON.stringify({ error: message });
	socket.end(
		`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request"}\r\n` +
			`Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
	);
}
