import type { Op } from "@earendil-works/chord/delta";
import type { PendingApproval, WatchValue } from "../../src/api/types.js";

/** Canned conversation used by the replica tests and the stub server. */
export const SESSION_ID = 1;
export const CWD = "/work/demo";
export const RUN_TASK = 10;
export const APPROVAL_CALL = "toolu_B";

const usage = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280, cost: { input: 0.0012, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0016 } };

function assistant(content: unknown[], stopReason: string): unknown {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-5-5", usage, stopReason, timestamp: 1_800_000_000_000 };
}

function entry(id: number, kind: string, message: unknown, data?: unknown): Record<string, unknown> {
	return { model: [message], ...(data === undefined ? {} : { data }), kind, id, conversationId: SESSION_ID, byTaskId: RUN_TASK };
}

function toolResult(id: number, callId: string, text: string, isError = false): Record<string, unknown> {
	return entry(id, "pi.tool-result", { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError, durationMs: 900, timestamp: 1_800_000_000_500 }, { diagnostics: [] });
}

/** The view at attachment: one finished tool round, and a generation streaming its second answer. */
export function initialView(): WatchValue {
	return {
		conversation: { id: SESSION_ID },
		entries: [
			{ model: [{ role: "user", content: "Run the test suite and fix the flaky test.", timestamp: 1_800_000_000_000 }], kind: "pi.user", id: 8, conversationId: SESSION_ID },
			entry(11, "pi.system", { role: "system", content: "", timestamp: 1_800_000_000_000 }),
			entry(
				12,
				"pi.assistant",
				assistant(
					[
						{ type: "thinking", thinking: "Start by running the whole suite to see what fails." },
						{ type: "text", text: "I'll run the suite first." },
						{ type: "toolCall", id: "toolu_A", name: "bash", arguments: { command: "npm test" } },
					],
					"toolUse",
				),
			),
			toolResult(14, "toolu_A", " ✓ 41 passed\n ✗ 1 failed: test/retries.test.ts > backoff\n"),
		],
		docs: {
			"pi.agent": { model: { provider: "anthropic", modelId: "claude-haiku-5-5" }, cwd: CWD },
			"pi.live": {
				run: { taskId: RUN_TASK, inputs: [9], turns: 1, first: 8 },
				generation: { attempt: 1, message: assistant([{ type: "text", text: "One test fails " }], "pending") as never },
			},
			"pi.inbox": { items: [] },
			"pi.usage": { models: { "anthropic/claude-haiku-5-5": usage }, tools: {} },
		},
	} as unknown as WatchValue;
}

/** Ops sent right after the snapshot: the answer streams, ends in a bash call, and its slot waits for approval. */
export function streamingOps(): Op[][] {
	const gen = ["docs", "pi.live", "generation", "message", "content"] as const;
	return [
		[["a", [...gen, 0, "text"], "intermittently (`backoff`). "]],
		[["a", [...gen, 0, "text"], "I'll rerun it in isolation."]],
		[["p", [...gen], 1, 0, [{ type: "toolCall", id: APPROVAL_CALL, name: "bash", arguments: { command: "npx vitest " } }]]],
		[["a", [...gen, 1, "arguments", "command"], "run test/retries.test.ts"]],
		[
			["s", ["docs", "pi.live", "tools"], [{ callId: APPROVAL_CALL, name: "bash", taskId: 17, status: "pending" }]],
			["d", ["docs", "pi.live", "generation"]],
			["s", ["docs", "pi.live", "run", "turns"], 2],
			[
				"p",
				["entries"],
				4,
				0,
				[
					entry(
						16,
						"pi.assistant",
						assistant(
							[
								{ type: "text", text: "One test fails intermittently (`backoff`). I'll rerun it in isolation." },
								{ type: "toolCall", id: APPROVAL_CALL, name: "bash", arguments: { command: "npx vitest run test/retries.test.ts" } },
							],
							"toolUse",
						),
					) as never,
				],
			],
		],
	] as Op[][];
}

/** The pending approval for the bash call `streamingOps` ends in. */
export function pendingApproval(now = Date.now()): PendingApproval {
	return {
		conversationId: SESSION_ID,
		sessionId: SESSION_ID,
		callId: APPROVAL_CALL,
		tool: "bash",
		args: { command: "npx vitest run test/retries.test.ts" },
		createdAt: now,
		expiresAt: now + 12 * 3600_000,
	};
}

const FINAL_TEXT =
	"The `backoff` test passes in isolation, so it is **timing-dependent**:\n\n" +
	"- it asserts a 10 ms delay with a real clock\n" +
	"- under load the delay stretches past the bound\n\n" +
	"Fix: use fake timers in `test/retries.test.ts`.";

/** Ops after the approval: the tool runs and finishes, then the final answer streams and the run ends. */
export function approvedOps(): Op[][] {
	const slot = ["docs", "pi.live", "tools", 0] as const;
	const gen = ["docs", "pi.live", "generation", "message", "content", 0, "text"] as const;
	const chunks = FINAL_TEXT.match(/[\s\S]{1,24}/g) ?? [];
	return [
		[
			["s", [...slot, "status"], "running"],
			["s", [...slot, "output"], " RUN  v5.1.0 /work/demo\n"],
		],
		[["a", [...slot, "output"], " ✓ test/retries.test.ts > backoff (12ms)\n"]],
		[["a", [...slot, "output"], " Test Files  1 passed (1)\n"]],
		[
			["s", [...slot, "status"], "done"],
			["s", [...slot, "entry"], 18],
			["d", [...slot, "output"]],
			["p", ["entries"], 5, 0, [toolResult(18, APPROVAL_CALL, " RUN  v5.1.0 /work/demo\n ✓ test/retries.test.ts > backoff (12ms)\n Test Files  1 passed (1)\n") as never]],
		],
		[
			["d", ["docs", "pi.live", "tools"]],
			["s", ["docs", "pi.live", "generation"], { attempt: 1, message: assistant([{ type: "text", text: "" }], "pending") as never }],
		],
		...chunks.map((chunk): Op[] => [["a", [...gen], chunk]]),
		[
			["d", ["docs", "pi.live", "run"]],
			["d", ["docs", "pi.live", "generation"]],
			["p", ["entries"], 6, 0, [entry(20, "pi.assistant", assistant([{ type: "text", text: FINAL_TEXT }], "stop")) as never]],
		],
	] as Op[][];
}

/** The final answer text of `approvedOps`. */
export const FINAL_ANSWER = FINAL_TEXT;
