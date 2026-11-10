import { describe, expect, it } from "vitest";
import type { PendingQuestion } from "../../src/api/types.js";
import { relevantQuestions } from "../../src/tui/components/question-panel.js";

const q = (callId: string, conversationId: number, sessionId: number, createdAt: number): PendingQuestion => ({
	callId,
	conversationId,
	sessionId,
	question: callId,
	createdAt,
	expiresAt: createdAt + 1000,
});

describe("relevantQuestions", () => {
	const all = [q("late", 1, 1, 30), q("worker", 7, 1, 20), q("other", 2, 2, 10), q("early", 1, 1, 5)];

	it("shows a session's own and its workers' questions, oldest first", () => {
		expect(relevantQuestions(all, { id: 1 }).map((x) => x.callId)).toEqual(["early", "worker", "late"]);
	});

	it("shows only the worker's questions in a worker transcript", () => {
		expect(relevantQuestions(all, { id: 7, worker: { name: "w" } }).map((x) => x.callId)).toEqual(["worker"]);
	});

	it("is empty without an open session", () => {
		expect(relevantQuestions(all, undefined)).toEqual([]);
	});
});
