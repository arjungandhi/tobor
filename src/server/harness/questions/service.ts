import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type ConversationId, type Cursor, type Harness } from "@earendil-works/pi-durable";
import type { PendingQuestion, SessionId } from "../../../api/types.js";
import type { Config } from "../../../config/schema.js";
import { type QuestionAnswer, type QuestionRecord, QuestionsDoc, type QuestionsDocValue, SessionDoc } from "../../../docs.js";
import type { EventBus } from "../../../events.js";
import { type AskResult, HostError, type Notifier, type QuestionService as QuestionServiceContract } from "../../../host.js";

/** Dependencies of `QuestionService`; getters are read at each use. */
export type QuestionServiceOptions = {
	events: EventBus;
	config: () => Config;
	notify?: () => Notifier | undefined;
	/** Clock (ms). Default `Date.now`. */
	now?: () => number;
	/** Arms a timeout; returns its cancel. Default `setTimeout`. */
	setTimer?: (fn: () => void, ms: number) => () => void;
};

type Waited = { kind: "answered"; record: QuestionRecord } | { kind: "timeout" } | { kind: "cancelled" };

/** `ask_user` state and operator answers over each conversation's `tobor.questions` doc. */
export class QuestionService implements QuestionServiceContract {
	private harness: Harness | undefined;
	/** Conversations that may hold pending records; built by one full scan, then kept current. */
	private known: Set<number> | undefined;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;

	constructor(private readonly options: QuestionServiceOptions) {
		this.now = options.now ?? Date.now;
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				return () => clearTimeout(t);
			});
	}

	/** Bind the opened Harness (the tool module is registered before it exists). */
	attach(harness: Harness): void {
		this.harness = harness;
	}

	async ask(
		conversationId: SessionId,
		call: { callId: string; question: string; options?: string[] },
		ctx: Context,
	): Promise<AskResult> {
		const harness = this.requireHarness();
		const id = conversationId as ConversationId;
		const session = await harness.snapshot(SessionDoc, id, ctx);
		const timeoutMs = this.options.config().defaults.approval_timeout;
		const step = await harness.commit(async (tx) => {
			const doc = await tx.doc(QuestionsDoc, id);
			const existing = doc.questions[call.callId];
			if (existing?.answer) return { kind: "answered" as const, record: plain(existing) };
			if (existing) return { kind: "pending" as const, record: plain(existing), created: false };
			const createdAt = this.now();
			const record: QuestionRecord = {
				callId: call.callId,
				conversationId,
				question: call.question,
				...(call.options?.length ? { options: [...call.options] } : {}),
				createdAt,
				expiresAt: createdAt + timeoutMs,
				...(session?.worker ? { worker: session.worker.name } : {}),
			};
			doc.questions[call.callId] = record;
			return { kind: "pending" as const, record, created: true };
		}, ctx);
		if (step.kind === "answered") return toResult(step.record.answer);

		this.known?.add(conversationId);
		const pending = toPending(step.record, session?.worker?.parentId);
		if (step.created) {
			this.options.events.emit({ type: "question.asked", question: pending });
			void this.sendNotification(pending, session?.title);
		}

		const waited = await this.waitForAnswer(harness, id, call.callId, step.record.expiresAt, ctx);
		if (waited.kind === "answered") return toResult(waited.record.answer);
		if (waited.kind === "timeout") {
			const answer = await harness.commit(async (tx): Promise<QuestionAnswer> => {
				const doc = await tx.doc(QuestionsDoc, id);
				const existing = doc.questions[call.callId];
				if (existing?.answer) return plain(existing.answer);
				const timedOut: QuestionAnswer = { text: "", decidedAt: this.now(), reason: "timeout" };
				if (existing) existing.answer = timedOut;
				return timedOut;
			}, BACKGROUND_CONTEXT);
			if (answer.reason === "timeout") {
				this.options.events.emit({ type: "question.answered", conversationId, callId: call.callId, outcome: "timeout" });
			}
			return toResult(answer);
		}
		await harness
			.commit(async (tx) => {
				const doc = await tx.doc(QuestionsDoc, id);
				if (!doc.questions[call.callId]?.answer) delete doc.questions[call.callId];
			}, BACKGROUND_CONTEXT)
			.catch(() => {});
		this.options.events.emit({ type: "question.answered", conversationId, callId: call.callId, outcome: "cancelled" });
		return { kind: "cancelled" };
	}

	async answer(conversationId: SessionId, callId: string, text: string): Promise<void> {
		const harness = this.requireHarness();
		const id = conversationId as ConversationId;
		const existing = await harness.snapshot(QuestionsDoc, id, BACKGROUND_CONTEXT);
		if (!existing?.questions[callId]) {
			throw new HostError(404, "not_found", `no question ${callId} in conversation ${conversationId}`);
		}
		await harness.commit(async (tx) => {
			const doc = await tx.doc(QuestionsDoc, id);
			const record = doc.questions[callId];
			if (!record) throw new HostError(404, "not_found", `no question ${callId} in conversation ${conversationId}`);
			if (record.answer) throw new HostError(409, "conflict", `question ${callId} was already answered`);
			record.answer = { text, decidedAt: this.now(), reason: "operator" };
		}, BACKGROUND_CONTEXT);
		this.options.events.emit({ type: "question.answered", conversationId, callId, outcome: "answered" });
	}

	async pending(): Promise<PendingQuestion[]> {
		const harness = this.requireHarness();
		const known = await this.knownConversations(harness);
		const out: PendingQuestion[] = [];
		for (const conversationId of [...known]) {
			const items = await this.pendingOf(harness, conversationId);
			if (items.length === 0) known.delete(conversationId);
			out.push(...items);
		}
		return out.sort((a, b) => a.createdAt - b.createdAt);
	}

	async pendingFor(sessionId: SessionId): Promise<PendingQuestion[]> {
		return (await this.pending()).filter((p) => p.sessionId === sessionId);
	}

	async find(callId: string): Promise<PendingQuestion | undefined> {
		return (await this.pending()).find((p) => p.callId === callId);
	}

	private async pendingOf(harness: Harness, conversationId: number): Promise<PendingQuestion[]> {
		const id = conversationId as ConversationId;
		const doc = await harness.snapshot(QuestionsDoc, id, BACKGROUND_CONTEXT);
		const records = Object.values(doc?.questions ?? {}).filter((r) => !r.answer);
		if (records.length === 0) return [];
		const session = await harness.snapshot(SessionDoc, id, BACKGROUND_CONTEXT);
		return records.map((r) => toPending(r, session?.worker?.parentId));
	}

	private async knownConversations(harness: Harness): Promise<Set<number>> {
		if (this.known) return this.known;
		const ids = new Set<number>();
		let cursor: Cursor | undefined;
		do {
			const page = await harness.commit((tx) => tx.scanConversations({}, 500, cursor), BACKGROUND_CONTEXT);
			for (const c of page.items) ids.add(c.id);
			cursor = page.next;
		} while (cursor);
		this.known ??= ids;
		return this.known;
	}

	/** Resolve on an answer in the doc, the expiry, or `ctx` cancellation, whichever comes first. */
	private async waitForAnswer(
		harness: Harness,
		id: ConversationId,
		callId: string,
		expiresAt: number,
		ctx: Context,
	): Promise<Waited> {
		const done = Promise.withResolvers<Waited>();
		const check = (value: Readonly<QuestionsDocValue> | undefined) => {
			const record = value?.questions[callId];
			if (record?.answer) done.resolve({ kind: "answered", record: plain(record) });
		};
		const signal = ctx.abortSignal;
		const onAbort = () => done.resolve({ kind: "cancelled" });
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const cancelTimer = this.setTimer(() => done.resolve({ kind: "timeout" }), Math.max(0, expiresAt - this.now()));
		const watch = await harness.watchDoc(QuestionsDoc, id, BACKGROUND_CONTEXT);
		if (watch) {
			check(watch.value);
			watch.start(async (call) => {
				if (call.kind === "value") check(call.value);
			});
		}
		try {
			return await done.promise;
		} finally {
			cancelTimer();
			signal?.removeEventListener("abort", onAbort);
			await watch?.stop();
		}
	}

	private async sendNotification(question: PendingQuestion, title: string | undefined): Promise<void> {
		const notifier = this.options.notify?.();
		if (!notifier?.enabled("question")) return;
		const base = this.options.config().public_url.replace(/\/$/, "");
		const first = question.question.replace(/\s+/g, " ").trim();
		const lines = [
			`${title || `session ${question.sessionId}`}${question.worker ? ` (worker ${question.worker})` : ""} asks:`,
			question.question,
			...(question.options?.length ? ["", "Options:", ...question.options.map((o) => `- ${o}`)] : []),
		];
		await notifier.send({
			event: "question",
			title: `Question: ${first.length > 60 ? `${first.slice(0, 59)}…` : first}`,
			message: lines.join("\n"),
			sessionId: question.sessionId,
			url: base,
		});
	}

	private requireHarness(): Harness {
		if (!this.harness) throw new Error("QuestionService used before attach(harness)");
		return this.harness;
	}
}

/** A detached copy: values read inside a commit are overlays that settle when it ends. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function toResult(answer: QuestionAnswer | undefined): AskResult {
	if (answer?.reason === "operator") return { kind: "answered", text: answer.text };
	return { kind: answer?.reason === "cancelled" ? "cancelled" : "timeout" };
}

function toPending(r: QuestionRecord, parentId: number | undefined): PendingQuestion {
	return {
		conversationId: r.conversationId,
		sessionId: parentId ?? r.conversationId,
		...(r.worker ? { worker: r.worker } : {}),
		callId: r.callId,
		question: r.question,
		...(r.options ? { options: [...r.options] } : {}),
		createdAt: r.createdAt,
		expiresAt: r.expiresAt,
	};
}
