import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../src/tui/components/transcript.js";
import type { Block } from "../../src/tui/replica.js";
import { countUserBlocks, echoBlock, type PendingEcho, pendingEchoes } from "../../src/tui/screens/session.js";

const user = (id: number, text: string): Block => ({ kind: "user", key: `u:${id}`, text });
const echo = (requestId: string, text: string, seen = 0): PendingEcho => ({ requestId, text, images: [], seen });

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
