import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Op } from "@earendil-works/chord/delta";
import type { EntryRecord, TranscriptItem } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { WatchValue } from "../../src/api/types.js";
import { type Block, BlockDeriver, ConversationReplica, deriveBlocks, type EntriesFetcher, usageOf } from "../../src/tui/replica.js";
import { APPROVAL_CALL, approvedOps, FINAL_ANSWER, initialView, streamingOps } from "./scenario.js";

type Fixture = { initial: WatchValue; ops: Op[][]; final: WatchValue };

const noEntries: EntriesFetcher = async () => ({ items: [], more: false });

function loadFixture(name: string): Fixture {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

function summary(blocks: Block[]): string[] {
	return blocks.map((b) => {
		switch (b.kind) {
			case "tool":
				return `tool ${b.name} ${b.status} ${JSON.stringify(b.args)} ${JSON.stringify(b.output)}`;
			case "user":
			case "assistant":
			case "thinking":
			case "notice":
				return `${b.kind} ${b.text.slice(0, 30)}`;
			default:
				return b.kind;
		}
	});
}

describe("replica over recorded pi-durable fixtures", () => {
	for (const name of ["bash-run", "stream-run"]) {
		it(`${name}: replays to the final view`, () => {
			const fx = loadFixture(name);
			const replica = new ConversationReplica(noEntries);
			replica.snapshot(fx.initial);
			for (const batch of fx.ops) replica.apply(batch);
			expect(isDeepStrictEqual(replica.view, fx.final)).toBe(true);
			expect(replica.running).toBe(false);
		});
	}

	it("stream-run: tool slot streams output, then the answer streams into one block", () => {
		const fx = loadFixture("stream-run");
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(fx.initial);
		const seen: Block[][] = [];
		for (const batch of fx.ops) {
			replica.apply(batch);
			seen.push(replica.blocks());
		}
		const running = seen.find((blocks) => blocks.some((b) => b.kind === "tool" && b.status === "running" && b.output.includes("line-3")));
		expect(running).toBeDefined();
		const tool = running?.find((b) => b.kind === "tool");
		expect(tool).toMatchObject({ key: expect.stringMatching(/^t:toolu_/), name: "bash" });

		const streaming = seen.filter((blocks) => blocks.some((b) => b.kind === "assistant" && b.streaming));
		expect(streaming.length).toBeGreaterThan(3);
		const lengths = streaming.map((blocks) => {
			const live = blocks.find((b) => b.kind === "assistant" && b.streaming);
			return live?.kind === "assistant" ? live.text.length : 0;
		});
		expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);

		const final = seen.at(-1) ?? [];
		expect(summary(final).map((s) => s.split(" ")[0])).toEqual(["user", "tool", "assistant"]);
		const finalTool = final[1];
		expect(finalTool?.kind === "tool" && finalTool.status).toBe("done");
		expect(finalTool?.kind === "tool" && finalTool.output).toBe("line-1\nline-2\nline-3\nline-4\nline-5\n");
		expect(final[2]).toMatchObject({ kind: "assistant", streaming: false });
		expect(final.every((b) => b.key !== "live:0")).toBe(true);
	});

	it("tool block key is stable from streamed arguments to the result entry", () => {
		const fx = loadFixture("stream-run");
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(fx.initial);
		const keys = new Set<string>();
		for (const batch of fx.ops) {
			replica.apply(batch);
			for (const b of replica.blocks()) if (b.kind === "tool") keys.add(b.key);
		}
		expect(keys.size).toBe(1);
	});

	const spike = new URL("../../spike/out/fixtures/stream-run.ops.jsonl", import.meta.url);
	it.skipIf(!existsSync(spike))("matches every value delivered with the original spike recording", () => {
		const initial = JSON.parse(readFileSync(new URL("./stream-run.initial.json", spike), "utf8")) as WatchValue;
		const calls = readFileSync(spike, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; value: WatchValue; ops: Op[] });
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(initial);
		for (const call of calls) {
			if (call.kind !== "value") continue;
			replica.apply(call.ops);
			expect(isDeepStrictEqual(replica.view, call.value)).toBe(true);
		}
	});
});

describe("replica over constructed ops", () => {
	it("streams a partial answer and ends in a tool slot awaiting approval", () => {
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(initialView());
		const first = replica.blocks();
		expect(summary(first)).toEqual([
			"user Run the test suite and fix the",
			"thinking Start by running the whole sui",
			"assistant I'll run the suite first.",
			`tool bash done {"command":"npm test"} " ✓ 41 passed\\n ✗ 1 failed: test/retries.test.ts > backoff\\n"`,
			"assistant One test fails ",
		]);
		expect(first.at(-1)).toMatchObject({ key: "live:0", streaming: true });

		const ops = streamingOps();
		for (const batch of ops.slice(0, 4)) replica.apply(batch);
		const mid = replica.blocks(new Set([APPROVAL_CALL]));
		expect(mid.at(-1)).toMatchObject({ kind: "tool", status: "approval", args: { command: "npx vitest run test/retries.test.ts" } });

		for (const batch of ops.slice(4)) replica.apply(batch);
		expect(replica.blocks().at(-1)).toMatchObject({ kind: "tool", key: `t:${APPROVAL_CALL}`, status: "pending" });
		const gated = replica.blocks(new Set([APPROVAL_CALL]));
		expect(gated.at(-1)).toMatchObject({ kind: "tool", status: "approval" });
		expect(gated.at(-2)).toMatchObject({ kind: "assistant", key: "a:16:0", streaming: false });
		expect(replica.running).toBe(true);
	});

	it("marks a call awaiting an ask_user answer, whether its slot is pending or running", () => {
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(initialView());
		const ops = streamingOps();
		for (const batch of ops) replica.apply(batch);
		const call = new Set([APPROVAL_CALL]);
		expect(replica.blocks(undefined, call).at(-1)).toMatchObject({ kind: "tool", status: "question" });
		expect(replica.blocks(call, call).at(-1)).toMatchObject({ kind: "tool", status: "approval" });
		expect(replica.blocks(undefined, new Set(["other"])).at(-1)).toMatchObject({ kind: "tool", status: "pending" });
		const blocks = deriveBlocks([], { "pi.live": { tools: [{ callId: "q", name: "ask_user", status: "running" }] } } as never, new Set(), new Set(["q"]));
		expect(blocks).toEqual([expect.objectContaining({ kind: "tool", name: "ask_user", status: "question" })]);
	});

	it("runs the approved tool, then finishes the answer", () => {
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(initialView());
		for (const batch of streamingOps()) replica.apply(batch);
		const after = approvedOps();
		replica.apply(after[0] ?? []);
		replica.apply(after[1] ?? []);
		expect(replica.blocks().at(-1)).toMatchObject({ kind: "tool", status: "running", output: expect.stringContaining("backoff (12ms)") });
		for (const batch of after.slice(2)) replica.apply(batch);
		const blocks = replica.blocks();
		expect(blocks.at(-2)).toMatchObject({ kind: "tool", status: "done", output: expect.stringContaining("1 passed") });
		expect(blocks.at(-1)).toMatchObject({ kind: "assistant", key: "a:20:0", text: FINAL_ANSWER, streaming: false });
		expect(replica.running).toBe(false);
		expect(replica.resume).toEqual({ from: 21 });
		expect(usageOf(replica.view?.docs)).toEqual({ tokens: 1280, cost: 0.0016 });
	});

	it("shows a run failure, a tool error and a model error", () => {
		const view = initialView();
		const replica = new ConversationReplica(noEntries);
		replica.snapshot(view);
		replica.apply([
			["d", ["docs", "pi.live", "generation"]],
			["d", ["docs", "pi.live", "run"]],
			["s", ["docs", "pi.live", "runFailure"], { taskId: 10, inputs: [9], reason: "model_error", detail: "overloaded" }],
			[
				"p",
				["entries"],
				4,
				0,
				[
					{ kind: "pi.assistant", id: 15, conversationId: 1, model: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" }] },
					{ kind: "pi.tool-result", id: 16, conversationId: 1, model: [{ role: "toolResult", toolCallId: "orphan", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true }] },
				],
			],
		]);
		const blocks = replica.blocks();
		expect(blocks.slice(-3)).toEqual([
			{ kind: "notice", key: "n:15", level: "error", text: "model error: overloaded" },
			{ kind: "tool", key: "t:orphan", callId: "orphan", name: "bash", args: undefined, status: "error", output: "boom" },
			{ kind: "notice", key: "fail:10", level: "error", text: "run ended without an answer: model_error — overloaded" },
		]);
	});

	it("reconnect snapshot keeps earlier entries and marks the gap; loadEarlier fills from the API", async () => {
		const older: EntryRecord[] = [
			{ kind: "pi.user", id: 2, conversationId: 1, model: [{ role: "user", content: "older prompt", timestamp: 1 }] } as unknown as EntryRecord,
		];
		const calls: Parameters<EntriesFetcher>[0][] = [];
		const replica = new ConversationReplica(async (query) => {
			calls.push(query);
			return { items: older, more: false };
		});
		const view = initialView();
		replica.snapshot({ ...view, before: 7 as never });
		expect(replica.blocks()[0]).toEqual({ kind: "earlier", key: "earlier" });
		await replica.loadEarlier();
		expect(calls).toEqual([{ maxEntryId: 7, order: "desc", limit: 50 }]);
		expect(replica.blocks()[0]).toMatchObject({ kind: "user", text: "older prompt" });

		const resumed = replica.resume;
		expect(resumed).toEqual({ from: 15 });
		const later = initialView();
		replica.snapshot({ ...later, entries: [{ kind: "pi.user", id: 30, conversationId: 1, model: [{ role: "user", content: "after reconnect", timestamp: 2 }] } as never], before: 25 as never });
		const blocks = replica.blocks();
		expect(blocks.some((b) => b.kind === "gap")).toBe(true);
		expect(blocks.some((b) => b.kind === "user" && b.text === "older prompt")).toBe(true);
		expect(blocks.some((b) => b.kind === "user" && b.text === "after reconnect")).toBe(true);
	});

	it("rejects ops before a snapshot", () => {
		const replica = new ConversationReplica(noEntries);
		expect(() => replica.apply([])).toThrow("ops before snapshot");
	});

	it("deriveBlocks ignores system entries and renders resets", () => {
		const blocks = deriveBlocks(
			[
				{ kind: "entry", entry: { kind: "pi.system", id: 1, conversationId: 1 } as never },
				{ kind: "entry", entry: { kind: "pi.reset", id: 2, conversationId: 1 } as never },
			],
			undefined,
		);
		expect(blocks).toEqual([{ kind: "notice", key: "n:2", level: "info", text: "context reset" }]);
	});

	it("deriveBlocks shows queued inbox messages and hides internal writes", () => {
		const inbox = {
			items: [
				{ id: "a", mode: "steer", content: "change course" },
				{ id: "b", mode: "followUp", content: [{ type: "text", text: "then this" }] },
				{ id: "c", mode: "write", content: "internal" },
			],
		};
		const blocks = deriveBlocks([], { "pi.inbox": inbox } as never);
		expect(blocks).toEqual([
			{ kind: "queued", key: "q:a", text: "change course", mode: "steer" },
			{ kind: "queued", key: "q:b", text: "then this", mode: "followUp" },
		]);
		expect(deriveBlocks([], {} as never)).toEqual([]);
	});

	it("deriveBlocks shows queued inbox messages with numeric submission ids", () => {
		const inbox = {
			items: [
				{ id: 22, mode: "steer", content: "X" },
				{ id: 23, mode: "followUp", content: [{ type: "text", text: "Y" }] },
			],
		};
		expect(deriveBlocks([], { "pi.inbox": inbox } as never)).toEqual([
			{ kind: "queued", key: "q:22", text: "X", mode: "steer" },
			{ kind: "queued", key: "q:23", text: "Y", mode: "followUp" },
		]);
	});
});

describe("incremental block derivation", () => {
	const entry = (id: number, kind: string, message: unknown): TranscriptItem => ({ kind: "entry", entry: { kind, id, conversationId: 1, model: [message] } as unknown as EntryRecord });
	const user = (id: number, text: string) => entry(id, "pi.user", { role: "user", content: text, timestamp: 1 });
	const call = (id: number, callId: string) =>
		entry(id, "pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { cmd: "ls" } }], stopReason: "toolUse" });
	const result = (id: number, callId: string, text: string) =>
		entry(id, "pi.tool-result", { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError: false });

	it("reuses the blocks of unchanged entries when items only grow at the end", () => {
		const d = new BlockDeriver();
		const items = [user(1, "one"), user(2, "two")];
		const first = d.derive(items, undefined);
		const three = user(3, "three");
		const second = d.derive([...items, three], undefined);
		expect(second.map((b) => b.key)).toEqual(["u:1", "u:2", "u:3"]);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		// Same items again: the blocks are still the cached ones, in a fresh array.
		const again = d.derive([...items, three], undefined);
		expect(again).not.toBe(second);
		expect(again[0]).toBe(first[0]);
		expect(again[2]).toBe(second[2]);
	});

	it("matches the one-shot derivation", () => {
		const items = [user(1, "go"), call(2, "c1"), result(3, "c1", "out"), user(4, "next")];
		const d = new BlockDeriver();
		d.derive(items.slice(0, 2), undefined);
		expect(d.derive(items, undefined)).toEqual(deriveBlocks(items, undefined));
	});

	it("replaces a tool block when its result lands, without touching blocks already handed out", () => {
		const d = new BlockDeriver();
		const items = [user(1, "go"), call(2, "c1")];
		const before = d.derive(items, undefined);
		const tool = before[1] as Extract<Block, { kind: "tool" }>;
		expect(tool).toMatchObject({ status: "pending", output: "" });
		const after = d.derive([...items, result(3, "c1", "done!")], undefined);
		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		expect(after[1]).toMatchObject({ status: "done", output: "done!", args: { cmd: "ls" } });
		expect(tool).toMatchObject({ status: "pending", output: "" });
	});

	it("keeps committed blocks untouched by approval and live overlays", () => {
		const d = new BlockDeriver();
		const items = [call(1, "c1")];
		const plain = d.derive(items, undefined);
		const approving = d.derive(items, undefined, new Set(["c1"]));
		expect(approving[0]).toMatchObject({ status: "approval" });
		expect(d.derive(items, undefined)[0]).toBe(plain[0]);
		expect(plain[0]).toMatchObject({ status: "pending" });
	});

	it("invalidates when an entry changes or the items are not an extension", () => {
		const d = new BlockDeriver();
		const a = [user(1, "one"), user(2, "two")];
		const first = d.derive(a, undefined);
		// Same ids, different entry object and text: re-derived.
		const edited = d.derive([a[0] as TranscriptItem, user(2, "TWO")], undefined);
		expect(edited[0]).toBe(first[0]);
		expect(edited[1]).toMatchObject({ text: "TWO" });
		// An entry inserted before existing ones (e.g. earlier history loaded): everything is rebuilt, the entry blocks reused.
		const prepended = d.derive([user(0, "zero"), a[0] as TranscriptItem, a[1] as TranscriptItem], undefined);
		expect(prepended.map((b) => b.key)).toEqual(["u:0", "u:1", "u:2"]);
		expect(prepended[1]).toBe(first[0]);
		expect(prepended[2]).toBe(first[1]);
	});
});

describe("replica atomic updates", () => {
	it("a merge that throws leaves value and items as they were", () => {
		const replica = new ConversationReplica(noEntries);
		const fx = loadFixture("bash-run");
		replica.snapshot(fx.initial);
		const view = replica.view;
		const items = replica.items;
		const bad = { ...fx.initial, entries: null } as unknown as WatchValue;
		expect(() => replica.snapshot(bad)).toThrow();
		expect(replica.view).toBe(view);
		expect(replica.items).toBe(items);
	});
});
