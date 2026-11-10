import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, type TaskId, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { SessionId, UsageSummary, WorkerSummary } from "../../../api/types.js";
import { type WorkerRecord, WorkersDoc } from "../../../docs.js";
import { HostError, type Host, type WorkerService } from "../../../host.js";
import { assistantText } from "./holder.js";

/** Sum every bucket of a conversation's `pi.usage`. */
export function sumUsage(state: Readonly<UsageState> | undefined): UsageSummary {
	const total: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const bucket of [state?.models ?? {}, state?.tools ?? {}]) {
		for (const u of Object.values(bucket)) {
			total.input += u.input;
			total.output += u.output;
			total.cacheRead += u.cacheRead;
			total.cacheWrite += u.cacheWrite;
			total.totalTokens += u.totalTokens;
			total.cost += u.cost.total;
		}
	}
	return total;
}

/** API summary of one worker record, joined with its conversation's usage and latest assistant text. */
export async function summarize(harness: Harness, record: Readonly<WorkerRecord>, context: Context): Promise<WorkerSummary> {
	let usage = sumUsage(undefined);
	let lastText = record.answer ?? "";
	if (record.conversationId !== undefined) {
		const id = record.conversationId as ConversationId;
		usage = sumUsage(await harness.snapshot(UsageDoc, id, context));
		if (!lastText) {
			const page = await (await harness.conversation(id, context))?.entries({ order: "descending" }, 20, undefined, context);
			const latest = page?.items.find((e) => e.kind === "pi.assistant" && assistantText(e) !== "");
			lastText = latest ? assistantText(latest) : "";
		}
	}
	const lines = lastText.split("\n").filter((l) => l.trim() !== "");
	const summary: WorkerSummary = {
		id: record.id,
		name: record.name,
		agent: record.agent,
		state: record.state,
		usage,
		lastText: record.answer ?? lines.at(-1) ?? "",
		createdAt: record.createdAt,
	};
	if (record.conversationId !== undefined) summary.conversationId = record.conversationId;
	if (record.finishedAt !== undefined) summary.finishedAt = record.finishedAt;
	return summary;
}

/** One worker summary by id, read fresh (for `worker.state` events). */
export async function workerSummary(
	harness: Harness,
	directorId: number,
	workerId: string,
	context?: Context,
): Promise<WorkerSummary | undefined> {
	const ctx = context ?? BACKGROUND_CONTEXT;
	const doc = await harness.snapshot(WorkersDoc, directorId as ConversationId, ctx);
	const record = doc?.workers[workerId];
	return record ? summarize(harness, record, ctx) : undefined;
}

/** `WorkerService` over each director's `tobor.workers` doc. */
export class Workers implements WorkerService {
	constructor(private readonly host: () => Pick<Host, "harness" | "ctx">) {}

	async list(sessionId: SessionId): Promise<WorkerSummary[]> {
		const { harness, ctx } = this.host();
		const records = await this.records(sessionId);
		const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }));
		return Promise.all(sorted.map((r) => summarize(harness, r, ctx)));
	}

	async get(sessionId: SessionId, workerId: string): Promise<WorkerSummary | undefined> {
		const { harness, ctx } = this.host();
		const record = (await this.records(sessionId)).find((r) => r.id === workerId);
		return record ? summarize(harness, record, ctx) : undefined;
	}

	async stop(sessionId: SessionId, workerId: string): Promise<void> {
		const record = (await this.records(sessionId)).find((r) => r.id === workerId);
		if (!record) throw new HostError(404, "not_found", `no worker ${workerId} in session ${sessionId}`);
		const { harness, ctx } = this.host();
		await harness.abortTask(record.holderTaskId as TaskId, ctx);
	}

	async stopAll(sessionId: SessionId): Promise<void> {
		const { harness, ctx } = this.host();
		const live = (await this.records(sessionId)).filter((r) => r.finishedAt === undefined);
		await Promise.all(live.map((r) => harness.abortTask(r.holderTaskId as TaskId, ctx)));
	}

	async live(sessionId: SessionId): Promise<number> {
		return (await this.records(sessionId)).filter((r) => r.finishedAt === undefined).length;
	}

	private async records(sessionId: SessionId): Promise<readonly Readonly<WorkerRecord>[]> {
		const { harness, ctx } = this.host();
		const doc = await harness.snapshot(WorkersDoc, sessionId as ConversationId, ctx);
		return Object.values(doc?.workers ?? {});
	}
}
