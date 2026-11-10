import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, createRegistry, Harness, type JsonObject, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition, NodeEvent } from "../../src/api/types.js";
import { validateConfig } from "../../src/config/load.js";
import { WorkersDoc } from "../../src/docs.js";
import { EventBus } from "../../src/events.js";
import type { Host } from "../../src/host.js";
import { assistantText } from "../../src/server/harness/workers/holder.js";
import { Workers } from "../../src/server/harness/workers/service.js";
import { type WorkerHost, workersModule } from "../../src/server/harness/workers/tools.js";
import { todoModule } from "../../src/server/harness/todo/tool.js";
import { composeExtension } from "../../src/tools/registry.js";

const ctx = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" };

function text(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

function agent(name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
	return { name, description: name, approval: "inherit", source: "node", path: `/x/${name}.md`, body: `You are ${name}.`, ...extra };
}

async function until<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await probe();
		if (value !== undefined) return value;
		// Durable state advances on the Harness scheduler; poll the committed condition.
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("timed out");
}

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(ctx);
	harness = undefined;
});

type Reply = ReturnType<typeof fauxAssistantMessage>;
const DEFAULT_TASKS = [{ agent: "helper", name: "h1", task: "say hi", context: "WORKER brief" }];
/** Director user messages the script maps straight to a tool call. */
const COMMANDS: Record<string, { tool: string; args: JsonObject }> = {
	list: { tool: "agent_list", args: {} },
	stop: { tool: "agent_stop", args: { id: "w1" } },
	"stop-unknown": { tool: "agent_stop", args: { id: "nope" } },
	"stop-neither": { tool: "agent_stop", args: {} },
	steer: { tool: "agent_send", args: { id: "w1", message: "WORKER FOLLOW-UP: change course" } },
	"steer-late": { tool: "agent_send", args: { id: "w1", message: "too late" } },
	"steer-unknown": { tool: "agent_send", args: { id: "nope", message: "hello" } },
};

async function setup(workerReply: (msgs: Message[]) => Reply | Promise<Reply>, options: { tasks?: JsonObject[]; maxWorkers?: number } = {}) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tobor-workers-")));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const steps = Array.from({ length: 40 }, () => (context: { messages: Message[] }) => {
		const msgs = context.messages;
		if (msgs.some((m) => m.role === "user" && text(m).includes("WORKER"))) return workerReply(msgs);
		const last = msgs.at(-1);
		if (last?.role === "user" && text(last).startsWith("[worker")) return fauxAssistantMessage(`director got: ${text(last)}`);
		const command = last?.role === "user" ? COMMANDS[text(last)] : undefined;
		if (command) return fauxAssistantMessage(fauxToolCall(command.tool, command.args), { stopReason: "toolUse" });
		if (last?.role === "user") {
			return fauxAssistantMessage(
				fauxToolCall("task", { tasks: options.tasks ?? DEFAULT_TASKS }),
				{ stopReason: "toolUse" },
			);
		}
		if (last?.role === "toolResult" && last.toolName === "task") {
			return fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	});
	faux.setResponses(steps);
	const events: NodeEvent[] = [];
	const bus = new EventBus();
	bus.onAny((e) => events.push(e));
	let host: WorkerHost | undefined;
	const registry = createRegistry();
	registry.install(composeExtension("tobor", [workersModule(() => host as WorkerHost, { pollMs: 20 }), todoModule]));
	harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, env: ({ cwd: c }) => new NodeExecutionEnv({ cwd: c ?? cwd }) },
		ctx,
	);
	const config = validateConfig(undefined, cwd).config;
	if (options.maxWorkers !== undefined) config.defaults.max_workers = options.maxWorkers;
	host = {
		harness,
		config,
		events: bus,
		agentData: { listAgents: async () => [agent("helper"), agent("auto-one", { approval: "auto" })] } as unknown as Host["agentData"],
	};
	const director = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	await director.configure({ model: MODEL, cwd }, ctx);
	const service = new Workers(() => ({ harness: harness as Harness, ctx }));
	return { director, events, service, harness, cwd };
}

async function directorTexts(h: Harness, director: Conversation): Promise<string[]> {
	const page = await director.entries({ order: "ascending" }, 100, undefined, ctx);
	return page.items.flatMap((e) => {
		const m = e.model?.[0];
		if (!m) return [];
		return m.role === "assistant" ? [`A:${assistantText(e)}`] : m.role === "user" ? [`U:${text(m)}`] : [];
	});
}

/** The director's tool results for `tool`, oldest first. */
async function toolResults(director: Conversation, tool: string): Promise<{ text: string; isError: boolean }[]> {
	const page = await director.entries({ order: "ascending" }, 100, undefined, ctx);
	return page.items.flatMap((e) => {
		const m = e.model?.[0];
		return m?.role === "toolResult" && m.toolName === tool ? [{ text: text(m), isError: m.isError }] : [];
	});
}

/** Submit a director message and wait for its turn to settle. */
async function say(director: Conversation, content: string): Promise<void> {
	expect((await (await director.submit({ type: "input", content }, ctx)).wait(ctx)).status).toBe("done");
}

describe("director workers", () => {
	it("spawns a worker, returns at once, and the worker reports back into the director", async () => {
		const { director, events, service, harness: h } = await setup(() => fauxAssistantMessage(fauxText("worker says hi")));
		const submission = await director.submit({ type: "input", content: "go" }, ctx);
		const settled = await submission.wait(ctx);
		expect(settled.status).toBe("done");

		const done = await until(async () => {
			const doc = await h.snapshot(WorkersDoc, director.id, ctx);
			const w = doc?.workers.w1;
			return w?.state === "done" ? w : undefined;
		});
		expect(done).toMatchObject({ name: "h1", agent: "helper", answer: "worker says hi", requestId: expect.stringMatching(/:0$/) });
		expect(done.conversationId).toBeTypeOf("number");

		const texts = await until(async () => {
			const t = await directorTexts(h, director);
			return t.some((x) => x.startsWith("A:director got")) ? t : undefined;
		});
		expect(texts).toContain("U:[worker h1 finished: done]\nworker says hi");
		expect(texts.at(-1)).toBe("A:director got: [worker h1 finished: done]\nworker says hi");

		const [summary] = await service.list(director.id);
		expect(summary).toMatchObject({ id: "w1", state: "done", lastText: "worker says hi" });
		expect(await service.live(director.id)).toBe(0);
		expect(events.some((e) => e.type === "worker.state" && e.worker.state === "done")).toBe(true);

		const worker = await h.conversation(done.conversationId as ConversationId, ctx);
		const agentState = await worker?.agent(ctx);
		expect(agentState?.tools.map((t) => t.name)).not.toContain("task");
		expect(agentState?.instructions).toBe("You are helper.");
	});

	it("stop aborts a running worker and the director is told", async () => {
		const gate = Promise.withResolvers<void>();
		const { director, service, harness: h } = await setup(async () => {
			await gate.promise;
			return fauxAssistantMessage("too late");
		});
		await (await director.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		await until(async () => ((await service.get(director.id, "w1"))?.state === "running" ? true : undefined));
		expect(await service.live(director.id)).toBe(1);
		await service.stop(director.id, "w1");
		gate.resolve();
		const w = await until(async () => {
			const s = await service.get(director.id, "w1");
			return s?.finishedAt !== undefined ? s : undefined;
		});
		expect(w.state).toBe("aborted");
		const texts = await until(async () => {
			const t = await directorTexts(h, director);
			return t.some((x) => x.startsWith("U:[worker h1 finished: aborted")) ? t : undefined;
		});
		expect(texts.filter((x) => x.startsWith("U:[worker")).length).toBe(1);
	});

	it("refuses unknown agents and enforces max_workers", async () => {
		const tasks = [
			{ agent: "nope", name: "nope", task: "x" },
			{ agent: "helper", name: "a", task: "WORKER a" },
			{ agent: "helper", name: "b", task: "WORKER b" },
		];
		const { director, harness: h } = await setup(() => fauxAssistantMessage("done"), { tasks, maxWorkers: 1 });
		await (await director.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		const page = await director.entries({ order: "ascending" }, 100, undefined, ctx);
		const result = page.items.map((e) => e.model?.[0]).find((m) => m?.role === "toolResult" && m.toolName === "task");
		const out = text(result);
		expect(out).toContain("nope: error: unknown agent nope (have: helper, auto-one)");
		expect(out).toContain("a (w1): started");
		expect(out).toContain("b: error: max_workers (1) reached");
		const doc = await h.snapshot(WorkersDoc, director.id, ctx);
		expect(Object.keys(doc?.workers ?? {})).toEqual(["w1"]);
	});

	it("agent_list says so when the session has no workers", async () => {
		const { director } = await setup(() => fauxAssistantMessage("unused"));
		await say(director, "list");
		expect(await toolResults(director, "agent_list")).toEqual([{ text: "No workers in this session.", isError: false }]);
	});

	it("agent_list shows a finished worker's id, name, state and answer", async () => {
		const { director, harness: h } = await setup(() => fauxAssistantMessage(fauxText("worker says hi")));
		await say(director, "go");
		await until(async () => ((await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1?.state === "done" ? true : undefined));
		await say(director, "list");
		const [result] = await toolResults(director, "agent_list");
		expect(result).toMatchObject({ isError: false });
		expect(result?.text).toContain("w1");
		expect(result?.text).toContain("h1");
		expect(result?.text).toContain("done");
		expect(result?.text).toContain("worker says hi");
	});

	it("agent_stop stops a running worker by id and the director gets one abort report", async () => {
		const gate = Promise.withResolvers<void>();
		const { director, harness: h } = await setup(async () => {
			await gate.promise;
			return fauxAssistantMessage("too late");
		});
		await say(director, "go");
		await until(async () => ((await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1?.state === "running" ? true : undefined));
		await say(director, "stop");
		const [result] = await toolResults(director, "agent_stop");
		expect(result).toMatchObject({ isError: false });
		expect(result?.text).toContain("stopping");
		gate.resolve();
		const w = await until(async () => {
			const rec = (await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1;
			return rec?.finishedAt !== undefined ? rec : undefined;
		});
		expect(w).toMatchObject({ state: "aborted", reason: "stopped" });
		const texts = await until(async () => {
			const t = await directorTexts(h, director);
			return t.some((x) => x.startsWith("U:[worker h1 finished: aborted")) ? t : undefined;
		});
		expect(texts.filter((x) => x.startsWith("U:[worker"))).toHaveLength(1);
	});

	it("agent_stop errors on an unknown id and when given neither id nor all", async () => {
		const { director } = await setup(() => fauxAssistantMessage("unused"));
		await say(director, "stop-unknown");
		await say(director, "stop-neither");
		const results = await toolResults(director, "agent_stop");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ isError: true });
		expect(results[0]?.text).toContain("No worker nope");
		expect(results[1]).toMatchObject({ isError: true });
		expect(results[1]?.text).toContain("exactly one of `id` or `all`");
	});

	it("agent_send steers a live worker and only the steered answer is reported", async () => {
		const gate = Promise.withResolvers<void>();
		const { director, harness: h } = await setup(async (msgs) => {
			if (msgs.some((m) => m.role === "user" && text(m).includes("FOLLOW-UP"))) return fauxAssistantMessage("steered answer");
			await gate.promise;
			return fauxAssistantMessage("first answer");
		});
		await say(director, "go");
		await until(async () => {
			const w = (await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1;
			return w?.state === "running" && w.submissionId !== undefined ? w : undefined;
		});
		await say(director, "steer");
		const [sent] = await toolResults(director, "agent_send");
		expect(sent).toMatchObject({ isError: false });
		expect(sent?.text).toContain("sent");
		gate.resolve();

		const done = await until(async () => {
			const w = (await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1;
			return w?.state === "done" ? w : undefined;
		});
		expect(done.answer).toBe("steered answer");
		const texts = await until(async () => {
			const t = await directorTexts(h, director);
			return t.some((x) => x.startsWith("A:director got")) ? t : undefined;
		});
		expect(texts.filter((x) => x.startsWith("U:[worker"))).toEqual(["U:[worker h1 finished: done]\nsteered answer"]);
	});

	it("agent_send refuses a finished worker and an unknown id", async () => {
		const { director, harness: h } = await setup(() => fauxAssistantMessage(fauxText("worker says hi")));
		await say(director, "go");
		await until(async () => ((await h.snapshot(WorkersDoc, director.id, ctx))?.workers.w1?.state === "done" ? true : undefined));
		await say(director, "steer-late");
		await say(director, "steer-unknown");
		const results = await toolResults(director, "agent_send");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ isError: true });
		expect(results[0]?.text).toContain("already done");
		expect(results[1]).toMatchObject({ isError: true });
		expect(results[1]?.text).toContain("No worker nope");
	});
});
