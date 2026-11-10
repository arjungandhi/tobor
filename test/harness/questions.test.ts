import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeEventType } from "../../src/api/types.js";
import { validateConfig } from "../../src/config/load.js";
import { QuestionsDoc, SessionDoc, type WorkerIdentity } from "../../src/docs.js";
import { EventBus, type EventOf } from "../../src/events.js";
import type { Notification } from "../../src/host.js";
import { QuestionService } from "../../src/server/harness/questions/service.js";
import { questionsModule } from "../../src/server/harness/questions/tool.js";
import { composeExtension } from "../../src/tools/registry.js";
import { entryText, fauxModels } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;
const TIMEOUT = 60_000;

const open: Harness[] = [];

async function setup(notifyOn = true) {
	const { models, script } = fauxModels();
	const events = new EventBus();
	const config = validateConfig(undefined, "/nonexistent").config;
	config.defaults.approval_timeout = TIMEOUT;
	let clock = 1_000_000;
	const timers = new Set<{ at: number; fn: () => void }>();
	const sent: Notification[] = [];
	const questions = new QuestionService({
		events,
		config: () => config,
		notify: () => ({ enabled: () => notifyOn, send: async (n) => void sent.push(n) }),
		now: () => clock,
		setTimer: (fn, ms) => {
			const t = { at: clock + ms, fn };
			timers.add(t);
			return () => timers.delete(t);
		},
	});
	const registry = createRegistry();
	registry.install(composeExtension("tobor", [questionsModule(() => questions)]));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	questions.attach(harness);
	const s = {
		harness,
		questions,
		events,
		script,
		sent,
		timers,
		advance(ms: number) {
			clock += ms;
			for (const t of [...timers]) {
				if (t.at <= clock) {
					timers.delete(t);
					t.fn();
				}
			}
		},
		async conversation(worker?: WorkerIdentity) {
			return harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "m" } },
					init: async (tx, id) => {
						const doc = await tx.doc(SessionDoc, id);
						doc.title = "t";
						doc.createdAt = 1;
						if (worker) doc.worker = worker;
					},
				},
				ctx,
			);
		},
		next<K extends NodeEventType>(type: K): Promise<EventOf<K>> {
			const { promise, resolve } = Promise.withResolvers<EventOf<K>>();
			const off = events.on(type, (e) => {
				off();
				resolve(e);
			});
			return promise;
		},
	};
	open.push(harness);
	return s;
}

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(ctx);
});

const call = (callId: string, extra: { options?: string[] } = {}) => ({ callId, question: "Which database?", ...extra });

describe("QuestionService.ask", () => {
	it("blocks until the operator answers; a second answer is 409", async () => {
		const s = await setup();
		const c = await s.conversation();
		const asked = s.next("question.asked");
		const ask = s.questions.ask(c.id, call("q1", { options: ["sqlite", "postgres"] }), ctx);
		const { question } = await asked;
		expect(question).toMatchObject({ conversationId: c.id, sessionId: c.id, callId: "q1", question: "Which database?", options: ["sqlite", "postgres"] });
		expect(question.expiresAt - question.createdAt).toBe(TIMEOUT);
		expect(await s.questions.pending()).toEqual([question]);
		expect(await s.questions.find("q1")).toEqual(question);
		const answered = s.next("question.answered");
		await s.questions.answer(c.id, "q1", "postgres");
		expect(await ask).toEqual({ kind: "answered", text: "postgres" });
		expect(await answered).toMatchObject({ callId: "q1", outcome: "answered" });
		expect(await s.questions.pending()).toEqual([]);
		await expect(s.questions.answer(c.id, "q1", "x")).rejects.toMatchObject({ status: 409 });
		await expect(s.questions.answer(c.id, "nope", "x")).rejects.toMatchObject({ status: 404 });
		// a rerun of the same call finds the stored answer without asking again
		const seen: NodeEventType[] = [];
		s.events.onAny((e) => seen.push(e.type));
		expect(await s.questions.ask(c.id, call("q1"), ctx)).toEqual({ kind: "answered", text: "postgres" });
		expect(seen).toEqual([]);
	});

	it("notifies with the question and options, no actions", async () => {
		const s = await setup();
		const c = await s.conversation();
		const asked = s.next("question.asked");
		const ask = s.questions.ask(c.id, { callId: "q1", question: "x".repeat(100), options: ["a", "b"] }, ctx);
		await asked;
		await s.questions.answer(c.id, "q1", "a");
		await ask;
		expect(s.sent).toHaveLength(1);
		const [n] = s.sent;
		expect(n).toMatchObject({ event: "question", sessionId: c.id });
		expect(n?.title).toBe(`Question: ${"x".repeat(59)}…`);
		expect(n?.message).toContain("x".repeat(100));
		expect(n?.message).toContain("- a\n- b");
		expect(n?.actions).toBeUndefined();
	});

	it("does not notify when the notifier has the event disabled", async () => {
		const s = await setup(false);
		const c = await s.conversation();
		const asked = s.next("question.asked");
		const ask = s.questions.ask(c.id, call("q1"), ctx);
		await asked;
		await s.questions.answer(c.id, "q1", "ok");
		await ask;
		expect(s.sent).toEqual([]);
	});

	it("gives up with reason timeout once approval_timeout passes", async () => {
		const s = await setup();
		const c = await s.conversation();
		const asked = s.next("question.asked");
		const ask = s.questions.ask(c.id, call("q1"), ctx);
		await asked;
		const answered = s.next("question.answered");
		s.advance(TIMEOUT - 1);
		s.advance(1);
		expect(await ask).toEqual({ kind: "timeout" });
		expect(await answered).toMatchObject({ callId: "q1", outcome: "timeout" });
		const doc = await s.harness.snapshot(QuestionsDoc, c.id, ctx);
		expect(doc?.questions.q1?.answer).toMatchObject({ reason: "timeout" });
		expect(await s.questions.pending()).toEqual([]);
		await expect(s.questions.answer(c.id, "q1", "late")).rejects.toMatchObject({ status: 409 });
	});

	it("cancellation unblocks the wait and drops the pending record", async () => {
		const s = await setup();
		const c = await s.conversation();
		const { context, cancel } = withCancel(ctx);
		const asked = s.next("question.asked");
		const ask = s.questions.ask(c.id, call("q1"), context);
		await asked;
		const answered = s.next("question.answered");
		cancel();
		expect(await ask).toEqual({ kind: "cancelled" });
		expect(await answered).toMatchObject({ callId: "q1", outcome: "cancelled" });
		expect(await s.harness.snapshot(QuestionsDoc, c.id, ctx)).toMatchObject({ questions: {} });
		expect(await s.questions.pending()).toEqual([]);
	});

	it("releases its timer and abort listener when watching the doc fails", async () => {
		const s = await setup();
		const c = await s.conversation();
		const { context } = withCancel(ctx);
		const removed = vi.spyOn(context.abortSignal!, "removeEventListener");
		vi.spyOn(s.harness, "watchDoc").mockRejectedValueOnce(new Error("watch failed"));
		await expect(s.questions.ask(c.id, call("q1"), context)).rejects.toThrow("watch failed");
		expect(s.timers.size).toBe(0);
		expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("a rerun re-attaches to a persisted pending record without asking again", async () => {
		const s = await setup();
		const c = await s.conversation();
		await s.harness.commit(async (tx) => {
			const doc = await tx.doc(QuestionsDoc, c.id);
			doc.questions.q1 = { callId: "q1", conversationId: c.id, question: "Which database?", createdAt: 5, expiresAt: 5 + TIMEOUT };
		}, ctx);
		const seen: NodeEventType[] = [];
		s.events.onAny((e) => seen.push(e.type));
		const ask = s.questions.ask(c.id, call("q1"), ctx);
		expect((await s.questions.pending()).map((p) => p.createdAt)).toEqual([5]);
		await s.questions.answer(c.id, "q1", "sqlite");
		expect(await ask).toEqual({ kind: "answered", text: "sqlite" });
		expect(seen).toEqual(["question.answered"]);
	});

	it("attributes worker questions to the director session", async () => {
		const s = await setup();
		const director = await s.conversation();
		const worker = await s.conversation({ id: "w1", name: "scout-a", agent: "scout", parentId: director.id });
		const asked = s.next("question.asked");
		const ask = s.questions.ask(worker.id, call("q9"), ctx);
		const { question } = await asked;
		expect(question).toMatchObject({ conversationId: worker.id, sessionId: director.id, worker: "scout-a" });
		expect(await s.questions.pendingFor(director.id)).toHaveLength(1);
		await s.questions.answer(worker.id, "q9", "ok");
		await ask;
	});
});

describe("ask_user in a run", () => {
	async function runOnce(finish: (s: Awaited<ReturnType<typeof setup>>, id: number) => void) {
		const s = await setup();
		s.script([
			fauxAssistantMessage(fauxToolCall("ask_user", { question: "Which database?", options: ["sqlite"] }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const c = await s.conversation();
		const asked = s.next("question.asked");
		const submission = await c.submit({ type: "input", content: "build it" }, ctx);
		const { question } = await asked;
		expect(question).toMatchObject({ callId: "call-1", question: "Which database?", options: ["sqlite"] });
		finish(s, c.id);
		expect(await submission.wait(ctx)).toMatchObject({ status: "done" });
		const page = await c.entries({ order: "ascending" }, 50, undefined, ctx);
		return entryText(page.items.find((e) => e.kind === "pi.tool-result"));
	}

	it("returns the operator's reply as the tool result", async () => {
		const text = await runOnce((s, id) => void s.questions.answer(id, "call-1", "use sqlite"));
		expect(text).toContain("User replied:\nuse sqlite");
	});

	it("tells the model to proceed on its own judgment after a timeout", async () => {
		const text = await runOnce((s) => s.advance(TIMEOUT));
		expect(text).toContain("No answer arrived");
		expect(text).toContain("assumptions");
	});
});
