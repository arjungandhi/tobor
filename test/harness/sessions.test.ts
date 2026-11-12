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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../src/api/types.js";
import { WorkersDoc, type WorkerRecord } from "../../src/docs.js";
import { type BootedHost, boot } from "../../src/server/harness/boot.js";
import { DIRECTOR_RULES, PREAMBLE } from "../../src/server/harness/sections.js";
import { deriveState, type SessionIndex, summarizeUsage, titleFromPrompt, toUserInput } from "../../src/server/harness/sessions.js";
import { SessionDoc } from "../../src/docs.js";
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
	scriptTitle(responses: FauxResponseStep[]): void;
	states: { id: number; state: SessionState }[];
	reachedState(id: number, state: SessionState): Promise<void>;
	settle(submissionId: number): Promise<SettledSubmissionRecord>;
	/** Resolves once every title attempt started so far has finished. */
	titlesSettled(): Promise<void>;
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
	const titlesSettled = () => (host.sessions as SessionIndex).titlesSettled();
	return { home, root, host, script: faux.script, scriptTitle: faux.scriptTitle, states, reachedState, settle, titlesSettled };
}

describe("pure helpers", () => {
	it("derives state from pi.live and pending approvals or questions", () => {
		const run = { taskId: 1, inputs: [], turns: 0 } as unknown as NonNullable<LiveState["run"]>;
		const failure = { taskId: 1, inputs: [], reason: "model_error", detail: "boom" } as unknown as NonNullable<LiveState["runFailure"]>;
		expect(deriveState(undefined, 0, 0)).toEqual({ state: "idle" });
		expect(deriveState({ run }, 0, 0)).toEqual({ state: "running" });
		expect(deriveState({ run }, 2, 0)).toEqual({ state: "waiting" });
		expect(deriveState({ runFailure: failure }, 0, 0)).toEqual({ state: "failed", failure: { reason: "model_error", detail: "boom" } });
		// Live workers only matter once the director is otherwise idle: run > failure > working > idle.
		expect(deriveState(undefined, 0, 2)).toEqual({ state: "working" });
		expect(deriveState({ run }, 0, 2)).toEqual({ state: "running" });
		expect(deriveState({ run }, 1, 2)).toEqual({ state: "waiting" });
		expect(deriveState({ runFailure: failure }, 0, 2)).toMatchObject({ state: "failed" });
	});

	it("titles from the first 60 characters with whitespace collapsed", () => {
		expect(titleFromPrompt("  fix\n\nthe   build ")).toBe("fix the build");
		expect(titleFromPrompt("x".repeat(80))).toHaveLength(60);
	});

	it("maps text and attachments to user input", () => {
		const png = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
		const jpeg = { type: "image", data: "BBBB", mimeType: "image/jpeg" } as const;
		expect(toUserInput("hi")).toBe("hi");
		expect(toUserInput("hi", [])).toBe("hi");
		expect(toUserInput("hi", [png, jpeg])).toEqual([{ type: "text", text: "hi" }, png, jpeg]);
		expect(toUserInput("", [png])).toEqual([png]);
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

		const node = JSON.parse(await readFile(join(t.home, ".tobor", "state", "node.json"), "utf8"));
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

	it("submits image attachments as content blocks, image-only when the text is empty", async () => {
		const t = await start();
		const png = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as const;
		t.script([fauxAssistantMessage("a cat")]);
		const created = await t.host.sessions.create({ cwd: t.root, prompt: "", attachments: [png] });
		expect(created.submissionId).toBeDefined();
		expect(await t.settle(created.submissionId!)).toMatchObject({ status: "done" });
		await t.reachedState(created.id, "idle");
		const first = (await t.host.sessions.entries(created.id, { order: "asc" })).items.find((e) => e.kind === "pi.user");
		expect(first?.model?.[0]?.content).toEqual([png]);

		t.script([fauxAssistantMessage("again")]);
		const { submissionId } = await t.host.sessions.input(created.id, { content: "and this", attachments: [png], mode: "prompt", requestId: "img1" });
		expect(await t.settle(submissionId)).toMatchObject({ status: "done" });
		const users = (await t.host.sessions.entries(created.id, { order: "asc" })).items.filter((e) => e.kind === "pi.user");
		expect(users[1]?.model?.[0]?.content).toEqual([{ type: "text", text: "and this" }, png]);
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

	it("completes paths against the session cwd and 404s unknown sessions", async () => {
		const t = await start();
		await mkdir(join(t.root, "pkg"));
		await writeFile(join(t.root, "pkg", "main.ts"), "");
		const { id } = await t.host.sessions.create({ cwd: t.root });
		expect(await t.host.sessions.complete(id, "pk")).toEqual({ dir: t.root, entries: [{ name: "pkg", type: "dir" }] });
		expect((await t.host.sessions.complete(id, "pkg/")).entries).toEqual([{ name: "main.ts", type: "file" }]);
		expect((await t.host.sessions.complete(id, "../")).entries).toEqual([]);
		await expect(t.host.sessions.complete(999_999, "")).rejects.toMatchObject({ status: 404 });
	});

	it("completes without a session: defaults to the newest recent cwd inside the roots, else the first root, never outside", async () => {
		const t = await start();
		await mkdir(join(t.root, "pkg", "inner"), { recursive: true });
		await writeFile(join(t.root, "pkg", "main.ts"), "");
		await writeFile(join(t.root, "top.txt"), "");
		// No sessions yet: the first root.
		expect(await t.host.sessions.completeAt(undefined, "to")).toEqual({ dir: t.root, entries: [{ name: "top.txt", type: "file" }] });
		expect((await t.host.sessions.completeAt("  ", "to")).dir).toBe(t.root);
		await t.host.sessions.create({ cwd: join(t.root, "pkg") });
		// Newest recent cwd.
		expect(await t.host.sessions.completeAt(undefined, "ma")).toEqual({ dir: join(t.root, "pkg"), entries: [{ name: "main.ts", type: "file" }] });
		// Explicit cwd wins, and a cwd or prefix outside the roots reveals nothing.
		expect((await t.host.sessions.completeAt(t.root, "to")).entries).toEqual([{ name: "top.txt", type: "file" }]);
		expect(await t.host.sessions.completeAt(t.home, "")).toEqual({ dir: "", entries: [] });
		expect(await t.host.sessions.completeAt(t.root, "../")).toEqual({ dir: "", entries: [] });
		expect(await t.host.sessions.completeAt(join(t.root, "missing"), "")).toEqual({ dir: "", entries: [] });
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

	it("reports waiting while an ask_user question is pending", async () => {
		const t = await start();
		t.script([
			fauxAssistantMessage(fauxToolCall("ask_user", { question: "Which database?" }, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		const asked = Promise.withResolvers<void>();
		t.host.events.on("question.asked", () => asked.resolve());
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "build it" });
		await asked.promise;
		await t.reachedState(id, "waiting");
		expect((await t.host.sessions.list())[0]).toMatchObject({ state: "waiting", pending: 1 });
		expect(await t.host.sessions.get(id)).toMatchObject({ state: "waiting", pending: 1 });
		await t.host.questions.answer(id, "call-1", "sqlite");
		expect(await t.settle(submissionId)).toMatchObject({ status: "done" });
		await t.reachedState(id, "idle");
		expect(t.states.filter((s) => s.id === id).map((s) => s.state)).toEqual(["running", "waiting", "running", "idle"]);
		expect((await t.host.sessions.get(id))?.pending).toBe(0);
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

describe("working state", () => {
	const record = (state: WorkerRecord["state"]): WorkerRecord => ({
		id: "w1",
		name: "h1",
		agent: "helper",
		holderTaskId: 1,
		requestId: "c:0",
		state,
		createdAt: 1,
		...(state === "starting" || state === "running" ? {} : { finishedAt: 2 }),
	});
	const setWorker = async (t: Started, id: number, state: WorkerRecord["state"]) => {
		await t.host.harness.commit(async (tx) => {
			(await tx.doc(WorkersDoc, id as ConversationId)).workers.w1 = record(state);
		}, ctx);
	};
	const emitWorker = (t: Started, id: number, state: WorkerRecord["state"]) =>
		t.host.events.emit({
			type: "worker.state",
			sessionId: id,
			worker: { id: "w1", name: "h1", agent: "helper", state, usage: summarizeUsage(undefined), lastText: "", createdAt: 1 },
		});

	it("lists and gets an idle director with a live worker as working", async () => {
		const t = await start();
		const { id } = await t.host.sessions.create({ cwd: t.root, mode: "director" });
		expect((await t.host.sessions.get(id))!.state).toBe("idle");
		await setWorker(t, id, "running");
		expect((await t.host.sessions.list()).find((s) => s.id === id)!.state).toBe("working");
		expect(await t.host.sessions.get(id)).toMatchObject({ state: "working", workers: 1 });
		await setWorker(t, id, "done");
		expect((await t.host.sessions.list()).find((s) => s.id === id)!.state).toBe("idle");
		expect(await t.host.sessions.get(id)).toMatchObject({ state: "idle", workers: 1 });
	});

	it("emits session.state working then idle as worker.state events arrive", async () => {
		const t = await start();
		t.script([fauxAssistantMessage("a")]);
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "go", mode: "director" });
		await t.settle(submissionId);
		await t.reachedState(id, "idle");
		t.states.length = 0;

		await setWorker(t, id, "running");
		emitWorker(t, id, "running");
		await t.reachedState(id, "working");
		await setWorker(t, id, "done");
		emitWorker(t, id, "done");
		await t.reachedState(id, "idle");
		expect(t.states.filter((s) => s.id === id).map((s) => s.state)).toEqual(["working", "idle"]);
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

	describe("ask_user prompt gating", () => {
		/** The prompt of a session whose model tools are narrowed by `remove` (the way workers and schedule runs lack ask_user). */
		async function gatedPrompt(mode: "director" | "solo", remove: string[]) {
			const t = await start();
			let captured = "";
			t.script([
				(context) => {
					captured = JSON.stringify(context.messages) + JSON.stringify((context as { systemPrompt?: string }).systemPrompt ?? "");
					return fauxAssistantMessage("ok");
				},
			]);
			const { id } = await t.host.sessions.create({ cwd: t.root, mode });
			const conversation = (await t.host.harness.conversation(id as ConversationId, ctx))!;
			const tools = t.host.registry.snapshot().tools().map((x) => x.tool);
			await conversation.configure({ modelTools: { remove: tools.filter((x) => remove.includes(x.name)) } }, ctx);
			const submission = await conversation.submit({ type: "input", content: "hi" }, ctx);
			await t.settle(submission.id);
			return captured;
		}
		const RULE = "ask the user with `ask_user`";

		it("tells sessions that offer ask_user to use it, in the preamble and a guidance section", async () => {
			const text = await gatedPrompt("solo", []);
			expect(text).toContain(RULE);
			expect(text).toContain("Asking the operator");
		});

		it("says nothing about ask_user when the request does not offer it", async () => {
			const text = await gatedPrompt("solo", ["ask_user"]);
			expect(text).toContain(PREAMBLE.split("\n")[0]!);
			expect(text).not.toContain("ask_user");
			expect(text).not.toContain("Asking the operator");
		});

		it("keeps the director rules but drops their ask_user line without the tool", async () => {
			const withTool = await gatedPrompt("director", []);
			expect(withTool).toContain("workers cannot ask");
			const without = await gatedPrompt("director", ["ask_user"]);
			expect(without).toContain(DIRECTOR_RULES.split("\n")[0]!);
			expect(without).not.toContain("workers cannot ask");
			expect(without).not.toContain("ask_user");
		});
	});

	it("limits director model tools and restores them in solo", async () => {
		const t = await start();
		t.script([fauxAssistantMessage("a")]);
		const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "hi", mode: "director" });
		await t.settle(submissionId);
		const conversation = (await t.host.harness.conversation(id as ConversationId, ctx))!;
		expect((await conversation.agent(ctx)).tools.map((x) => x.name)).toEqual(["ask_user"]);
		await t.host.sessions.patch(id, { mode: "solo" });
		expect((await conversation.agent(ctx)).tools.map((x) => x.name)).toEqual(["ask_user", "bash"]);
	});

	it("never offers ask_user to schedule-kind sessions, whatever the mode", async () => {
		const t = await start();
		const names = async (id: number) =>
			(await (await t.host.harness.conversation(id as ConversationId, ctx))!.agent(ctx)).tools.map((x) => x.name);
		const solo = await t.host.sessions.create({ cwd: t.root, mode: "solo", kind: "schedule", scheduleId: "s1" });
		expect(await names(solo.id)).toEqual(["bash"]);
		await t.host.sessions.patch(solo.id, { mode: "director" });
		expect(await names(solo.id)).toEqual([]);
		await t.host.sessions.patch(solo.id, { mode: "solo" });
		expect(await names(solo.id)).toEqual(["bash"]);
		const director = await t.host.sessions.create({ cwd: t.root, mode: "director", kind: "schedule", scheduleId: "s2" });
		expect(await names(director.id)).toEqual([]);
	});

	describe("generated titles", () => {
		/** A title-model step that counts its calls and answers `reply` (after `gate`, when given). */
		function titleStep(reply: string | { error: string }, gate?: Promise<void>) {
			const seen: { prompt: string }[] = [];
			const called = Promise.withResolvers<void>();
			const step: FauxResponseStep = async (context) => {
				const last = context.messages.at(-1);
				seen.push({ prompt: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content) });
				called.resolve();
				await gate;
				return typeof reply === "string"
					? fauxAssistantMessage(reply)
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: reply.error });
			};
			return { step, seen, called: called.promise };
		}

		it("replaces the prompt title with a cleaned model title after the first idle", async () => {
			const t = await start();
			const title = titleStep('  "Reply with pong."\n');
			t.script([fauxAssistantMessage("pong")]);
			t.scriptTitle([title.step]);
			const updated: number[] = [];
			t.host.events.on("session.updated", (e) => updated.push(e.id));
			const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "please reply pong" });
			await t.settle(submissionId);
			await vi.waitFor(async () => expect((await t.host.sessions.get(id))?.title).toBe("Reply with pong"));
			expect(title.seen[0]!.prompt).toContain("please reply pong");
			expect(title.seen[0]!.prompt).toContain("pong");
			expect((await t.host.sessions.list())[0]?.title).toBe("Reply with pong");
			expect(updated.length).toBeGreaterThanOrEqual(2);
			const doc = await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx);
			expect(doc).toMatchObject({ title: "Reply with pong", titleSource: "model" });

			// Later exchanges never retitle.
			t.script([fauxAssistantMessage("again")]);
			const second = titleStep("Something else");
			t.scriptTitle([second.step]);
			await t.settle((await t.host.sessions.input(id, { content: "more", mode: "follow_up", requestId: "r2" })).submissionId);
			await vi.waitFor(() => expect(t.states.filter((s) => s.id === id && s.state === "idle").length).toBeGreaterThanOrEqual(2));
			await t.titlesSettled();
			expect(second.seen).toEqual([]);
			expect((await t.host.sessions.get(id))?.title).toBe("Reply with pong");
		});

		it("caps a long model title at 60 characters", async () => {
			const t = await start();
			t.script([fauxAssistantMessage("ok")]);
			t.scriptTitle([titleStep("word ".repeat(30)).step]);
			const { id } = await t.host.sessions.create({ cwd: t.root, prompt: "go" });
			await vi.waitFor(async () => expect((await t.host.sessions.get(id))?.title.length).toBeGreaterThan(2));
			expect((await t.host.sessions.get(id))?.title.length).toBeLessThanOrEqual(60);
		});

		it("never overwrites a rename made before the first idle", async () => {
			const t = await start();
			const title = titleStep("Model title");
			const gate = Promise.withResolvers<void>();
			t.script([async () => (await gate.promise, fauxAssistantMessage("done"))]);
			t.scriptTitle([title.step]);
			const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "work" });
			// The first reply is held back, so the rename lands before the session can go idle.
			await t.host.sessions.patch(id, { title: "mine" });
			gate.resolve();
			await t.settle(submissionId);
			await t.reachedState(id, "idle");
			await t.titlesSettled();
			expect(title.seen).toEqual([]);
			expect((await t.host.sessions.get(id))?.title).toBe("mine");
			expect(await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx)).toMatchObject({ titleSource: "user" });
		});

		it("lets a rename that lands while the title call is in flight win", async () => {
			const t = await start();
			const gate = Promise.withResolvers<void>();
			const title = titleStep("Model title", gate.promise);
			t.script([fauxAssistantMessage("done")]);
			t.scriptTitle([title.step]);
			const { id } = await t.host.sessions.create({ cwd: t.root, prompt: "work" });
			await title.called;
			await t.host.sessions.patch(id, { title: "mine" });
			gate.resolve();
			await t.titlesSettled();
			expect((await t.host.sessions.get(id))?.title).toBe("mine");
			expect((await t.host.sessions.list())[0]?.title).toBe("mine");
			expect(await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx)).toMatchObject({ titleSource: "user" });
		});

		it("never retitles a session without a titleSource (it predates titling)", async () => {
			const t = await start();
			const gate = Promise.withResolvers<void>();
			const title = titleStep("Model title");
			t.script([async () => (await gate.promise, fauxAssistantMessage("done"))]);
			t.scriptTitle([title.step]);
			const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "old session" });
			await t.host.harness.commit(async (tx) => {
				delete (await tx.doc(SessionDoc, id as ConversationId)).titleSource;
			}, ctx);
			expect(await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx)).not.toHaveProperty("titleSource");
			gate.resolve();
			await t.settle(submissionId);
			await t.reachedState(id, "idle");
			await t.titlesSettled();
			expect(title.seen).toEqual([]);
			expect((await t.host.sessions.get(id))?.title).toBe("old session");
			expect(await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx)).not.toHaveProperty("titleSource");
		});

		it("keeps the prompt title when the title call fails", async () => {
			const t = await start();
			const title = titleStep({ error: "boom" });
			t.script([fauxAssistantMessage("done")]);
			t.scriptTitle([title.step]);
			const { id } = await t.host.sessions.create({ cwd: t.root, prompt: "keep me" });
			await title.called;
			await t.titlesSettled();
			expect((await t.host.sessions.get(id))?.title).toBe("keep me");
			expect(await t.host.harness.snapshot(SessionDoc, id as ConversationId, ctx)).toMatchObject({ titleSource: "prompt" });
		});

		it("leaves schedule-run sessions with their names", async () => {
			const t = await start();
			const title = titleStep("Model title");
			t.script([fauxAssistantMessage("done")]);
			t.scriptTitle([title.step]);
			const { id, submissionId } = await t.host.sessions.create({ cwd: t.root, prompt: "nightly job", kind: "schedule", scheduleId: "s1" });
			await t.settle(submissionId);
			await t.reachedState(id, "idle");
			await t.titlesSettled();
			expect(title.seen).toEqual([]);
			expect((await t.host.sessions.get(id))?.title).toBe("nightly job");
		});
	});
});
