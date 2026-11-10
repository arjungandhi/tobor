// Stub tobor node for exercising the TUI by hand: `node --import tsx test/tui/stub-server.ts [port]`, then
// `node --import tsx src/cli.ts tui 127.0.0.1:<port>`. Serves a canned director session whose answer streams in, ends
// in a bash call waiting for approval, and finishes once approved; plus enough of every other endpoint for the screens.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { WebSocket, WebSocketServer } from "ws";
import type {
	ArtifactSummary,
	NodeEvent,
	PendingApproval,
	Schedule,
	SessionSummary,
	WatchValue,
	WorkerSummary,
} from "../../src/api/types.js";
import { APPROVAL_CALL, approvedOps, CWD, initialView, pendingApproval, SESSION_ID, streamingOps } from "./scenario.js";

const port = Number(process.argv[2] ?? 7879);
const base = `http://127.0.0.1:${port}`;
const usage = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280, cost: 0.0016 };
const now = Date.now();

type Conversation = { view: WatchValue; older: unknown[]; watchers: Set<WebSocket>; nextId: number; played: boolean };
const conversations = new Map<number, Conversation>();
const events = new Set<WebSocket>();
let approvals: PendingApproval[] = [];

function userEntry(conversationId: number, id: number, text: string): Record<string, unknown> {
	return { kind: "pi.user", id, conversationId, model: [{ role: "user", content: text, timestamp: now }] };
}

function answerEntry(conversationId: number, id: number, text: string): Record<string, unknown> {
	return { kind: "pi.assistant", id, conversationId, model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: now }] };
}

function plainView(id: number, entries: Record<string, unknown>[], before?: number): WatchValue {
	return {
		conversation: { id },
		entries,
		...(before === undefined ? {} : { before }),
		docs: { "pi.live": {}, "pi.inbox": { items: [] }, "pi.usage": { models: {}, tools: {} } },
	} as unknown as WatchValue;
}

conversations.set(SESSION_ID, { view: initialView(), older: [], watchers: new Set(), nextId: 21, played: false });
const older: Record<string, unknown>[] = [];
for (let i = 1; i <= 30; i++) older.push(i % 2 ? userEntry(2, i, `Draft section ${(i + 1) / 2} of the release notes.`) : answerEntry(2, i, `Section ${i / 2} drafted: **${["fixes", "features", "docs"][i % 3]}**.`));
conversations.set(2, {
	view: plainView(2, [userEntry(2, 31, "Now tighten the summary paragraph."), answerEntry(2, 32, "Done. The summary is now two sentences.")], 30),
	older,
	watchers: new Set(),
	nextId: 33,
	played: true,
});
conversations.set(3, {
	view: plainView(3, [userEntry(3, 1, "Find every caller of `retryWithBackoff`."), answerEntry(3, 2, "Found 3 callers:\n\n- `src/net.ts:41`\n- `src/queue.ts:88`\n- `test/retries.test.ts:12`")]),
	older: [],
	watchers: new Set(),
	nextId: 3,
	played: true,
});

const sessions: SessionSummary[] = [
	{ id: SESSION_ID, title: "Fix the flaky test", cwd: CWD, model: "anthropic/claude-haiku-5-5", approval_mode: "ask", mode: "director", kind: "session", state: "running", pending: 0, usage, archived: false, createdAt: now - 600_000, updatedAt: now },
	{ id: 2, title: "Release notes", cwd: CWD, model: "anthropic/claude-haiku-5-5", approval_mode: "ask", mode: "solo", kind: "session", state: "idle", pending: 0, usage: { ...usage, cost: 0.02 }, archived: false, createdAt: now - 86_400_000, updatedAt: now - 3_600_000 },
];
const workers: WorkerSummary[] = [
	{ id: "w1", name: "scout-callers", agent: "scout", conversationId: 3, state: "done", usage: { ...usage, cost: 0.001 }, lastText: "Found 3 callers", createdAt: now - 300_000, finishedAt: now - 200_000 },
	{ id: "w2", name: "fix-timers", agent: "worker", state: "starting", usage: { ...usage, cost: 0 }, lastText: "", createdAt: now - 10_000 },
];
const artifact: ArtifactSummary = {
	projectId: "demo",
	slug: "flaky-test-report",
	title: "Flaky test report",
	revisions: 2,
	url: "http://127.0.0.1:7880/art/demo/flaky-test-report",
	latest: { rev: "r7", revision: 2, projectId: "demo", slug: "flaky-test-report", title: "Flaky test report", tags: [], hash: "abc", conversationId: 1, createdAt: now - 60_000, url: "http://127.0.0.1:7880/art/r/r7", pdfUrl: `${base}/art/r/r7.pdf` },
};
let schedules: Schedule[] = [
	{ id: "s1", name: "nightly triage", cron: "0 6 * * *", tz: "UTC", cwd: CWD, prompt: "Triage new issues and summarize.", enabled: true, createdAt: now, updatedAt: now, nextFireAt: now + 3_600_000, runs: [{ fireAt: now - 82_800_000, conversationId: 2, status: "done" }] },
];
const files = new Map<string, string>([
	["AGENTS.md", "# Agent context\n\nBe concise.\n"],
	["RULES.md", "- Never push to main.\n"],
	["config.yml", "defaults:\n  approval_mode: ask\n"],
	["agents/worker.md", "---\nname: worker\ndescription: does the work\n---\nYou edit and run.\n"],
]);

function emit(event: NodeEvent): void {
	for (const ws of events) ws.send(JSON.stringify({ t: "event", event }));
}

function push(id: number, ops: Op[]): void {
	const conv = conversations.get(id);
	if (!conv) return;
	conv.view = applyImmutable(conv.view, ops);
	for (const ws of conv.watchers) ws.send(JSON.stringify({ t: "ops", ops }));
}

function play(id: number, batches: Op[][], gapMs: number, then?: () => void): void {
	let i = 0;
	const tick = (): void => {
		const batch = batches[i++];
		if (!batch) {
			then?.();
			return;
		}
		push(id, batch);
		setTimeout(tick, gapMs);
	};
	setTimeout(tick, gapMs);
}

function setState(id: number, state: SessionSummary["state"]): void {
	const s = sessions.find((x) => x.id === id);
	if (s) s.state = state;
	emit({ type: "session.state", id, state });
}

function reply(id: number, text: string): void {
	const conv = conversations.get(id);
	if (!conv) return;
	const at = conv.view.entries.length;
	const answerId = conv.nextId++;
	const gen = ["docs", "pi.live", "generation", "message", "content", 0, "text"] as const;
	const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
	play(
		id,
		[
			[["s", ["docs", "pi.live", "generation"], { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "pending" } }]],
			...chunks.map((chunk): Op[] => [["a", [...gen], chunk]]),
			[
				["d", ["docs", "pi.live", "run"]],
				["d", ["docs", "pi.live", "generation"]],
				["p", ["entries"], at, 0, [answerEntry(id, answerId, text) as never]],
			],
		],
		80,
		() => setState(id, "idle"),
	);
}

function submit(id: number, content: string, mode: string): void {
	const conv = conversations.get(id);
	if (!conv) return;
	const busy = (conv.view.docs["pi.live"] as { run?: unknown }).run !== undefined;
	if (busy && mode !== "prompt") {
		setTimeout(() => push(id, [["p", ["entries"], conv.view.entries.length, 0, [userEntry(id, conv.nextId++, `[${mode}] ${content}`) as never]]]), 200);
		return;
	}
	push(id, [
		["d", ["docs", "pi.live", "runFailure"]],
		["s", ["docs", "pi.live", "run"], { taskId: 100 + conv.nextId, inputs: [conv.nextId], turns: 0 }],
		["p", ["entries"], conv.view.entries.length, 0, [userEntry(id, conv.nextId++, content) as never]],
	]);
	setState(id, "running");
	reply(id, `You said: “${content}”. This is a **stub** node, so here is a canned answer:\n\n1. nothing ran\n2. nothing changed`);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", base);
	const path = url.pathname;
	const method = req.method ?? "GET";
	if (method !== "GET" && req.headers.origin !== base) return send(res, 403, { error: `bad origin ${req.headers.origin}`, code: "forbidden_origin" });
	const m = (re: RegExp): RegExpMatchArray | null => path.match(re);
	let match: RegExpMatchArray | null;

	if (path === "/api/whoami") {
		return send(res, 200, { host: "stub-host", version: "0.0.0-stub", pi_durable: "1.5.1", node: process.versions.node, public_url: base, artifacts_url: "http://127.0.0.1:7880", chrome: { found: true, version: "131.0" }, now: Date.now() });
	}
	if (path === "/api/sessions" && method === "GET") {
		const all = url.searchParams.get("archived") === "1";
		return send(res, 200, sessions.filter((s) => all || !s.archived).map((s) => ({ ...s, pending: approvals.filter((a) => a.sessionId === s.id).length })));
	}
	if (path === "/api/sessions" && method === "POST") {
		const b = await body(req);
		const id = Math.max(...conversations.keys()) + 1;
		conversations.set(id, { view: plainView(id, []), older: [], watchers: new Set(), nextId: 1, played: true });
		sessions.unshift({ ...sessions[1]!, id, title: String(b.prompt).slice(0, 60), cwd: String(b.cwd), model: String(b.model ?? sessions[1]!.model), mode: b.mode === "director" ? "director" : "solo", state: "running", createdAt: Date.now(), updatedAt: Date.now() });
		setTimeout(() => submit(id, String(b.prompt), "prompt"), 300);
		return send(res, 200, { id });
	}
	if ((match = m(/^\/api\/sessions\/(\d+)$/))) {
		const id = Number(match[1]);
		const s = sessions.find((x) => x.id === id);
		if (!s) return send(res, 404, { error: "no such session", code: "not_found" });
		if (method === "PATCH") Object.assign(s, await body(req));
		if (method === "DELETE") {
			sessions.splice(sessions.indexOf(s), 1);
			return send(res, 200, { ok: true });
		}
		return send(res, 200, { ...s, thinking: "off", max_turns: 50, workers: id === SESSION_ID ? workers.length : 0 });
	}
	if ((match = m(/^\/api\/sessions\/(\d+)\/input$/)) && method === "POST") {
		const b = await body(req);
		submit(Number(match[1]), String(b.content), String(b.mode));
		return send(res, 200, { submissionId: 99 });
	}
	if ((match = m(/^\/api\/sessions\/(\d+)\/abort$/)) && method === "POST") {
		const id = Number(match[1]);
		push(id, [
			["d", ["docs", "pi.live", "run"]],
			["d", ["docs", "pi.live", "generation"]],
			["d", ["docs", "pi.live", "tools"]],
			["s", ["docs", "pi.live", "runFailure"], { taskId: 1, inputs: [], reason: "aborted" }],
		]);
		approvals = approvals.filter((a) => a.conversationId !== id);
		setState(id, "idle");
		return send(res, 200, { ok: true });
	}
	if ((match = m(/^\/api\/sessions\/(\d+)\/entries$/))) {
		const conv = conversations.get(Number(match[1]));
		const max = Number(url.searchParams.get("maxEntryId") ?? Infinity);
		const min = Number(url.searchParams.get("minEntryId") ?? -Infinity);
		const limit = Number(url.searchParams.get("limit") ?? 50);
		const desc = url.searchParams.get("order") !== "asc";
		const all = (conv?.older ?? []) as { id: number }[];
		const hits = all.filter((e) => e.id <= max && e.id >= min);
		const ordered = desc ? [...hits].reverse() : hits;
		return send(res, 200, { items: ordered.slice(0, limit), more: ordered.length > limit });
	}
	if ((match = m(/^\/api\/sessions\/(\d+)\/workers$/))) return send(res, 200, Number(match[1]) === SESSION_ID ? workers : []);
	if (path === "/api/approvals" && method === "GET") return send(res, 200, approvals);
	if ((match = m(/^\/api\/approvals\/(.+)$/)) && method === "POST") {
		const callId = decodeURIComponent(match[1] ?? "");
		const b = await body(req);
		const approval = approvals.find((a) => a.callId === callId);
		if (!approval) return send(res, 409, { error: "already decided", code: "conflict" });
		approvals = approvals.filter((a) => a !== approval);
		emit({ type: "approval.resolved", conversationId: approval.conversationId, callId, outcome: b.decision as "approve" });
		setState(approval.conversationId, "running");
		if (b.decision === "deny") {
			const conv = conversations.get(approval.conversationId);
			push(approval.conversationId, [
				["s", ["docs", "pi.live", "tools", 0, "status"], "done"],
				["p", ["entries"], conv?.view.entries.length ?? 0, 0, [{ kind: "pi.tool-result", id: 18, conversationId: approval.conversationId, model: [{ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "Denied by operator" }], isError: true }] } as never]],
				["d", ["docs", "pi.live", "tools"]],
			]);
			reply(approval.conversationId, "Understood, I won't run it. The likely fix is fake timers in `test/retries.test.ts`.");
		} else {
			play(approval.conversationId, approvedOps(), 250, () => setState(approval.conversationId, "idle"));
		}
		return send(res, 200, { ok: true });
	}
	if (path === "/api/models") {
		const model = (ref: string, name: string, available: boolean) => ({ ref, provider: ref.split("/")[0], id: ref.split("/")[1], name, reasoning: true, available, cost: { input: 1, output: 5 } });
		return send(res, 200, {
			models: [model("anthropic/claude-haiku-5-5", "Claude Haiku 5.5", true), model("anthropic/claude-sonnet-5", "Claude Sonnet 5", true), model("openai/gpt-6", "GPT-6", false)],
			providers: { anthropic: { source: "oauth" }, openai: { source: "none" } },
			defaults: { model: "anthropic/claude-haiku-5-5", thinking: "off" },
		});
	}
	if (path === "/api/auth") return send(res, 200, { anthropic: { source: "env", oauth: true }, openai: { source: "none" } });
	if ((match = m(/^\/api\/auth\/(\w+)\/login\/start$/))) return send(res, 200, { url: `https://claude.ai/oauth/authorize?client_id=stub&state=${Date.now()}`, instructions: "Use code STUB-OK to succeed." });
	if ((match = m(/^\/api\/auth\/(\w+)\/login\/code$/))) {
		const b = await body(req);
		if (b.code !== "STUB-OK") return send(res, 400, { error: "invalid code", code: "invalid" });
		return send(res, 200, { ok: true, auth: { source: "oauth", expiresAt: Date.now() + 3_600_000, oauth: true } });
	}
	if (path === "/api/cwds") return send(res, 200, { roots: ["/work"], recent: [CWD] });
	if (path === "/api/artifacts") return send(res, 200, [artifact]);
	if (m(/^\/api\/artifacts\/demo\/flaky-test-report\/revisions$/)) return send(res, 200, [artifact.latest, { ...artifact.latest, rev: "r3", revision: 1, url: "http://127.0.0.1:7880/art/r/r3", pdfUrl: `${base}/art/r/r3.pdf` }]);
	if (m(/^\/art\/r\/\w+\.pdf$/)) {
		res.writeHead(200, { "content-type": "application/pdf" });
		res.end("%PDF-1.4\n% stub\n%%EOF\n");
		return;
	}
	if (path === "/api/schedules" && method === "GET") return send(res, 200, schedules);
	if (path === "/api/schedules" && method === "POST") {
		const b = await body(req);
		const id = `s${schedules.length + 1}`;
		const timing = typeof b.cron === "string" ? { cron: b.cron, nextFireAt: Date.now() + 3_600_000 } : { at: String(b.at), nextFireAt: Date.parse(String(b.at)) };
		const schedule: Schedule = { id, name: String(b.name), cwd: String(b.cwd), prompt: String(b.prompt), tz: "UTC", enabled: true, createdAt: Date.now(), updatedAt: Date.now(), runs: [], ...timing };
		schedules = [...schedules, schedule];
		return send(res, 200, { id });
	}
	if ((match = m(/^\/api\/schedules\/(\w+)$/))) {
		const s = schedules.find((x) => x.id === match?.[1]);
		if (!s) return send(res, 404, { error: "no such schedule", code: "not_found" });
		if (method === "DELETE") {
			schedules = schedules.filter((x) => x !== s);
			return send(res, 200, { ok: true });
		}
		if (method === "PUT") Object.assign(s, await body(req));
		return send(res, 200, s);
	}
	if ((match = m(/^\/api\/tobor\/files\/?(.*)$/))) {
		const p = decodeURIComponent(match[1] ?? "").replace(/\/$/, "");
		if (method === "PUT") {
			const b = await body(req);
			if (p === "config.yml" && String(b.content).includes("approval_mode: auto")) {
				return send(res, 422, { error: "invalid config", code: "invalid", errors: [{ path: "defaults.approval_mode", message: "operator-only via the API" }] });
			}
			files.set(p, String(b.content));
			return send(res, 200, { ok: true, commit: "0123456789abcdef" });
		}
		if (files.has(p)) return send(res, 200, { type: "file", path: p, content: files.get(p), sha: "sha1" });
		const prefix = p ? `${p}/` : "";
		const names = new Map<string, "file" | "dir">();
		for (const key of files.keys()) {
			if (!key.startsWith(prefix)) continue;
			const [head, ...rest] = key.slice(prefix.length).split("/");
			if (head) names.set(head, rest.length > 0 ? "dir" : "file");
		}
		if (names.size === 0) return send(res, 404, { error: "not found", code: "not_found" });
		return send(res, 200, { type: "dir", path: p, entries: [...names].map(([name, type]) => ({ name, type })) });
	}
	send(res, 404, { error: `no route ${method} ${path}`, code: "not_found" });
}

const server = createServer((req, res) => {
	route(req, res).catch((err: unknown) => send(res, 500, { error: String(err) }));
});
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", base);
	if (req.headers.origin !== base) {
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		ws.on("message", (data) => {
			if (JSON.parse(data.toString()).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
		});
		if (url.pathname === "/api/events") {
			events.add(ws);
			ws.on("close", () => events.delete(ws));
			return;
		}
		const match = url.pathname.match(/^\/api\/sessions\/(\d+)\/watch$/);
		const id = Number(match?.[1]);
		const conv = conversations.get(id);
		if (!conv) {
			ws.send(JSON.stringify({ t: "end", reason: "session not found" }));
			ws.close();
			return;
		}
		const from = url.searchParams.get("from");
		const window = from ? (JSON.parse(from) as { from?: number }) : undefined;
		const view = window?.from === undefined ? conv.view : { ...conv.view, entries: conv.view.entries.filter((e) => e.id >= (window.from ?? 0)), before: window.from - 1 };
		ws.send(JSON.stringify({ t: "snapshot", value: view }));
		conv.watchers.add(ws);
		ws.on("close", () => conv.watchers.delete(ws));
		if (!conv.played) {
			conv.played = true;
			play(id, streamingOps(), 400, () => {
				const approval = pendingApproval();
				approvals = [...approvals, approval];
				setState(id, "waiting");
				emit({ type: "approval.requested", approval });
			});
		}
	});
});

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`stub tobor node on ${base} (approval call ${APPROVAL_CALL})\n`);
});
