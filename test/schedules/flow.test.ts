import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type ConversationId, createRegistry, Harness, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeEvent } from "../../src/api/types.js";
import { validateConfig } from "../../src/config/load.js";
import { SessionDoc, SessionsDoc } from "../../src/docs.js";
import { EventBus } from "../../src/events.js";
import type { Notification } from "../../src/host.js";
import { type ScheduleHost, Schedules } from "../../src/server/harness/schedules/service.js";
import type { QuestionService } from "../../src/host.js";
import { questionsModule } from "../../src/server/harness/questions/tool.js";
import { schedulesModule } from "../../src/server/harness/schedules/tools.js";
import { composeExtension } from "../../src/tools/registry.js";

const ctx = BACKGROUND_CONTEXT;

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(ctx);
	harness = undefined;
});

async function until<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await probe();
		if (value !== undefined) return value;
		// Schedule tasks advance on the Harness scheduler and real sleeps; poll the committed condition.
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("timed out");
}

async function setup() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tobor-schedules-")));
	const faux = fauxProvider();
	const prompts: string[] = [];
	faux.setResponses(
		Array.from({ length: 10 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
			const last = context.messages.at(-1);
			prompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
			return fauxAssistantMessage("scheduled reply");
		}),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const events: NodeEvent[] = [];
	const notes: Notification[] = [];
	const bus = new EventBus();
	bus.onAny((e) => events.push(e));
	let host: ScheduleHost | undefined;
	const schedules = new Schedules(() => host as ScheduleHost);
	const registry = createRegistry();
	registry.install(composeExtension("tobor", [schedulesModule(schedules.task, () => schedules), questionsModule(() => ({}) as QuestionService)]));
	harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const system = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	const config = validateConfig({ defaults: { model: "faux/faux-1" } }, cwd).config;
	host = {
		harness,
		ctx,
		config,
		events: bus,
		systemConversationId: system.id,
		notify: { enabled: () => true, send: async (n) => void notes.push(n) },
		sessions: { resolveCwd: async (c) => c },
	};
	harness.resume();
	return { schedules, events, notes, prompts, cwd, system, h: harness };
}

async function liveScheduleTasks(h: Harness): Promise<number[]> {
	return (await h.inspect(ctx)).tasks.filter((t) => t.record.kind === "tobor.schedule").map((t) => t.record.id as number);
}

describe("schedules", () => {
	it("fires a one-shot into a new indexed session and records the settled run", async () => {
		const { schedules, events, notes, prompts, cwd, system, h } = await setup();
		const at = new Date(Date.now() + 150).toISOString();
		const { id } = await schedules.create({ name: "ping", at, tz: "UTC", cwd, prompt: "say hi" });
		expect((await schedules.get(id))?.nextFireAt).toBe(Date.parse(at));

		const run = await until(async () => {
			const r = (await schedules.get(id))?.runs[0];
			return r?.status === "done" ? r : undefined;
		});
		expect(run.fireAt).toBe(Date.parse(at));
		expect(prompts[0]).toBe(`[scheduled run, fired ${at}]\nsay hi`);

		const conversationId = run.conversationId as ConversationId;
		const index = await h.snapshot(SessionsDoc, system.id, ctx);
		expect(index?.sessions[String(conversationId)]).toMatchObject({ kind: "schedule", scheduleId: id, cwd });
		expect(await h.snapshot(SessionDoc, conversationId, ctx)).toMatchObject({ approval_mode: "ask", mode: "solo", cwd });

		expect((await schedules.get(id))?.nextFireAt).toBeUndefined();
		expect(await until(async () => ((await liveScheduleTasks(h)).length === 0 ? true : undefined))).toBe(true);
		expect(events.filter((e) => e.type === "schedule.fired").map((e) => e.type === "schedule.fired" && e.run.status)).toEqual([
			"running",
			"done",
		]);
		expect(notes.map((n) => n.title)).toEqual(["schedule ping: done"]);
	});

	it("withholds ask_user from a scheduled run, since nobody is there to answer", async () => {
		const { schedules, cwd, h } = await setup();
		const at = new Date(Date.now() + 150).toISOString();
		const { id } = await schedules.create({ name: "quiet", at, tz: "UTC", cwd, prompt: "x" });
		const run = await until(async () => {
			const r = (await schedules.get(id))?.runs[0];
			return r?.status === "done" ? r : undefined;
		});
		const scheduled = (await h.conversation(run.conversationId as ConversationId, ctx))!;
		expect((await scheduled.agent(ctx)).tools.map((t) => t.name)).not.toContain("ask_user");
		// an ordinary conversation still gets it
		const ordinary = await h.createConversation({ ownership: { kind: "ownerless" } }, ctx);
		expect((await ordinary.agent(ctx)).tools.map((t) => t.name)).toContain("ask_user");
	});

	it("skips a one-shot missed by more than the grace", async () => {
		const { schedules, notes, prompts, cwd } = await setup();
		const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
		const { id } = await schedules.create({ name: "late", at, tz: "UTC", cwd, prompt: "x" });
		const run = await until(async () => (await schedules.get(id))?.runs[0]);
		expect(run.status).toBe("skipped_misfire");
		expect(run.notice).toMatch(/^missed by 180 min/);
		expect(prompts).toEqual([]);
		expect(notes[0]?.title).toBe("schedule late: skipped");
	});

	it("creates, retimes and deletes the task with the definition", async () => {
		const { schedules, cwd, h } = await setup();
		const { id } = await schedules.create({ name: "daily", cron: "0 9 * * *", tz: "Europe/Berlin", cwd, prompt: "x" });
		const [first] = await liveScheduleTasks(h);
		expect(first).toBeTypeOf("number");

		await schedules.update(id, { prompt: "y" });
		expect(await liveScheduleTasks(h)).toEqual([first]);

		await schedules.update(id, { cron: "0 10 * * *" });
		const retimed = await until(async () => {
			const live = await liveScheduleTasks(h);
			return live.length === 1 && live[0] !== first ? live : undefined;
		});
		expect(retimed).toHaveLength(1);

		await schedules.update(id, { enabled: false });
		await until(async () => ((await liveScheduleTasks(h)).length === 0 ? true : undefined));
		expect((await schedules.get(id))?.nextFireAt).toBeUndefined();

		await schedules.update(id, { enabled: true });
		await schedules.delete(id);
		await until(async () => ((await liveScheduleTasks(h)).length === 0 ? true : undefined));
		expect(await schedules.list()).toEqual([]);
		await expect(schedules.delete(id)).rejects.toMatchObject({ status: 404 });
	});

	it("reconcile recreates a missing task and keeps the live one", async () => {
		const { schedules, cwd, h } = await setup();
		await schedules.create({ name: "a", cron: "0 9 * * *", tz: "UTC", cwd, prompt: "x" });
		const [original] = await liveScheduleTasks(h);
		await h.abortTask(original as TaskId, ctx);
		await until(async () => ((await liveScheduleTasks(h)).length === 0 ? true : undefined));
		await schedules.reconcile();
		const [recreated] = await liveScheduleTasks(h);
		expect(recreated).toBeTypeOf("number");
		expect(recreated).not.toBe(original);
		await schedules.reconcile();
		expect(await liveScheduleTasks(h)).toEqual([recreated]);
	});

	it("refuses agent-created auto schedules", async () => {
		const { schedules, cwd } = await setup();
		await expect(
			schedules.create({ name: "x", cron: "0 9 * * *", cwd, prompt: "x", approval_mode: "auto" }, { fromAgent: true }),
		).rejects.toMatchObject({ status: 422, code: "invalid" });
	});
});
