import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeEvent, NodeEventType } from "../../src/api/types.js";
import { validateConfig } from "../../src/config/load.js";
import type { ApprovalMode } from "../../src/config/schema.js";
import { ApprovalsDoc, SessionDoc, type WorkerIdentity } from "../../src/docs.js";
import { EventBus, type EventOf } from "../../src/events.js";
import { HostError } from "../../src/host.js";
import { ApprovalService } from "../../src/server/harness/approvals.js";
import { composeExtension } from "../../src/tools/registry.js";
import { entryText, fakeBash, fauxModels } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;
const TIMEOUT = 60_000;

const open: Harness[] = [];

async function setup() {
	const { models, script } = fauxModels();
	const events = new EventBus();
	const config = validateConfig(undefined, "/nonexistent").config;
	config.defaults.approval_timeout = TIMEOUT;
	let clock = 1_000_000;
	const timers = new Set<{ at: number; fn: () => void }>();
	const approvals = new ApprovalService({
		events,
		config: () => config,
		now: () => clock,
		setTimer: (fn, ms) => {
			const t = { at: clock + ms, fn };
			timers.add(t);
			return () => timers.delete(t);
		},
	});
	const bash = fakeBash();
	const registry = createRegistry();
	registry.install(composeExtension("tobor", [bash.module, approvals.module()]));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	approvals.attach(harness);
	const s = {
		harness,
		approvals,
		events,
		script,
		ran: bash.ran,
		/** Advance the fake clock and fire due timers. */
		advance(ms: number) {
			clock += ms;
			for (const t of [...timers]) {
				if (t.at <= clock) {
					timers.delete(t);
					t.fn();
				}
			}
		},
		async conversation(mode: ApprovalMode, worker?: WorkerIdentity) {
			const c = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "m" } },
					init: async (tx, id) => {
						const doc = await tx.doc(SessionDoc, id);
						doc.title = "t";
						doc.approval_mode = mode;
						doc.createdAt = 1;
						if (worker) doc.worker = worker;
					},
				},
				ctx,
			);
			return c;
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

const bashCall = (callId: string) => ({ callId, tool: "bash", args: { command: "echo hi" } });

describe("ApprovalService.gate", () => {
	it("skips auto sessions and ungated tools", async () => {
		const s = await setup();
		const seen: NodeEvent[] = [];
		s.events.onAny((e) => seen.push(e));
		const auto = await s.conversation("auto");
		expect(await s.approvals.gate(auto.id, bashCall("c1"), ctx)).toEqual({ proceed: true });
		const ask = await s.conversation("ask");
		expect(await s.approvals.gate(ask.id, { callId: "c2", tool: "read", args: {} }, ctx)).toEqual({ proceed: true });
		expect(seen).toEqual([]);
		expect(await s.approvals.pending()).toEqual([]);
	});

	it("asks, then an operator approve proceeds; a second decision is 409", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(c.id, bashCall("c1"), ctx);
		const { approval } = await requested;
		expect(approval).toMatchObject({ conversationId: c.id, sessionId: c.id, callId: "c1", tool: "bash" });
		expect(approval.expiresAt - approval.createdAt).toBe(TIMEOUT);
		expect(await s.approvals.pending()).toEqual([approval]);
		expect(await s.approvals.find("c1")).toEqual(approval);
		const resolved = s.next("approval.resolved");
		await s.approvals.decide(c.id, "c1", "approve");
		expect(await gate).toEqual({ proceed: true });
		expect(await resolved).toMatchObject({ callId: "c1", outcome: "approve" });
		expect(await s.approvals.pending()).toEqual([]);
		await expect(s.approvals.decide(c.id, "c1", "deny")).rejects.toMatchObject({ status: 409 });
		await expect(s.approvals.decide(c.id, "nope", "deny")).rejects.toBeInstanceOf(HostError);
	});

	it("approve_session grants the tool for later calls", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(c.id, bashCall("c1"), ctx);
		await requested;
		await s.approvals.decide(c.id, "c1", "approve_session");
		expect(await gate).toEqual({ proceed: true });
		const seen: NodeEvent[] = [];
		s.events.onAny((e) => seen.push(e));
		expect(await s.approvals.gate(c.id, bashCall("c2"), ctx)).toEqual({ proceed: true });
		expect(seen).toEqual([]);
		const doc = await s.harness.snapshot(ApprovalsDoc, c.id, ctx);
		expect(doc?.session).toEqual({ bash: true });
	});

	it("deny blocks, and a rerun of the same call finds the stored decision", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(c.id, bashCall("c1"), ctx);
		await requested;
		await s.approvals.decide(c.id, "c1", "deny");
		const denied = { proceed: false, block: "Denied by operator", outcome: "deny" };
		expect(await gate).toEqual(denied);
		expect(await s.approvals.gate(c.id, bashCall("c1"), ctx)).toEqual(denied);
	});

	it("denies with reason timeout once approval_timeout passes", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(c.id, bashCall("c1"), ctx);
		await requested;
		const resolved = s.next("approval.resolved");
		s.advance(TIMEOUT - 1);
		s.advance(1);
		expect(await gate).toEqual({ proceed: false, block: "Approval timed out", outcome: "timeout" });
		expect(await resolved).toMatchObject({ callId: "c1", outcome: "timeout" });
		const doc = await s.harness.snapshot(ApprovalsDoc, c.id, ctx);
		expect(doc?.pending).toEqual({});
		expect(doc?.decisions.c1).toMatchObject({ decision: "deny", reason: "timeout" });
		await expect(s.approvals.decide(c.id, "c1", "approve")).rejects.toMatchObject({ status: 409 });
	});

	it("cancellation unblocks the wait and drops the pending record", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		const { context, cancel } = withCancel(ctx);
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(c.id, bashCall("c1"), context);
		await requested;
		cancel();
		expect(await gate).toEqual({ proceed: false, block: "Cancelled while awaiting approval", outcome: "cancelled" });
		const doc = await s.harness.snapshot(ApprovalsDoc, c.id, ctx);
		expect(doc).toMatchObject({ pending: {}, decisions: {} });
	});

	it("a rerun re-attaches to a persisted pending record without asking again", async () => {
		const s = await setup();
		const c = await s.conversation("ask");
		await s.harness.commit(async (tx) => {
			const doc = await tx.doc(ApprovalsDoc, c.id);
			doc.pending.c1 = { callId: "c1", tool: "bash", args: {}, createdAt: 5, expiresAt: 5 + TIMEOUT };
		}, ctx);
		const seen: NodeEventType[] = [];
		s.events.onAny((e) => seen.push(e.type));
		const gate = s.approvals.gate(c.id, bashCall("c1"), ctx);
		expect((await s.approvals.pending()).map((p) => p.createdAt)).toEqual([5]);
		await s.approvals.decide(c.id, "c1", "approve");
		expect(await gate).toEqual({ proceed: true });
		expect(seen).toEqual(["approval.resolved"]);
	});

	it("attributes worker calls to the director session", async () => {
		const s = await setup();
		const director = await s.conversation("ask");
		const worker = await s.conversation("ask", { id: "w1", name: "scout-a", agent: "scout", parentId: director.id });
		const requested = s.next("approval.requested");
		const gate = s.approvals.gate(worker.id, bashCall("c9"), ctx);
		const { approval } = await requested;
		expect(approval).toMatchObject({ conversationId: worker.id, sessionId: director.id, worker: "scout-a" });
		expect(await s.approvals.pendingFor(director.id)).toHaveLength(1);
		await s.approvals.decide(worker.id, "c9", "approve");
		await gate;
	});

	it("applies predicates and the MCP default", async () => {
		const s = await setup();
		expect(await s.approvals.needsApproval("mcp__github__create_issue", {}, 1)).toBe(true);
		expect(await s.approvals.needsApproval("task", { tasks: [] }, 1)).toBe(false);
		s.approvals.setGate("task", (args) => typeof args === "object" && args !== null && "auto" in args && args.auto === true);
		expect(await s.approvals.needsApproval("task", { auto: true }, 1)).toBe(true);
		const policy = new ApprovalService({
			events: s.events,
			config: () => validateConfig(undefined, "/nonexistent").config,
			mcpNeedsApproval: () => (tool) => tool.endsWith("__create_issue"),
		});
		expect(await policy.needsApproval("mcp__github__list_issues", {}, 1)).toBe(false);
		expect(await policy.needsApproval("mcp__github__create_issue", {}, 1)).toBe(true);
	});
});

describe("approval hook in a run", () => {
	async function runOnce(decision: "approve" | "deny") {
		const s = await setup();
		s.script([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const c = await s.conversation("ask");
		const requested = s.next("approval.requested");
		const submission = await c.submit({ type: "input", content: "run it" }, ctx);
		const { approval } = await requested;
		expect(approval).toMatchObject({ callId: "call-1", tool: "bash", args: { command: "echo hi" } });
		await s.approvals.decide(c.id, "call-1", decision);
		expect(await submission.wait(ctx)).toMatchObject({ status: "done" });
		const page = await c.entries({ order: "ascending" }, 50, undefined, ctx);
		const result = page.items.find((e) => e.kind === "pi.tool-result");
		return { s, resultText: entryText(result) };
	}

	it("runs the tool after approve", async () => {
		const { s, resultText } = await runOnce("approve");
		expect(s.ran).toEqual(["echo hi"]);
		expect(resultText).toContain("ran: echo hi");
	});

	it("blocks the tool after deny", async () => {
		const { s, resultText } = await runOnce("deny");
		expect(s.ran).toEqual([]);
		expect(resultText).toContain("Denied by operator");
	});
});

