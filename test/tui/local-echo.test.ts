import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/tui/components/transcript.js";
import type { Block } from "../../src/tui/replica.js";
import type { WatchValue } from "../../src/api/types.js";
import type { App } from "../../src/tui/app.js";
import { ConversationReplica } from "../../src/tui/replica.js";
import { countUserBlocks, ECHO_TTL_MS, echoBlock, type PendingEcho, pendingEchoes, SessionScreen } from "../../src/tui/screens/session.js";

const user = (id: number, text: string): Block => ({ kind: "user", key: `u:${id}`, text });
const echo = (requestId: string, text: string, seen = 0, sentAt = Date.now()): PendingEcho => ({ requestId, text, images: [], seen, sentAt });

describe("local echo", () => {
	it("stays pending until a new identical user block arrives", () => {
		const e = echo("r1", "hello");
		expect(pendingEchoes([user(1, "other")], [e])).toEqual([e]);
		expect(pendingEchoes([user(1, "other"), user(2, "hello")], [e])).toEqual([]);
	});

	it("is settled by a queued block (steer / follow-up) and ignores outer whitespace", () => {
		const queued: Block = { kind: "queued", key: "q:1", text: "later\n", mode: "steer" };
		expect(pendingEchoes([queued], [echo("r1", "later")])).toEqual([]);
	});

	it("ignores identical messages that were already there when it was sent", () => {
		const blocks = [user(1, "again")];
		const e = echo("r1", "again", countUserBlocks(blocks, "again"));
		expect(pendingEchoes(blocks, [e])).toEqual([e]);
		expect(pendingEchoes([...blocks, user(2, "again")], [e])).toEqual([]);
	});

	it("settles identical echoes one per delivered block", () => {
		const first = echo("r1", "x", 0);
		const second = echo("r2", "x", 1);
		expect(pendingEchoes([user(1, "x")], [first, second])).toEqual([second]);
		expect(pendingEchoes([user(1, "x"), user(2, "x")], [first, second])).toEqual([]);
	});

	it("renders as a dimmed block with a sending marker at the end, and never beside the real block", () => {
		const t = new Transcript();
		const e = echo("r1", "hi there");
		t.update([user(1, "old"), echoBlock(e)]);
		const lines = t.render(40).map((l) => stripTerminalSequences(l).trimEnd());
		expect(lines).toEqual(["", "▌ old", "", "▌ hi there", "▌ sending…"]);
		const blocks = [user(1, "old"), user(2, "hi there")];
		t.update([...blocks, ...pendingEchoes(blocks, [e]).map(echoBlock)]);
		expect(t.render(40).map((l) => stripTerminalSequences(l).trimEnd())).toEqual(["", "▌ old", "", "▌ hi there"]);
	});
});

describe("local echo TTL", () => {
	it("drops an unsettled echo once it is older than the TTL", () => {
		const e = echo("r1", "hello", 0, 1000);
		expect(pendingEchoes([], [e], 1000 + ECHO_TTL_MS - 1)).toEqual([e]);
		expect(pendingEchoes([], [e], 1000 + ECHO_TTL_MS)).toEqual([]);
	});
});

describe("local echo on the session screen", () => {
	const emptyView = { conversation: 1, docs: {}, entries: [] } as unknown as WatchValue;

	function setup() {
		const app = {
			tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
			approvals: [],
			questions: [],
			busy: false,
			api: () => ({}),
			flash() {},
			changed() {},
			pendingCalls: () => new Set<string>(),
			askingCalls: () => new Set<string>(),
			guard: (fn: () => Promise<unknown>) => fn().catch(() => {}),
		} as unknown as App;
		const screen = new SessionScreen(app);
		const internals = screen as unknown as {
			echoes: PendingEcho[];
			replica: ConversationReplica | undefined;
			onFrame(replica: ConversationReplica, frame: unknown): void;
			addEcho(requestId: string, text: string, images: readonly []): void;
		};
		const replica = new ConversationReplica(async () => ({ items: [], more: false }));
		replica.snapshot(emptyView);
		screen.target = { id: 1, title: "one" };
		internals.replica = replica;
		return { screen, internals, replica };
	}

	const rendered = (screen: SessionScreen) => stripTerminalSequences(screen.transcript.render(60).join("\n"));

	it("a snapshot frame settles every pending echo", () => {
		const { screen, internals, replica } = setup();
		internals.addEcho("r1", "hello", []);
		internals.addEcho("r2", "world", []);
		expect(rendered(screen)).toContain("sending…");
		internals.onFrame(replica, { t: "snapshot", value: emptyView });
		expect(internals.echoes).toEqual([]);
		expect(rendered(screen)).not.toContain("sending…");
	});

	it("an echo expires after the TTL without any frame arriving", () => {
		vi.useFakeTimers();
		try {
			const { screen, internals } = setup();
			internals.addEcho("r1", "hello", []);
			vi.advanceTimersByTime(ECHO_TTL_MS - 1000);
			expect(internals.echoes).toHaveLength(1);
			vi.advanceTimersByTime(1500);
			expect(internals.echoes).toEqual([]);
			expect(rendered(screen)).not.toContain("sending…");
		} finally {
			vi.useRealTimers();
		}
	});
});
