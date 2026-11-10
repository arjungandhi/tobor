import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { NtfyNotifier } from "../../src/server/notify/ntfy.js";

type Received = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

let server: Server;
let base: string;
let received: Received[];
let status: number;

beforeEach(async () => {
	received = [];
	status = 200;
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
			res.writeHead(status).end("{}");
		});
	});
	server.listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => server.close());

const config = (yaml: string): Config => parseConfigText(yaml, "/tmp/home").config;

describe("NtfyNotifier", () => {
	it("posts to <url>/<topic> with title, tags, priority, click and actions", async () => {
		const c = config(`public_url: http://node:7879\nnotify: { ntfy: { url: "${base}/", topic: tobor-abc } }\n`);
		const notifier = new NtfyNotifier({ config: () => c });
		expect(notifier.enabled("approval")).toBe(true);
		await notifier.send({
			event: "approval",
			title: "bash in session 7",
			message: "waiting for approval",
			sessionId: 7 as never,
			actions: [{ label: "Approve", url: "http://node:7879/api/approvals/c1", body: '{"decision":"approve"}' }],
		});
		expect(received).toHaveLength(1);
		const [req] = received;
		expect(req?.method).toBe("POST");
		expect(req?.url).toBe("/tobor-abc");
		expect(req?.body).toBe("waiting for approval");
		expect(req?.headers).toMatchObject({
			title: "bash in session 7",
			priority: "5",
			tags: "warning,lock",
			click: "http://node:7879",
		});
		expect(req?.headers.actions).toBe(
			`http, "Approve", "http://node:7879/api/approvals/c1", method=POST, clear=true, body='{"decision":"approve"}'`,
		);
	});

	it("encodes non-ASCII titles and uses the notification url as click target", async () => {
		const c = config(`notify: { ntfy: { url: "${base}", topic: t } }\n`);
		await new NtfyNotifier({ config: () => c }).send({
			event: "settled",
			title: "schedule nightly — done",
			message: "ok",
			url: "http://art/x",
		});
		const headers = received[0]?.headers;
		expect(headers?.priority).toBe("3");
		expect(headers?.click).toBe("http://art/x");
		const title = String(headers?.title);
		expect(title).toMatch(/^=\?UTF-8\?B\?/);
		expect(Buffer.from(title.slice(10, -2), "base64").toString()).toBe("schedule nightly — done");
	});

	it("styles question notifications and gates them on notify.on", async () => {
		const on = config(`notify: { ntfy: { url: "${base}", topic: t } }\n`);
		await new NtfyNotifier({ config: () => on }).send({ event: "question", title: "Question: which db?", message: "which db?" });
		expect(received[0]?.headers).toMatchObject({ priority: "4", tags: "question" });
		const off = new NtfyNotifier({ config: () => config(`notify: { ntfy: { url: "${base}", topic: t }, on: [approval] }\n`) });
		expect(off.enabled("question")).toBe(false);
		await off.send({ event: "question", title: "x", message: "y" });
		expect(received).toHaveLength(1);
	});

	it("is disabled when ntfy is unconfigured or the event is filtered out", async () => {
		const off = new NtfyNotifier({ config: () => config("") });
		expect(off.enabled("approval")).toBe(false);
		await off.send({ event: "approval", title: "x", message: "y" });

		const c = config(`notify: { ntfy: { url: "${base}", topic: t }, on: [approval] }\n`);
		const filtered = new NtfyNotifier({ config: () => c });
		expect(filtered.enabled("error")).toBe(false);
		await filtered.send({ event: "error", title: "x", message: "y" });
		expect(received).toEqual([]);
	});

	it("logs delivery failures instead of throwing", async () => {
		status = 500;
		const logs: string[] = [];
		const c = config(`notify: { ntfy: { url: "${base}", topic: t } }\n`);
		await new NtfyNotifier({ config: () => c, log: (m) => logs.push(m) }).send({ event: "error", title: "x", message: "y" });
		expect(logs).toEqual(["tobor: ntfy error notification failed: HTTP 500"]);

		const down = config(`notify: { ntfy: { url: "http://127.0.0.1:1", topic: t } }\n`);
		await new NtfyNotifier({ config: () => down, log: (m) => logs.push(m) }).send({
			event: "error",
			title: "x",
			message: "y",
		});
		expect(logs).toHaveLength(2);
	});
});
