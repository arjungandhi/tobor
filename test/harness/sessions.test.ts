import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type LiveState,
	MemoryStorage,
	type SettledSubmissionRecord,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionState } from "../../src/api/types.js";
import { type BootedHost, boot } from "../../src/server/harness/boot.js";
import { DIRECTOR_RULES, PREAMBLE } from "../../src/server/harness/sections.js";
import { deriveState, summarizeUsage, titleFromPrompt } from "../../src/server/harness/sessions.js";
import { entryText, fakeBash, fauxModels, tempHome } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;
const hosts: BootedHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown();
});

type Started = {
	home: string;
	root: string;
	host: BootedHost;
	script(responses: FauxResponseStep[]): void;
	states: { id: number; state: SessionState }[];
	reachedState(id: number, state: SessionState): Promise<void>;
	settle(submissionId: number): Promise<SettledSubmissionRecord>;
};

async function start(): Promise<Started> {
	const { home, root } = await tempHome();
	const faux = fauxModels();
	const host = await boot({ home, storage: new MemoryStorage(), models: faux.models, plugins: { modules: [fakeBash().module] } });
	hosts.push(host);
	const states: { id: number; state: SessionState }[] = [];
	const waiters: { id: number; state: SessionState; resolve(): void }[] = [];
	host.events.on("session.state", (e) => {
		states.push({ id: e.id, state: e.state });
		for (const w of waiters.filter((w) => w.id === e.id && w.state === e.state)) w.resolve();
	});
	const reachedState = (id: number, state: SessionState): Promise<void> => {
		if (states.some((s) => s.id === id && s.state === state)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ id, state, resolve });
		return promise;
	};
	const settle = async (submissionId: number) =>
		(await host.harness.submission(submissionId as SubmissionId, ctx))!.wait(ctx);
	return { home, root, host, script: faux.script, states, reachedState, settle };
}

describe("pure helpers", () => {
	it("derives state from pi.live and pending approvals", () => {
		const run = { taskId: 1, inputs: [], turns: 0 } as unknown as NonNullable<LiveState["run"]>;
		const failure = { taskId: 1, inputs: [], reason: "model_error", detail: "boom" } as unknown as NonNullable<LiveState["runFailure"]>;
		expect(deriveState(undefined, 0)).toEqual({ state: "idle" });
		expect(deriveState({ run }, 0)).toEqual({ state: "running" });
		expect(deriveState({ run }, 2)).toEqual({ state: "waiting" });
		expect(deriveState({ runFailure: failure }, 0)).toEqual({ state: "failed", failure: { reason: "model_error", detail: "boom" } });
	});

	it("titles from the first 60 characters with whitespace collapsed", () => {
		expect(titleFromPrompt("  fix\n\nthe   build ")).toBe("fix the build");
		expect(titleFromPrompt("x".repeat(80))).toHaveLength(60);
	});

	it("sums usage over models", () => {
		const u = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.5 } };
		const usage = { models: { a: u, b: u }, tools: {} } as never;
		expect(summarizeUsage(usage)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, totalTokens: 20, cost: 1 });
	});
});

describe("SessionIndex", () => {
	it("creates, runs to idle, and lists with derived state", async () => {
		const t = await start();
		t.script([fauxAssistantMessage("pong")]);
		const prompt = `reply pong ${"and keep this title short ".repeat(4)}`;
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt });
		expect(await t.settle(submissionId)).toMatchObject({ status: "done" });
		await t.reachedState(id, "idle");
		expect(t.states.filter((s) => s.id === id).map((s) => s.state)).toEqual(["running", "idle"]);

		const [row] = await t.host.sessions.list();
		expect(row).toMatchObject({
			id,
			title: titleFromPrompt(prompt),
			cwd: t.root,
			model: "faux/m",
			mode: "solo",
			approval_mode: "auto",
			kind: "session",
			state: "idle",
			pending: 0,
			archived: false,
		});
		expect(row!.updatedAt).toBeGreaterThanOrEqual(row!.createdAt);
		expect(await t.host.sessions.get(id)).toMatchObject({ id, thinking: "off", max_turns: 100, workers: 0 });

		const page = await t.host.sessions.entries(id, { order: "asc" });
		const visible = page.items.filter((e) => e.kind !== "pi.system");
		expect(visible.map((e) => e.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(entryText(visible[1])).toBe("pong");
		expect(page.more).toBe(false);
		expect((await t.host.sessions.entries(id, { order: "desc", limit: 1 })).more).toBe(true);
		expect(await t.host.sessions.cwds()).toEqual({ roots: [t.root], recent: [t.root] });

		const node = JSON.parse(await readFile(join(t.home, "node.json"), "utf8"));
		expect(node.systemConversationId).toBe(t.host.systemConversationId);
	});

	it("creates a promptless session idle with no turns, and the first input names it", async () => {
		const t = await start();
		const created = await t.host.sessions.create({ cwd: t.root });
		const { id } = created;
		expect(created.submissionId).toBeUndefined();
		expect((await t.host.sessions.create({ cwd: t.root, prompt: "   " })).submissionId).toBeUndefined();

		expect((await t.host.sessions.list()).find((s) => s.id === id)).toMatchObject({ id, state: "idle", pending: 0, cwd: t.root, title: "new session" });
		expect(await t.host.sessions.get(id)).toMatchObject({ id, state: "idle", title: "new session", workers: 0 });
		const page = await t.host.sessions.entries(id, { order: "asc" });
		expect(page.items.filter((e) => e.kind === "pi.user" || e.kind === "pi.assistant")).toEqual([]);
		expect(t.states.filter((s) => s.id === id)).toEqual([]);
		expect(await t.host.sessions.cwds()).toEqual({ roots: [t.root], recent: [t.root] });

		t.script([fauxAssistantMessage("hello")]);
		const { submissionId } = await t.host.sessions.input(id, { content: "  first   words\nhere ", mode: "prompt", requestId: "r1" });
		expect(await t.settle(submissionId)).toMatchObject({ status: "done" });
		await t.reachedState(id, "idle");
		expect(await t.host.sessions.get(id)).toMatchObject({ state: "idle", title: "first words here" });
		const after = await t.host.sessions.entries(id, { order: "asc" });
		expect(after.items.filter((e) => e.kind === "pi.user" || e.kind === "pi.assistant").map((e) => e.kind)).toEqual(["pi.user", "pi.assistant"]);

		await t.host.sessions.patch(id, { title: "mine" });
		t.script([fauxAssistantMessage("again")]);
		await t.settle((await t.host.sessions.input(id, { content: "second", mode: "prompt", requestId: "r2" })).submissionId);
		expect((await t.host.sessions.get(id))?.title).toBe("mine");
	});

	it("rejects bad cwds and models", async () => {
		const t = await start();
		await expect(t.host.sessions.create({ cwd: "relative/dir", prompt: "x" })).rejects.toMatchObject({ status: 400 });
		await expect(t.host.sessions.create({ cwd: join(t.root, "missing"), prompt: "x" })).rejects.toMatchObject({ status: 400 });
		await expect(t.host.sessions.create({ cwd: t.home, prompt: "x" })).rejects.toMatchObject({ status: 403, code: "outside_roots" });
		await expect(t.host.sessions.create({ cwd: t.root, prompt: "x", model: "nope" })).rejects.toMatchObject({ status: 400 });
		await expect(t.host.sessions.create({ cwd: t.root, prompt: "x", model: "faux/zzz" })).rejects.toMatchObject({ code: "unknown_model" });
		expect(await t.host.sessions.list()).toEqual([]);
	});

	it("patches, archives, takes follow-up input and deletes", async () => {
		const t = await start();
		t.script([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "first" });
		await t.settle(submissionId);
		const detail = await t.host.sessions.patch(id, { title: "renamed", approval_mode: "auto", thinking: "low" });
		expect(detail).toMatchObject({ title: "renamed", approval_mode: "auto", thinking: "low" });
		await expect(t.host.sessions.patch(id, { title: "  " })).rejects.toMatchObject({ status: 400 });

		const input = await t.host.sessions.input(id, { content: "second", mode: "follow_up", requestId: "r1" });
		expect(await t.settle(input.submissionId)).toMatchObject({ status: "done" });
		const again = await t.host.sessions.input(id, { content: "second", mode: "follow_up", requestId: "r1" });
		expect(again.submissionId).toBe(input.submissionId);

		await t.host.sessions.archive(id);
		expect(await t.host.sessions.list()).toEqual([]);
		expect((await t.host.sessions.list({ archived: true })).map((s) => s.id)).toEqual([id]);
		await t.host.sessions.patch(id, { archived: false });
		expect((await t.host.sessions.list()).map((s) => s.id)).toEqual([id]);

		const deleted = Promise.withResolvers<void>();
		t.host.events.on("session.updated", (e) => e.deleted && e.id === id && deleted.resolve());
		await t.host.sessions.delete(id);
		await deleted.promise;
		expect(await t.host.sessions.list({ archived: true })).toEqual([]);
		await expect(t.host.sessions.delete(id)).rejects.toMatchObject({ status: 404 });
	});

	it("reports waiting while an approval is pending", async () => {
		const t = await start();
		t.script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("listed"),
		]);
		const requested = Promise.withResolvers<void>();
		t.host.events.on("approval.requested", () => requested.resolve());
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "list files", approvalMode: "ask" });
		await requested.promise;
		await t.reachedState(id, "waiting");
		expect((await t.host.sessions.list())[0]).toMatchObject({ state: "waiting", pending: 1 });
		await t.host.approvals.decide(id, "call-1", "approve");
		expect(await t.settle(submissionId)).toMatchObject({ status: "done" });
		await t.reachedState(id, "idle");
		expect(t.states.filter((s) => s.id === id).map((s) => s.state)).toEqual(["running", "waiting", "running", "idle"]);
	});

	it("aborts a running session", async () => {
		const t = await start();
		const gate = Promise.withResolvers<void>();
		const slow: FauxResponseStep = async () => {
			await gate.promise;
			return fauxAssistantMessage("late");
		};
		t.script([slow]);
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "wait" });
		await t.reachedState(id, "running");
		await t.host.sessions.abort(id);
		gate.resolve();
		expect(await t.settle(submissionId)).toMatchObject({ status: "unanswered", reason: "aborted" });
		await t.reachedState(id, "failed");
		expect((await t.host.sessions.get(id))?.failure?.reason).toBe("aborted");
	});
});

describe("system prompt sections", () => {
	async function promptOf(t: Started, cwd: string, mode: "director" | "solo") {
		let captured = "";
		t.script([
			(context) => {
				captured = JSON.stringify(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		const { submissionId } = await t.host.sessions.create({ cwd, prompt: "hi", mode });
		await t.settle(submissionId);
		return captured;
	}

	it("renders node and project files in design order", async () => {
		const t = await start();
		const project = join(t.root, "proj");
		const sub = join(project, "sub");
		await mkdir(join(project, ".git"), { recursive: true });
		await mkdir(join(project, ".tobor", "skills", "deploy"), { recursive: true });
		await mkdir(join(t.home, ".tobor", "skills", "notes"), { recursive: true });
		await mkdir(sub, { recursive: true });
		const files: [string, string][] = [
			[join(t.home, ".tobor", "APPEND_SYSTEM.md"), "NODE-APPEND"],
			[join(project, ".tobor", "APPEND_SYSTEM.md"), "PROJECT-APPEND"],
			[join(t.home, ".tobor", "RULES.md"), "NODE-RULES"],
			[join(project, ".tobor", "RULES.md"), "PROJECT-RULES"],
			[join(t.home, ".tobor", "AGENTS.md"), "NODE-AGENTS"],
			[join(project, ".tobor", "AGENTS.md"), "PROJECT-TOBOR-AGENTS"],
			[join(project, "AGENTS.md"), "ROOT-AGENTS"],
			[join(sub, "CLAUDE.md"), "SUB-CLAUDE"],
			[join(t.home, ".tobor", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes\n---\nbody"],
			[join(project, ".tobor", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nbody"],
		];
		for (const [path, text] of files) await writeFile(path, text);

		const text = await promptOf(t, sub, "director");
		const order = [
			PREAMBLE.split("\n")[0]!,
			DIRECTOR_RULES.split("\n")[0]!,
			"NODE-APPEND",
			"PROJECT-APPEND",
			"Reading and editing files:",
			"NODE-RULES",
			"PROJECT-RULES",
			"NODE-AGENTS",
			"PROJECT-TOBOR-AGENTS",
			"ROOT-AGENTS",
			"SUB-CLAUDE",
			"- notes — Take notes",
			"- deploy — Ship it",
			`Working directory: ${sub}`,
		];
		const positions = order.map((needle) => text.indexOf(needle));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it("replaces the preamble with SYSTEM.md and omits director rules in solo", async () => {
		const t = await start();
		await writeFile(join(t.home, ".tobor", "SYSTEM.md"), "CUSTOM-SYSTEM");
		const text = await promptOf(t, t.root, "solo");
		expect(text).toContain("CUSTOM-SYSTEM");
		expect(text).not.toContain(PREAMBLE.split("\n")[0]!);
		expect(text).not.toContain(DIRECTOR_RULES.split("\n")[0]!);
	});

	it("limits director model tools and restores them in solo", async () => {
		const t = await start();
		t.script([fauxAssistantMessage("a")]);
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "hi", mode: "director" });
		await t.settle(submissionId);
		const conversation = (await t.host.harness.conversation(id as ConversationId, ctx))!;
		expect((await conversation.agent(ctx)).tools.map((x) => x.name)).toEqual([]);
		await t.host.sessions.patch(id, { mode: "solo" });
		expect((await conversation.agent(ctx)).tools.map((x) => x.name)).toEqual(["bash"]);
	});
});
