import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PendingQuestion, SessionId } from "../../api/types.js";
import type { App } from "../app.js";
import { questionCard } from "../screens/questions.js";
import { c } from "../theme.js";

/** The part of a session target the panel needs: what is open, and whether it is a worker transcript. */
export type QuestionTarget = { id: SessionId; worker?: unknown };

const MAX_TEXT_LINES = 8;
const MAX_OPTIONS = 6;

/**
 * Pending questions that belong in the open view, oldest first: a plain session shows its own and its workers'
 * (`sessionId`); a worker transcript shows that worker's (`conversationId`).
 */
export function relevantQuestions(questions: readonly PendingQuestion[], target: QuestionTarget | undefined): PendingQuestion[] {
	if (!target) return [];
	return questions
		.filter((q) => (target.worker ? q.conversationId === target.id : q.sessionId === target.id))
		.sort((a, b) => a.createdAt - b.createdAt);
}

function questionKey(q: PendingQuestion): string {
	return `${q.conversationId}:${q.callId}`;
}

/** Inline `ask_user` panel between the workers strip and the composer; renders nothing without a relevant question. */
export class QuestionPanel implements Component {
	private selected = 0;
	private shown: string | undefined;
	/** Answers collected so far for form questions, keyed by conversation and call id (the last field is never stored). */
	private readonly collected = new Map<string, string[]>();

	constructor(
		private readonly app: App,
		private readonly target: () => QuestionTarget | undefined,
	) {}

	/** Relevant questions, oldest first. */
	pending(): PendingQuestion[] {
		return relevantQuestions(this.app.questions, this.target());
	}

	/** The question being shown (the oldest relevant one). */
	current(): PendingQuestion | undefined {
		const q = this.pending()[0];
		const key = q ? `${questionKey(q)}:${this.fieldIndex(q)}` : undefined;
		if (key !== this.shown) {
			this.shown = key;
			this.selected = 0;
		}
		return q;
	}

	/** Index of the field being answered (0 for a single question). */
	fieldIndex(q: PendingQuestion): number {
		return q.fields?.length ? (this.collected.get(questionKey(q))?.length ?? 0) : 0;
	}

	/** Options of what is being answered now: the current field's for a form, else the question's. */
	options(): string[] {
		const q = this.current();
		if (!q) return [];
		return (q.fields?.length ? q.fields[this.fieldIndex(q)]?.options : q.options) ?? [];
	}

	/**
	 * Take the answer to the current field. Returns the full `answers` once the last field is answered, else undefined
	 * (the panel moves to the next field). A single question returns undefined: it is answered with `answer` instead.
	 */
	record(q: PendingQuestion, answer: string): string[] | undefined {
		const fields = q.fields;
		if (!fields?.length) return undefined;
		const key = questionKey(q);
		const soFar = this.collected.get(key) ?? [];
		if (soFar.length + 1 < fields.length) {
			this.collected.set(key, [...soFar, answer]);
			return undefined;
		}
		return [...soFar, answer];
	}

	/** Forget collected answers of questions that are no longer pending. */
	private prune(): void {
		for (const key of this.collected.keys()) {
			if (!this.app.questions.some((q) => questionKey(q) === key)) this.collected.delete(key);
		}
	}

	/** Move the option highlight; false when the shown question has no options. */
	move(delta: number): boolean {
		const options = this.options();
		if (!options.length) return false;
		this.selected = (this.selected + delta + options.length) % options.length;
		return true;
	}

	/** The highlighted option of the shown question. */
	selectedOption(): string | undefined {
		return this.options()[this.selected];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const q = this.current();
		if (!q) return [];
		this.prune();
		const all = this.pending().length;
		const inner = Math.max(1, width - 4);
		const side = c.warning("│");
		const row = (line: string): string => `${side} ${truncateToWidth(line, inner, "…", true)} ${side}`;
		const title = truncateToWidth(all > 1 ? ` question 1 of ${all} ` : " question ", Math.max(1, width - 6));
		const top = `${c.warning("╭─")}${c.bold(c.warning(title))}${c.warning(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`)}`;

		const fields = q.fields?.length ? q.fields : undefined;
		const index = this.fieldIndex(q);
		const [origin = "", , ...cardText] = questionCard(this.app, q);
		const text = fields
			? [...q.question.split("\n").map((line) => c.dim(line)), "", c.bold(`field ${index + 1}/${fields.length}`), ...(fields[index]?.prompt ?? "").split("\n")]
			: cardText;
		const body = [origin];
		const wrapped = text.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, inner)));
		body.push(...wrapped.slice(0, MAX_TEXT_LINES));
		if (wrapped.length > MAX_TEXT_LINES) body.push(c.dim("…"));

		const options = this.options();
		if (options.length > 0) {
			body.push("");
			const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_OPTIONS / 2), options.length - MAX_OPTIONS));
			const end = Math.min(options.length, start + MAX_OPTIONS);
			if (start > 0) body.push(c.dim(`  ↑ ${start} more`));
			for (let i = start; i < end; i++) {
				const label = (options[i] ?? "").replace(/\s+/g, " ");
				body.push(i === this.selected ? c.bold(c.accent(`❯ ${label}`)) : `  ${label}`);
			}
			if (end < options.length) body.push(c.dim(`  ↓ ${options.length - end} more`));
		}
		const hint = options.length > 0 ? "Up/Down choose · Enter answer · or type your own answer below" : "type your answer below · Enter sends";
		const out = [top, ...body.map(row), row(c.dim(hint))];
		out.push(`${c.warning("╰")}${c.warning("─".repeat(Math.max(0, width - 2)))}${c.warning("╯")}`);
		return out;
	}
}
