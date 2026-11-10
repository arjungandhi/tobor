import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostError } from "../../src/host.js";
import { type Listener, startApi, startArtifactsListener } from "../../src/server/http/server.js";
import { fakeHost, http } from "./fake-host.js";

let servers: Listener[] = [];
afterEach(async () => {
	await Promise.all(servers.map((s) => s.close()));
	servers = [];
});

async function api(results: Record<string, unknown> = {}) {
	const f = fakeHost(results);
	const s = await startApi(f.host);
	servers.push(s);
	return { ...f, port: s.address.port };
}

const ORIGIN = { origin: "http://localhost:4000" };

describe("guards over HTTP", () => {
	it("403 on a foreign Host, 403 on a foreign Origin, 415 without JSON", async () => {
		const { port, calls } = await api({ "sessions.abort": undefined });
		expect((await http(port, "GET", "/api/cwds", { headers: { host: "evil.example" } })).status).toBe(403);
		expect((await http(port, "GET", "/api/cwds", { headers: { host: "localhost:4000" } })).status).toBe(200);
		const evil = await http(port, "POST", "/api/sessions/1/abort", { body: {}, headers: { origin: "http://evil.example" } });
		expect(evil).toMatchObject({ status: 403, body: { code: "forbidden_origin" } });
		const text = await http(port, "POST", "/api/sessions/1/abort", { body: "x", headers: { "content-type": "text/plain" } });
		expect(text.status).toBe(415);
		expect(calls.filter((c) => c.method === "sessions.abort")).toHaveLength(0);
		expect((await http(port, "POST", "/api/sessions/1/abort", { body: {}, headers: ORIGIN })).status).toBe(200);
		expect((await http(port, "POST", "/api/sessions/1/abort", { body: {} })).status).toBe(200);
	});

	it("413 past 1 MiB, 400 on bad JSON, 404/405 for unknown routes", async () => {
		const { port } = await api();
		const big = await http(port, "POST", "/api/sessions", { body: JSON.stringify({ prompt: "x".repeat(1024 * 1024 + 1) }) });
		expect(big.status).toBe(413);
		expect((await http(port, "POST", "/api/sessions", { body: "{nope" })).body).toMatchObject({ code: "invalid_json" });
		expect((await http(port, "GET", "/api/nope")).status).toBe(404);
		expect((await http(port, "PUT", "/api/whoami", { body: {} })).status).toBe(405);
	});
});

describe("routes", () => {
	it("whoami", async () => {
		const { port } = await api({ whoami: { host: "box", version: "3.0.0" } });
		expect(await http(port, "GET", "/api/whoami")).toMatchObject({ status: 200, body: { host: "box" } });
	});

	it("sessions list/create/get/patch/delete/input/abort/entries", async () => {
		const detail = { id: 7, title: "t" };
		const { port, calls } = await api({
			"sessions.list": [detail],
			"sessions.create": { id: 7, submissionId: 1 },
			"sessions.get": (id: unknown) => (id === 7 ? detail : undefined),
			"sessions.patch": { ...detail, title: "n" },
			"sessions.input": { submissionId: 9 },
			"sessions.entries": { items: [], more: false },
		});
		expect((await http(port, "GET", "/api/sessions?archived=1")).body).toEqual([detail]);
		expect(calls.at(-1)).toEqual({ method: "sessions.list", args: [{ archived: true }] });

		const created = await http(port, "POST", "/api/sessions", { body: { cwd: "/w", prompt: "hi", approval_mode: "auto" } });
		expect(created).toMatchObject({ status: 201, body: { id: 7 } });
		expect(calls.at(-1)?.args[0]).toMatchObject({ cwd: "/w", prompt: "hi", approvalMode: "auto" });
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w" } })).status).toBe(201);
		expect(calls.at(-1)?.args[0]).toEqual({ cwd: "/w" });
		expect((await http(port, "POST", "/api/sessions", { body: { prompt: "p" } })).status).toBe(400);
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", prompt: 3 } })).status).toBe(400);
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", prompt: "p", thinking: "huge" } })).status).toBe(400);

		expect((await http(port, "GET", "/api/sessions/7")).body).toEqual(detail);
		expect((await http(port, "GET", "/api/sessions/8")).status).toBe(404);
		expect((await http(port, "GET", "/api/sessions/abc")).status).toBe(400);

		expect((await http(port, "PATCH", "/api/sessions/7", { body: { title: "n", archived: true } })).body).toMatchObject({ title: "n" });
		expect(calls.slice(-2).map((c) => c.method)).toEqual(["sessions.archive", "sessions.patch"]);
		expect(calls.at(-1)?.args).toEqual([7, { title: "n" }]);
		expect((await http(port, "PATCH", "/api/sessions/7", { body: { archived: false } })).body).toEqual(detail);

		expect((await http(port, "DELETE", "/api/sessions/7")).body).toEqual({ ok: true });
		const input = await http(port, "POST", "/api/sessions/7/input", { body: { content: "c", mode: "steer", requestId: "r1" } });
		expect(input.body).toEqual({ submissionId: 9 });
		expect(calls.at(-1)?.args).toEqual([7, { content: "c", mode: "steer", requestId: "r1" }]);
		expect((await http(port, "POST", "/api/sessions/7/input", { body: { content: "c", mode: "x", requestId: "r" } })).status).toBe(400);
		expect((await http(port, "POST", "/api/sessions/7/abort", { body: {} })).body).toEqual({ ok: true });

		expect((await http(port, "GET", "/api/sessions/7/entries?minEntryId=3&order=asc&limit=10")).body).toEqual({ items: [], more: false });
		expect(calls.at(-1)?.args).toEqual([7, { minEntryId: 3, maxEntryId: undefined, order: "asc", limit: 10 }]);
		expect((await http(port, "GET", "/api/sessions/7/entries?limit=501")).status).toBe(400);
		expect((await http(port, "GET", "/api/sessions/7/entries?order=up")).status).toBe(400);
	});

	it("maps HostError status/code/errors and hides unknown errors", async () => {
		const { port } = await api({
			"sessions.create": () => Promise.reject(new HostError(403, "outside_roots", "cwd outside roots")),
			"sessions.list": () => Promise.reject(new Error("secret stack detail")),
			"agentData.write": () =>
				Promise.reject(new HostError(422, "invalid", "bad config", [{ path: "x", message: "m" }] as never)),
		});
		expect(await http(port, "POST", "/api/sessions", { body: { cwd: "/etc", prompt: "p" } })).toMatchObject({
			status: 403,
			body: { error: "cwd outside roots", code: "outside_roots" },
		});
		const boom = await http(port, "GET", "/api/sessions");
		expect(boom.status).toBe(500);
		expect(JSON.stringify(boom.body)).not.toContain("secret");
		expect(await http(port, "PUT", "/api/tobor/files/config.yml", { body: { content: "x" } })).toMatchObject({
			status: 422,
			body: { errors: [{ path: "x" }] },
		});
	});

	it("approvals list, decide via find, 404 unknown, 409 already decided", async () => {
		const pending = { conversationId: 4, sessionId: 4, callId: "c1", tool: "bash", args: {}, createdAt: 1, expiresAt: 2 };
		let decided = false;
		const { port, calls } = await api({
			"approvals.pending": [pending],
			"approvals.find": (id: unknown) => (id === "c1" ? pending : undefined),
			"approvals.decide": () => {
				if (decided) return Promise.reject(new HostError(409, "conflict", "already decided"));
				decided = true;
				return Promise.resolve();
			},
		});
		expect((await http(port, "GET", "/api/approvals")).body).toEqual([pending]);
		expect((await http(port, "POST", "/api/approvals/c1", { body: { decision: "approve" } })).body).toEqual({ ok: true });
		expect(calls.at(-1)).toEqual({ method: "approvals.decide", args: [4, "c1", "approve"] });
		expect(await http(port, "POST", "/api/approvals/c1", { body: { decision: "deny", conversationId: 4 } })).toMatchObject({
			status: 409,
			body: { code: "conflict" },
		});
		expect((await http(port, "POST", "/api/approvals/zz", { body: { decision: "deny" } })).status).toBe(404);
		expect((await http(port, "POST", "/api/approvals/c1", { body: { decision: "maybe" } })).status).toBe(400);
	});

	it("auth, models, cwds, mcp, agents, workers", async () => {
		const { port, calls } = await api({
			"auth.status": { anthropic: { source: "oauth" } },
			"auth.loginStart": { url: "https://x" },
			"auth.loginCode": { ok: true, auth: { source: "oauth" } },
			"auth.models": { models: [], providers: {}, defaults: { model: "a/b", thinking: "low" } },
			"sessions.cwds": { roots: ["/w"], recent: [] },
			"mcp.status": [{ server: "s", tools: 1 }],
			"agentData.listAgents": [{ name: "a" }],
			"workers.list": [{ id: "w1" }],
		});
		expect((await http(port, "GET", "/api/auth")).body).toEqual({ anthropic: { source: "oauth" } });
		expect((await http(port, "POST", "/api/auth/anthropic/login/start", { body: {} })).body).toEqual({ url: "https://x" });
		expect((await http(port, "POST", "/api/auth/anthropic/login/code", { body: { code: "abc" } })).body).toMatchObject({ ok: true });
		expect(calls.at(-1)?.args).toEqual(["anthropic", "abc"]);
		expect((await http(port, "GET", "/api/models")).body).toMatchObject({ defaults: { model: "a/b" } });
		expect((await http(port, "GET", "/api/cwds")).body).toEqual({ roots: ["/w"], recent: [] });
		expect((await http(port, "GET", "/api/mcp")).body).toEqual([{ server: "s", tools: 1 }]);
		expect((await http(port, "GET", "/api/agents?cwd=%2Fw")).body).toEqual([{ name: "a" }]);
		expect(calls.at(-1)?.args).toEqual(["/w"]);
		expect((await http(port, "GET", "/api/sessions/3/workers")).body).toEqual([{ id: "w1" }]);
		expect(calls.at(-1)?.args).toEqual([3]);
	});

	it("tobor files, history fallback", async () => {
		const { port, calls } = await api({
			"agentData.read": (p: unknown) => (p === "agents/a.md" ? { type: "file", path: p, content: "x" } : undefined),
			"agentData.write": { ok: true, commit: "abc" },
			"agentData.remove": { ok: true, commit: "def" },
			"agentData.history": [{ commit: "abc" }],
			"agentData.diff": "diff",
		});
		expect((await http(port, "GET", "/api/tobor/files/agents/a.md")).body).toMatchObject({ content: "x" });
		expect((await http(port, "GET", "/api/tobor/files/nope")).status).toBe(404);
		expect((await http(port, "PUT", "/api/tobor/files/agents/a.md", { body: { content: "", sha: "s" } })).body).toEqual({ ok: true, commit: "abc" });
		expect(calls.at(-1)?.args).toEqual(["agents/a.md", { content: "", sha: "s", message: undefined }]);
		expect((await http(port, "DELETE", "/api/tobor/files/agents/a.md")).body).toEqual({ ok: true, commit: "def" });
		expect((await http(port, "GET", "/api/tobor/history?limit=5")).body).toEqual([{ commit: "abc" }]);
		expect((await http(port, "GET", "/api/tobor/diff?commit=abc")).body).toBe("diff");
	});

	it("artifacts and schedules", async () => {
		const sched = { id: "s1", name: "n", runs: [] };
		const { port, calls } = await api({
			"artifacts.list": [{ slug: "a" }],
			"artifacts.revisions": [{ rev: "r1" }],
			"schedules.list": [sched],
			"schedules.create": { id: "s1" },
			"schedules.get": (id: unknown) => (id === "s1" ? sched : undefined),
			"schedules.update": sched,
		});
		expect((await http(port, "GET", "/api/artifacts?project=p")).body).toEqual([{ slug: "a" }]);
		expect(calls.at(-1)?.args).toEqual(["p"]);
		expect((await http(port, "GET", "/api/artifacts/p/a/revisions")).body).toEqual([{ rev: "r1" }]);
		expect((await http(port, "GET", "/api/schedules")).body).toEqual([sched]);
		const body = { name: "n", cron: "0 9 * * *", cwd: "/w", prompt: "p", enabled: false };
		expect(await http(port, "POST", "/api/schedules", { body })).toMatchObject({ status: 201, body: { id: "s1" } });
		expect(calls.at(-1)?.args[0]).toEqual(body);
		expect((await http(port, "GET", "/api/schedules/s1")).body).toEqual(sched);
		expect((await http(port, "GET", "/api/schedules/s2")).status).toBe(404);
		expect((await http(port, "PUT", "/api/schedules/s1", { body: { enabled: true } })).body).toEqual(sched);
		expect(calls.at(-1)?.args).toEqual(["s1", { enabled: true }]);
		expect((await http(port, "PUT", "/api/schedules/s1", { body: { enabled: "yes" } })).status).toBe(400);
		expect((await http(port, "DELETE", "/api/schedules/s1")).body).toEqual({ ok: true });
	});
});

describe("artifacts listener", () => {
	it("serves PDFs, 503 while rendering, delegates the rest, checks Host", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tobor-pdf-"));
		const file = join(dir, "x.pdf");
		writeFileSync(file, "%PDF-1.4 fake");
		const rev = { rev: "r1", revision: 2, slug: "deck", projectId: "p" };
		let rendering = true;
		const { host } = fakeHost({
			"artifacts.revision": (r: unknown) => (r === "r1" ? rev : undefined),
			"artifacts.latest": (p: unknown, s: unknown) => (p === "p" && s === "deck" ? rev : undefined),
			"artifacts.pdf": () => (rendering ? { status: "rendering", retryAfterSeconds: 3 } : { status: "ready", path: file }),
		});
		const seen: string[] = [];
		const s = await startArtifactsListener(host, async (req, res) => {
			seen.push(req.url ?? "");
			if (req.url !== "/art/p/deck") return false;
			res.end("viewer");
			return true;
		});
		servers.push(s);
		const port = s.address.port;
		const h = { headers: { host: "127.0.0.1:4001" } };
		expect((await http(port, "GET", "/art/r/r1.pdf", { headers: { host: "127.0.0.1:4000" } })).status).toBe(403);
		const busy = await http(port, "GET", "/art/r/r1.pdf", h);
		expect(busy.status).toBe(503);
		expect(busy.headers["retry-after"]).toBe("3");
		rendering = false;
		const pdf = await http(port, "GET", "/art/p/deck.pdf", h);
		expect(pdf.status).toBe(200);
		expect(pdf.headers["content-type"]).toBe("application/pdf");
		expect(pdf.headers["content-disposition"]).toBe('attachment; filename="deck-r2.pdf"');
		expect(pdf.raw.toString()).toBe("%PDF-1.4 fake");
		expect((await http(port, "GET", "/art/r/zz.pdf", h)).status).toBe(404);
		expect((await http(port, "GET", "/art/p/deck", h)).body).toBe("viewer");
		expect((await http(port, "GET", "/other", h)).status).toBe(404);
		expect(seen).toEqual(["/art/p/deck", "/other"]);
	});
});
