import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type ConversationId, type Cursor, type Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ApprovalDecision, ApprovalOutcome, PendingApproval, SessionId } from "../../api/types.js";
import type { Config } from "../../config/schema.js";
import {
	type ApprovalDecisionRecord,
	type ApprovalPendingRecord,
	ApprovalsDoc,
	type ApprovalsDocValue,
	SessionDoc,
} from "../../docs.js";
import type { EventBus } from "../../events.js";
import {
	type ApprovalService as ApprovalServiceContract,
	type GateResult,
	HostError,
	type Notifier,
} from "../../host.js";
import type { ToolModule } from "../../tools/registry.js";

/** Tools gated in `ask` mode regardless of arguments. */
export const GATED_TOOLS: readonly string[] = ["bash", "write", "edit", "artifact_export", "schedule_create"];

/** Decides whether one call of a tool needs approval (e.g. `task` spawning an `auto` worker). */
export type GatePredicate = (args: unknown, conversationId: SessionId) => boolean | Promise<boolean>;

/** Dependencies of `ApprovalService`; getters are read at each use. */
export type ApprovalServiceOptions = {
	events: EventBus;
	config: () => Config;
	notify?: () => Notifier | undefined;
	/** MCP policy (`McpService.needsApproval`); absent means every `mcp__*` tool asks. */
	mcpNeedsApproval?: () => ((toolName: string) => boolean) | undefined;
	/** Per-tool predicates; they take precedence over `GATED_TOOLS`. */
	gates?: Record<string, GatePredicate>;
	/** Clock (ms). Default `Date.now`. */
	now?: () => number;
	/** Arms a timeout; returns its cancel. Default `setTimeout`. */
	setTimer?: (fn: () => void, ms: number) => () => void;
};

type DenyOutcome = Exclude<ApprovalOutcome, "approve" | "approve_session">;

const BLOCK: Record<DenyOutcome, string> = {
	deny: "Denied by operator",
	timeout: "Approval timed out",
	cancelled: "Cancelled while awaiting approval",
};

type Waited = { kind: "decided"; record: ApprovalDecisionRecord } | { kind: "timeout" } | { kind: "cancelled" };

/** Approval gate and operator decisions over each conversation's `tobor.approvals` doc. */
export class ApprovalService implements ApprovalServiceContract {
	private harness: Harness | undefined;
	private readonly gates = new Map<string, GatePredicate>();
	/** Conversations that may hold pending records; built by one full scan, then kept current. */
	private known: Set<number> | undefined;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;

	constructor(private readonly options: ApprovalServiceOptions) {
		for (const [tool, predicate] of Object.entries(options.gates ?? {})) this.gates.set(tool, predicate);
		this.now = options.now ?? Date.now;
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				return () => clearTimeout(t);
			});
	}

	/** Bind the opened Harness (the hook is registered before it exists). */
	attach(harness: Harness): void {
		this.harness = harness;
	}

	/** Register or replace the predicate for one tool. */
	setGate(tool: string, predicate: GatePredicate): void {
		this.gates.set(tool, predicate);
	}

	/** The `beforeTool` hook and the doc this service owns. */
	module(): ToolModule {
		return {
			tools: [],
			docs: [ApprovalsDoc],
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, ctx) => {
						const result = await this.gate(api.conversationId, { callId: call.id, tool: call.name, args: call.arguments }, ctx);
						return result.proceed ? undefined : { block: result.block };
					},
				}),
			],
		};
	}

	/** Whether this call needs approval in `ask` mode. */
	async needsApproval(tool: string, args: unknown, conversationId: SessionId): Promise<boolean> {
		const predicate = this.gates.get(tool);
		if (predicate) return predicate(args, conversationId);
		if (tool.startsWith("mcp__")) return this.options.mcpNeedsApproval?.()?.(tool) ?? true;
		return GATED_TOOLS.includes(tool);
	}

	async gate(
		conversationId: SessionId,
		call: { callId: string; tool: string; args: unknown },
		ctx: Context,
	): Promise<GateResult> {
		const harness = this.requireHarness();
		const id = conversationId as ConversationId;
		const session = await harness.snapshot(SessionDoc, id, ctx);
		const mode = session?.approval_mode ?? this.options.config().defaults.approval_mode;
		if (mode === "auto" || !(await this.needsApproval(call.tool, call.args, conversationId))) return { proceed: true };

		const timeoutMs = this.options.config().defaults.approval_timeout;
		const step = await harness.commit(async (tx) => {
			const doc = await tx.doc(ApprovalsDoc, id);
			const decided = doc.decisions[call.callId];
			if (decided) return { kind: "decided" as const, record: { ...decided } };
			if (doc.session[call.tool]) return { kind: "granted" as const };
			const existing = doc.pending[call.callId];
			if (existing) return { kind: "pending" as const, record: { ...existing }, created: false };
			const createdAt = this.now();
			const record: ApprovalPendingRecord = {
				callId: call.callId,
				tool: call.tool,
				args: toJson(call.args),
				createdAt,
				expiresAt: createdAt + timeoutMs,
				...(session?.worker ? { worker: session.worker.name } : {}),
			};
			doc.pending[call.callId] = record;
			return { kind: "pending" as const, record, created: true };
		}, ctx);
		if (step.kind === "granted") return { proceed: true };
		if (step.kind === "decided") return toGate(step.record.decision, step.record.reason);

		this.known?.add(conversationId);
		const pending = toPending(conversationId, step.record, session?.worker?.parentId);
		if (step.created) {
			this.options.events.emit({ type: "approval.requested", approval: pending });
			void this.sendNotification(pending, session?.title);
		}

		const waited = await this.waitForDecision(harness, id, call.callId, step.record.expiresAt, ctx);
		if (waited.kind === "decided") return toGate(waited.record.decision, waited.record.reason);
		if (waited.kind === "timeout") {
			const record = await harness.commit(async (tx) => {
				const doc = await tx.doc(ApprovalsDoc, id);
				const existing = doc.decisions[call.callId];
				if (existing) return { ...existing };
				const decision: ApprovalDecisionRecord = {
					callId: call.callId,
					tool: call.tool,
					decision: "deny",
					reason: "timeout",
					decidedAt: this.now(),
				};
				delete doc.pending[call.callId];
				doc.decisions[call.callId] = decision;
				return decision;
			}, BACKGROUND_CONTEXT);
			if (record.reason === "timeout") {
				this.options.events.emit({ type: "approval.resolved", conversationId, callId: call.callId, outcome: "timeout" });
			}
			return toGate(record.decision, record.reason);
		}
		await harness
			.commit(async (tx) => {
				const doc = await tx.doc(ApprovalsDoc, id);
				delete doc.pending[call.callId];
			}, BACKGROUND_CONTEXT)
			.catch(() => {});
		this.options.events.emit({ type: "approval.resolved", conversationId, callId: call.callId, outcome: "cancelled" });
		return { proceed: false, block: BLOCK.cancelled, outcome: "cancelled" };
	}

	async decide(conversationId: SessionId, callId: string, decision: ApprovalDecision): Promise<void> {
		const harness = this.requireHarness();
		const id = conversationId as ConversationId;
		const existing = await harness.snapshot(ApprovalsDoc, id, BACKGROUND_CONTEXT);
		if (!existing?.pending[callId] && !existing?.decisions[callId]) {
			throw new HostError(404, "not_found", `no approval ${callId} in conversation ${conversationId}`);
		}
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ApprovalsDoc, id);
			if (doc.decisions[callId]) throw new HostError(409, "conflict", `approval ${callId} was already decided`);
			const pending = doc.pending[callId];
			if (!pending) throw new HostError(404, "not_found", `no approval ${callId} in conversation ${conversationId}`);
			delete doc.pending[callId];
			doc.decisions[callId] = { callId, tool: pending.tool, decision, reason: "operator", decidedAt: this.now() };
			if (decision === "approve_session") doc.session[pending.tool] = true;
		}, BACKGROUND_CONTEXT);
		this.options.events.emit({ type: "approval.resolved", conversationId, callId, outcome: decision });
	}

	async pending(): Promise<PendingApproval[]> {
		const harness = this.requireHarness();
		const known = await this.knownConversations(harness);
		const out: PendingApproval[] = [];
		for (const conversationId of [...known]) {
			const items = await this.pendingOf(harness, conversationId);
			if (items.length === 0) known.delete(conversationId);
			out.push(...items);
		}
		return out.sort((a, b) => a.createdAt - b.createdAt);
	}

	async pendingFor(sessionId: SessionId): Promise<PendingApproval[]> {
		return (await this.pending()).filter((p) => p.sessionId === sessionId);
	}

	async find(callId: string): Promise<PendingApproval | undefined> {
		return (await this.pending()).find((p) => p.callId === callId);
	}

	private async pendingOf(harness: Harness, conversationId: number): Promise<PendingApproval[]> {
		const id = conversationId as ConversationId;
		const doc = await harness.snapshot(ApprovalsDoc, id, BACKGROUND_CONTEXT);
		const records = Object.values(doc?.pending ?? {});
		if (records.length === 0) return [];
		const session = await harness.snapshot(SessionDoc, id, BACKGROUND_CONTEXT);
		return records.map((r) => toPending(conversationId, r, session?.worker?.parentId));
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

	/** Resolve on a decision in the doc, the expiry, or `ctx` cancellation, whichever comes first. */
	private async waitForDecision(
		harness: Harness,
		id: ConversationId,
		callId: string,
		expiresAt: number,
		ctx: Context,
	): Promise<Waited> {
		const done = Promise.withResolvers<Waited>();
		const check = (value: Readonly<ApprovalsDocValue> | undefined) => {
			const record = value?.decisions[callId];
			if (record) done.resolve({ kind: "decided", record: { ...record } });
		};
		const signal = ctx.abortSignal;
		const onAbort = () => done.resolve({ kind: "cancelled" });
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const cancelTimer = this.setTimer(() => done.resolve({ kind: "timeout" }), Math.max(0, expiresAt - this.now()));
		const watch = await harness.watchDoc(ApprovalsDoc, id, BACKGROUND_CONTEXT);
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

	private async sendNotification(approval: PendingApproval, title: string | undefined): Promise<void> {
		const notifier = this.options.notify?.();
		if (!notifier?.enabled("approval")) return;
		const base = this.options.config().public_url.replace(/\/$/, "");
		const target = `${base}/api/approvals/${encodeURIComponent(approval.callId)}`;
		const body = (decision: ApprovalDecision) => JSON.stringify({ decision, conversationId: approval.conversationId });
		await notifier.send({
			event: "approval",
			title: `Approval needed: ${approval.tool}`,
			message: `${title || `session ${approval.sessionId}`}${approval.worker ? ` (worker ${approval.worker})` : ""} wants to run ${approval.tool}`,
			sessionId: approval.sessionId,
			url: base,
			actions: [
				{ label: "Approve", url: target, method: "POST", body: body("approve") },
				{ label: "Deny", url: target, method: "POST", body: body("deny") },
			],
		});
	}

	private requireHarness(): Harness {
		if (!this.harness) throw new Error("ApprovalService used before attach(harness)");
		return this.harness;
	}
}

function toGate(decision: ApprovalDecision, reason: ApprovalDecisionRecord["reason"]): GateResult {
	if (decision !== "deny") return { proceed: true };
	const outcome: DenyOutcome = reason === "operator" ? "deny" : reason;
	return { proceed: false, block: BLOCK[outcome], outcome };
}

function toPending(conversationId: number, r: ApprovalPendingRecord, parentId: number | undefined): PendingApproval {
	return {
		conversationId,
		sessionId: parentId ?? conversationId,
		...(r.worker ? { worker: r.worker } : {}),
		callId: r.callId,
		tool: r.tool,
		args: r.args,
		createdAt: r.createdAt,
		expiresAt: r.expiresAt,
	};
}

function toJson(value: unknown): JsonValue {
	return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}
