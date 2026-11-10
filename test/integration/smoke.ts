// Real-model end-to-end smoke of the built CLI (manual; not part of vitest):
//   npm run build && ANTHROPIC_API_KEY=… node --import tsx test/integration/smoke.ts [root]
// Temp $TOBOR_HOME, `tobor init`, `tobor node` on ephemeral ports, then over HTTP: a director session whose fast worker
// replies pong, a solo hashline read+edit, an artifact create/publish (page + PDF), and an `ask` approval round-trip.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactSummary, EntriesResponse, PendingApproval, SessionDetail, WorkerSummary } from "../../src/api/types.js";

const root = process.argv[2] ?? "/home/monkey/repos/github.com/arjungandhi";
const MODEL = "anthropic/claude-haiku-5-5";
const cli = join(import.meta.dirname, "../../dist/cli.js");
const run = promisify(execFile);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("set ANTHROPIC_API_KEY");

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = {};
const log = (step: string, value: unknown) => {
	results[step] = value;
	console.log(`[smoke] ${step}:`, typeof value === "string" ? value : JSON.stringify(value));
};

const home = await mkdtemp(join(tmpdir(), "tobor-smoke-home-"));
const scratch = await mkdtemp(join(root, ".tobor-smoke-"));
const [apiPort, artPort] = [await freePort(), await freePort()];
const api = `http://127.0.0.1:${apiPort}`;
let node: ChildProcess | undefined;

try {
	await mkdir(join(home, ".tobor"), { recursive: true });
	await writeFile(
		join(home, ".tobor", "config.yml"),
		[
			`roots: [${JSON.stringify(root)}]`,
			`listen: 127.0.0.1:${apiPort}`,
			`artifacts_listen: 127.0.0.1:${artPort}`,
			"defaults:",
			`  model: ${MODEL}`,
			"  thinking: low",
			"  approval_mode: ask",
			"  max_turns: 30",
			"",
		].join("\n"),
	);
	const init = await run(process.execPath, [cli, "init"], { env: { ...process.env, TOBOR_HOME: home } });
	log("init", init.stdout.trim().split("\n").slice(0, 3).join(" | "));
	await run("git", ["init", "-q"], { cwd: scratch });
	await writeFile(join(scratch, "scratch.txt"), "alpha\nbeta\ngamma\n");

	node = spawn(process.execPath, [cli, "node"], { env: { ...process.env, TOBOR_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	node.stdout!.on("data", (d: Buffer) => {
		out += d;
	});
	node.stderr!.on("data", (d: Buffer) => process.stderr.write(`[node] ${d}`));
	for (let i = 0; !out.includes("artifacts  http"); i++) {
		if (i > 200 || node.exitCode !== null) throw new Error(`node did not start: ${out}`);
		await sleep(100);
	}
	log("node", out.trim());

	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const res = await fetch(`${api}${path}`, {
			method,
			headers: { origin: api, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
		return (text ? JSON.parse(text) : undefined) as T;
	};
	const create = (body: Record<string, unknown>) =>
		call<{ id: number }>("POST", "/api/sessions", { cwd: scratch, model: MODEL, ...body }).then((r) => r.id);
	const detail = (id: number) => call<SessionDetail>("GET", `/api/sessions/${id}`);
	const entries = (id: number) => call<EntriesResponse>("GET", `/api/sessions/${id}/entries?order=asc&limit=500`);
	const texts = async (id: number) =>
		(await entries(id)).items.flatMap((e) => {
			const m = e.model?.[0] as { role?: string; content?: unknown } | undefined;
			if (!m) return [];
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content as { type: string; text?: string; name?: string }[]) ?? []);
			return content.map((c) => `${m.role}: ${c.type === "text" ? c.text : c.type === "toolCall" ? `call ${c.name}` : c.type}`);
		});
	const idle = async (id: number, done: () => Promise<boolean> = async () => true, ms = 240_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const d = await detail(id);
			if (d.state === "failed") throw new Error(`session ${id} failed: ${JSON.stringify(d.failure)}`);
			if (d.state === "idle" && (await done())) return d;
			await sleep(1000);
		}
		throw new Error(`session ${id} did not settle; transcript: ${(await texts(id)).join("\n")}`);
	};

	// 1. Director → fast worker → report.
	const director = await create({ mode: "director", approval_mode: "auto", prompt: "Use the task tool to have a fast worker reply pong, then wait" });
	await idle(director, async () => (await texts(director)).some((t) => t.startsWith("user: [worker")));
	const workers = await call<WorkerSummary[]>("GET", `/api/sessions/${director}/workers`);
	log("director.workers", workers.map((w) => ({ name: w.name, agent: w.agent, state: w.state, lastText: w.lastText })));
	log("director.report", (await texts(director)).filter((t) => t.startsWith("user: [worker")).join("\n"));
	log("director.final", (await texts(director)).at(-1));

	// 2. Solo hashline read + edit.
	const file = join(scratch, "scratch.txt");
	const editor = await create({
		mode: "solo",
		approval_mode: "auto",
		prompt: `Use the read tool on ${file}, then use the edit tool to change the line "beta" to "BETA". Reply "edited".`,
	});
	await idle(editor);
	log("edit.tools", (await texts(editor)).filter((t) => t.includes("call ")));
	log("edit.file", JSON.stringify(await readFile(file, "utf8")));

	// 3. Artifact create + publish, then the viewer page and its PDF.
	const artist = await create({
		mode: "solo",
		approval_mode: "auto",
		prompt:
			'Call artifact_create with slug "smoke-test" and title "Smoke". Then edit the created index.html, replacing ' +
			"<!-- content --> with <h1>pong</h1>, then call artifact_publish with slug smoke-test. Reply with the URL.",
	});
	await idle(artist);
	const artifacts = await call<ArtifactSummary[]>("GET", "/api/artifacts");
	const latest = artifacts.find((a) => a.slug === "smoke-test");
	if (!latest) throw new Error(`no artifact published: ${(await texts(artist)).join("\n")}`);
	const revs = await call<{ url: string; pdfUrl: string }[]>("GET", `/api/artifacts/${latest.projectId}/smoke-test/revisions`);
	const page = await fetch(revs[0]!.url);
	log("artifact.page", { url: revs[0]!.url, status: page.status, hasPong: (await page.text()).includes("pong") });
	let pdfStatus = 0;
	for (let i = 0; i < 60; i++) {
		const pdf = await fetch(revs[0]!.pdfUrl);
		pdfStatus = pdf.status;
		await pdf.arrayBuffer();
		if (pdfStatus === 200 || (pdfStatus === 503 && pdf.headers.get("retry-after") === null)) break;
		await sleep(2000);
	}
	log("artifact.pdf", { url: revs[0]!.pdfUrl, status: pdfStatus });

	// 4. Approval round-trip in ask mode.
	const asker = await create({ mode: "solo", approval_mode: "ask", prompt: "Run `echo approved-smoke` with the bash tool and reply with its output." });
	let pending: PendingApproval | undefined;
	for (let i = 0; i < 120 && !pending; i++) {
		pending = (await call<PendingApproval[]>("GET", "/api/approvals")).find((p) => p.sessionId === asker);
		if (!pending) await sleep(1000);
	}
	if (!pending) throw new Error("no approval requested");
	log("approval.pending", { tool: pending.tool, args: pending.args, state: (await detail(asker)).state });
	await call("POST", `/api/approvals/${pending.callId}`, { decision: "approve" });
	await idle(asker);
	log("approval.after", (await texts(asker)).slice(-2));
	console.log("[smoke] OK");
} finally {
	node?.kill("SIGTERM");
	await new Promise((r) => (node && node.exitCode === null ? node.once("exit", r) : r(undefined)));
	await rm(scratch, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}
