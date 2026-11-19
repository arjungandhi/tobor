import { describe, expect, it, vi } from "vitest";
import type { PendingApproval, WatchValue, WorkerSummary } from "../../src/api/types.js";
import type { App } from "../../src/tui/app.js";
import { ConversationReplica } from "../../src/tui/replica.js";
import { initialView, streamingOps } from "./scenario.js";
import { SessionScreen, type SessionTarget } from "../../src/tui/screens/session.js";

const emptyView = { conversation: 1, docs: {}, entries: [] } as unknown as WatchValue;
const worker = (id: string, conversationId: number): WorkerSummary => ({ id, name: id, agent: "a", conversationId, state: "idle", lastText: "", createdAt: 0 }) as unknown as WorkerSummary;
const approval = (conversationId: number, sessionId: number): PendingApproval =>
	({ conversationId, sessionId, callId: `c${conversationId}`, tool: "bash", args: {}, createdAt: 0, expiresAt: 0 }) as PendingApproval;

type Internals = {
	watch: unknown;
	replica: ConversationReplica | undefined;
	loadingEarlier: unknown;
	onFrame(replica: ConversationReplica, frame: unknown): void;
};

/** A screen over a fake app, with `target` open on a replica without a real socket. */
function setup(target: SessionTarget | undefined = { id: 1, title: "one" }) {
	const flashes: string[] = [];
	const approvals: PendingApproval[] = [];
	let api: Record<string, unknown> = {};
	const app = {
		tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
		approvals,
		questions: [],
		busy: false,
		api: () => api,
		flash: (m: string) => flashes.push(m),
		changed() {},
		pendingCalls: () => new Set<string>(),
		askingCalls: () => new Set<string>(),
		guard: (fn: () => Promise<unknown>) => fn().catch(() => {}),
	} as unknown as App;
	const screen = new SessionScreen(app);
	const internals = screen as unknown as Internals;
	const closed = vi.fn();
	const replica = new ConversationReplica(async () => ({ items: [], more: false }));
	replica.snapshot(emptyView);
	if (target) {
		screen.target = target;
		internals.replica = replica;
		internals.watch = { close: closed, reconnect() {} };
	}
	return { screen, internals, replica, flashes, approvals, closed, setApi: (a: Record<string, unknown>) => (api = a) };
}

describe("session state: worker approvals", () => {
	it("counts a pending approval of the session's own conversation", () => {
		const { screen, approvals } = setup();
		expect(screen.state()).toBe("idle");
		approvals.push(approval(1, 1));
		expect(screen.state()).toBe("waiting");
	});

	it("counts a worker's approval (worker conversation id) toward 'waiting'", () => {
		const { screen, approvals } = setup();
		screen.workers = [worker("w1", 50)];
		approvals.push(approval(50, 1));
		expect(screen.state()).toBe("waiting");
	});

	it("counts a worker approval by session id even before the workers list has it", () => {
		const { screen, approvals } = setup();
		approvals.push(approval(77, 1));
		expect(screen.state()).toBe("waiting");
	});

	it("ignores other sessions' approvals", () => {
		const { screen, approvals } = setup();
		screen.workers = [worker("w1", 50)];
		approvals.push(approval(2, 2), approval(60, 2));
		expect(screen.state()).toBe("idle");
	});

	it("a worker transcript only counts its own conversation", () => {
		const parent = { id: 1, title: "one" };
		const { screen, approvals } = setup({ id: 50, title: "w1", worker: { name: "w1", parent } });
		approvals.push(approval(51, 1));
		expect(screen.state()).toBe("idle");
		approvals.push(approval(50, 1));
		expect(screen.state()).toBe("waiting");
	});
});

describe("watch end frame", () => {
	it("is terminal for any reason: closes the watch once, keeps the target and notes it", () => {
		const { screen, internals, replica, flashes, closed } = setup();
		internals.onFrame(replica, { t: "end", reason: "server restarting" });
		expect(closed).toHaveBeenCalledTimes(1);
		expect(internals.watch).toBeUndefined();
		expect(flashes).toEqual(["watch ended: server restarting"]);
		expect(screen.watchEnded).toBe("server restarting");
		expect(screen.target?.id).toBe(1);
		expect(screen.transcript.render(80).join("\n")).toContain("watch ended: server restarting · Enter to reopen");
	});
});

describe("stale flags across sessions", () => {
	it("a load-earlier in flight for a closed session does not block the next session", async () => {
		const { screen, internals, replica } = setup();
		let settle: () => void = () => {};
		const pending = new Promise<void>((resolve) => (settle = resolve));
		const load = vi.spyOn(replica, "loadEarlier").mockImplementation(() => pending);
		const first = screen.loadEarlier();
		expect(internals.loadingEarlier).toBe(replica);
		screen.close();
		expect(internals.loadingEarlier).toBeUndefined();

		const next = new ConversationReplica(async () => ({ items: [], more: false }));
		next.snapshot(emptyView);
		screen.target = { id: 2, title: "two" };
		internals.replica = next;
		const nextLoad = vi.spyOn(next, "loadEarlier").mockResolvedValue();
		await screen.loadEarlier();
		expect(nextLoad).toHaveBeenCalledTimes(1);

		settle();
		await first;
		expect(load).toHaveBeenCalledTimes(1);
		// The old fetch settling must not clear the flag of a load that started since.
		expect(internals.loadingEarlier).toBeUndefined();
	});
});

describe("wrong-session side effects", () => {
	it("a failed send restores its text only into the session it was submitted to", async () => {
		const { screen, setApi } = setup();
		let fail: (e: Error) => void = () => {};
		setApi({ input: () => new Promise((_, reject) => (fail = reject)) });
		screen.composer.setText("hello");
		screen.composer.onSubmit?.("hello");
		screen.composer.clearAll();
		screen.target = { id: 2, title: "two" };
		fail(new Error("boom"));
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.composer.getExpandedText()).toBe("");
	});

	it("a failed send restores its text when the same session is still open", async () => {
		const { screen, setApi } = setup();
		setApi({ input: async () => Promise.reject(new Error("boom")) });
		screen.composer.onSubmit?.("hello");
		await new Promise((r) => setTimeout(r, 0));
		expect(screen.composer.getExpandedText()).toBe("hello");
	});

	it("a send that finishes after a switch leaves the new session's scroll and staged images alone", async () => {
		const { screen, setApi } = setup();
		let finish: () => void = () => {};
		setApi({ input: () => new Promise<void>((resolve) => (finish = resolve)) });
		const unstage = vi.spyOn(screen.composer, "unstage");
		screen.composer.onSubmit?.("hello");
		screen.target = { id: 2, title: "two" };
		const scrolled = vi.spyOn(screen.scroll, "scrollToEnd");
		finish();
		await new Promise((r) => setTimeout(r, 0));
		expect(unstage).not.toHaveBeenCalled();
		expect(scrolled).not.toHaveBeenCalled();
	});
});

describe("ops frame coalescing", () => {
	it("rebuilds once for several ops frames in the same tick, and applies them all", async () => {
		const { screen, internals, replica } = setup();
		internals.onFrame(replica, { t: "snapshot", value: initialView() });
		const rebuild = vi.spyOn(screen, "rebuild");
		const [first, second, third] = streamingOps();
		internals.onFrame(replica, { t: "ops", ops: first });
		internals.onFrame(replica, { t: "ops", ops: second });
		internals.onFrame(replica, { t: "ops", ops: third });
		expect(rebuild).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(rebuild).toHaveBeenCalledTimes(1);
		const live = replica.blocks().filter((b) => b.kind === "assistant" && b.streaming);
		expect(live.length).toBeGreaterThan(0);
	});

	it("a closed session drops its pending rebuild", async () => {
		const { screen, internals, replica } = setup();
		internals.onFrame(replica, { t: "snapshot", value: initialView() });
		const rebuild = vi.spyOn(screen, "rebuild");
		internals.onFrame(replica, { t: "ops", ops: streamingOps()[0] as never });
		screen.close();
		rebuild.mockClear();
		await Promise.resolve();
		expect(rebuild).not.toHaveBeenCalled();
	});
});
