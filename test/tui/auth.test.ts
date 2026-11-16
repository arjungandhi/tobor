import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError, ReconnectingSocket, UNAUTHORIZED_MESSAGE } from "../../src/tui/client.js";
import { upgradeErrorMessage } from "../../src/tui/node-upgrade.js";
import { probe } from "../../src/tui/workspaces.js";

type Seen = { method: string; url: string; auth: string | undefined };

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

/** A node behind a bearer-token proxy: 401 unless `Authorization: Bearer <token>`, for HTTP and WebSocket upgrades. */
async function proxy(token: string, seen: Seen[] = []): Promise<{ port: number; seen: Seen[] }> {
	const ok = (req: IncomingMessage): boolean => req.headers.authorization === `Bearer ${token}`;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
		if (!ok(req)) {
			res.writeHead(401, { "content-type": "text/plain" });
			res.end("unauthorized");
			return;
		}
		if (req.url?.endsWith(".pdf")) {
			res.writeHead(200, { "content-type": "application/pdf" });
			res.end("%PDF-1.4");
			return;
		}
		if (req.url?.endsWith(".html")) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<html>login</html>");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(req.url === "/api/sessions" ? [] : { host: "node", version: "1" }));
	});
	server.on("upgrade", (req, socket) => {
		seen.push({ method: "UPGRADE", url: req.url ?? "", auth: req.headers.authorization });
		// Not a real WebSocket server: a good token gets a plain 400 (not 401), which is enough to tell the cases apart.
		socket.end(`HTTP/1.1 ${ok(req) ? "400 Bad Request" : "401 Unauthorized"}\r\nContent-Length: 0\r\n\r\n`);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, seen };
}

describe("bearer token transport", () => {
	it("sends Authorization on every REST call, not without a token", async () => {
		const { port, seen } = await proxy("tok");
		const client = new ApiClient(`http://127.0.0.1:${port}`, "tok");
		await client.whoami();
		await client.sessions();
		await client.restart();
		expect(seen.map((s) => s.auth)).toEqual(["Bearer tok", "Bearer tok", "Bearer tok"]);
		await expect(new ApiClient(`http://127.0.0.1:${port}`).whoami()).rejects.toMatchObject({ status: 401 });
	});

	it("probe sends the token, and throws on 401", async () => {
		const { port, seen } = await proxy("tok");
		expect((await probe({ host: "127.0.0.1", port, token: "tok" }))?.host).toBe("node");
		expect(seen[0]?.auth).toBe("Bearer tok");
		await expect(probe({ host: "127.0.0.1", port })).rejects.toBeInstanceOf(ApiRequestError);
		await expect(probe({ host: "127.0.0.1", port: 1 })).resolves.toBeUndefined();
	});

	it("a 401 without a handler is an error that mentions the token", async () => {
		const { port } = await proxy("tok");
		const err = await new ApiClient(`http://127.0.0.1:${port}`).whoami().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect((err as Error).message).toContain("bearer token");
		expect(upgradeErrorMessage(err)).toContain("--token");
		expect(upgradeErrorMessage(err)).toBe(UNAUTHORIZED_MESSAGE);
	});

	it("asks for a token on 401, retries with it, and asks again when it is wrong", async () => {
		const { port, seen } = await proxy("good");
		const answers = ["wrong", "good"];
		const refused: (string | undefined)[] = [];
		const client: ApiClient = new ApiClient(`http://127.0.0.1:${port}`, undefined, async (token) => {
			refused.push(token);
			const next = answers.shift();
			if (next === undefined) return false;
			client.token = next;
			return true;
		});
		expect((await client.whoami()).host).toBe("node");
		expect(refused).toEqual([undefined, "wrong"]);
		expect(seen.map((s) => s.auth)).toEqual([undefined, "Bearer wrong", "Bearer good"]);
	});

	it("gives up with the 401 when the prompt is cancelled", async () => {
		const { port, seen } = await proxy("good");
		const client = new ApiClient(`http://127.0.0.1:${port}`, undefined, async () => false);
		await expect(client.sessions()).rejects.toMatchObject({ status: 401 });
		expect(seen).toHaveLength(1);
	});

	it("download sends the token to the node's origin only", async () => {
		const node = await proxy("tok");
		const other = await proxy("tok");
		const client = new ApiClient(`http://127.0.0.1:${node.port}`, "tok", async () => {
			throw new Error("must not prompt for another origin");
		});
		expect(new TextDecoder().decode(await client.download(`http://127.0.0.1:${node.port}/artifact.pdf`))).toBe("%PDF-1.4");
		await client.download(`http://127.0.0.1:${other.port}/artifact.pdf`).catch(() => {});
		expect(node.seen[0]?.auth).toBe("Bearer tok");
		expect(other.seen[0]?.auth).toBeUndefined();
	});

	it("download refuses a 200 HTML response (a login page) instead of saving it as a PDF", async () => {
		const node = await proxy("tok");
		const client = new ApiClient(`http://127.0.0.1:${node.port}`, "tok");
		await expect(client.download(`http://127.0.0.1:${node.port}/login.html`)).rejects.toThrow(/did not return a PDF.*open the artifact in a browser/);
	});

	it("sends the token on the WebSocket upgrade; a 401 pauses retries and asks, then reconnects with the new token", async () => {
		const { port, seen } = await proxy("good");
		let token: string | undefined;
		const states: string[] = [];
		const asked: (string | undefined)[] = [];
		const socket = new ReconnectingSocket<unknown>({
			url: () => `ws://127.0.0.1:${port}/api/events`,
			onFrame: () => {},
			headers: (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {}),
			onState: (state, detail) => states.push(detail ? `${state}: ${detail}` : state),
			onUnauthorized: async (sent) => {
				asked.push(sent);
				if (token) return false;
				token = "good";
				return true;
			},
		});
		socket.start();
		await new Promise((resolve) => setTimeout(resolve, 600));
		socket.close();
		expect(asked).toEqual([undefined]);
		// First attempt has no header (401); after the answer, the retry carries the token and gets past auth (400, not 401; normal backoff follows).
		expect(seen.filter((s) => s.method === "UPGRADE").map((s) => s.auth).slice(0, 2)).toEqual([undefined, "Bearer good"]);
		expect(states.some((s) => s.startsWith("waiting: 401"))).toBe(true);
	});

	it("without an onUnauthorized handler a refused upgrade keeps backing off", async () => {
		const { port, seen } = await proxy("good");
		const socket = new ReconnectingSocket<unknown>({ url: () => `ws://127.0.0.1:${port}/x`, onFrame: () => {}, minDelayMs: 20, maxDelayMs: 20 });
		socket.start();
		await new Promise((resolve) => setTimeout(resolve, 300));
		socket.close();
		expect(seen.filter((s) => s.method === "UPGRADE").length).toBeGreaterThan(1);
	});
});
