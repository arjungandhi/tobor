import { describe, expect, it } from "vitest";
import type { PendingQuestion } from "../../src/api/types.js";
import type { App } from "../../src/tui/app.js";
import { QuestionPanel, relevantQuestions } from "../../src/tui/components/question-panel.js";
import { questionCard } from "../../src/tui/screens/questions.js";

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

const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("QuestionPanel", () => {
	const form: PendingQuestion = {
		...q("form", 1, 1, 10),
		question: "Set up the service",
		fields: [{ prompt: "Which language?", options: ["TypeScript", "Go"] }, { prompt: "Name?" }, { prompt: "Notes?" }],
	};
	const single: PendingQuestion = { ...q("single", 1, 1, 20), question: "Proceed?", options: ["yes", "no"] };
	const panel = (...questions: PendingQuestion[]) => {
		const app = { questions, sessions: [], whoami: undefined, now: () => Date.now() } as unknown as App;
		return new QuestionPanel(app, () => ({ id: 1 }));
	};

	it("renders a single question without form chrome", () => {
		const out = plain(panel(single).render(60));
		expect(out).toContain("Proceed?");
		expect(out).toContain("❯ yes");
		expect(out).not.toContain("field ");
	});

	it("renders the header, progress and the current field's prompt and options", () => {
		const p = panel(form);
		let out = plain(p.render(60));
		expect(out).toContain("Set up the service");
		expect(out).toContain("field 1/3");
		expect(out).toContain("Which language?");
		expect(out).toContain("❯ TypeScript");
		expect(p.options()).toEqual(["TypeScript", "Go"]);
		p.move(1);
		expect(p.selectedOption()).toBe("Go");

		expect(p.record(form, "Go")).toBeUndefined();
		out = plain(p.render(60));
		expect(out).toContain("field 2/3");
		expect(out).toContain("Name?");
		expect(out).not.toContain("Which language?");
		expect(p.options()).toEqual([]);
		expect(p.selectedOption()).toBeUndefined();
	});

	it("returns answers in field order only after the last field", () => {
		const p = panel(form);
		expect(p.record(form, "Go")).toBeUndefined();
		expect(p.record(form, "svc")).toBeUndefined();
		expect(p.record(form, "none")).toEqual(["Go", "svc", "none"]);
	});

	it("does not collect for a single question", () => {
		expect(panel(single).record(single, "yes")).toBeUndefined();
		expect(panel(single).fieldIndex(single)).toBe(0);
	});

	it("lists every field in the question card", () => {
		const card = plain(questionCard({ sessions: [], whoami: undefined, now: () => Date.now() } as unknown as App, form));
		expect(card).toContain("Set up the service");
		expect(card).toContain("1. Which language?");
		expect(card).toContain("3. Notes?");
	});
});
