import type { PendingQuestion, QuestionField } from "../../api/types.js";
import type { App } from "../app.js";
import { ApiRequestError } from "../client.js";
import { navigate } from "../nav.js";
import { c } from "../theme.js";

const OTHER = Symbol("other");

function origin(app: App, q: PendingQuestion): string {
	const title = app.sessions.find((s) => s.id === q.sessionId)?.title ?? "";
	return `#${q.sessionId}${title ? ` ${title}` : ""}${q.worker ? ` ▸ ${q.worker}` : ""}`;
}

function age(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** The card shown for one question: where it came from, expiry, and the question text (a form lists its fields). */
export function questionCard(app: App, q: PendingQuestion): string[] {
	const now = app.now();
	const fields = q.fields ?? [];
	return [
		c.dim(`${origin(app, q)} · asked ${age(now - q.createdAt)} ago · gives up in ${age(q.expiresAt - now)}`),
		"",
		...q.question.split("\n"),
		...(fields.length > 0 ? ["", ...fields.map((f, i) => `${i + 1}. ${f.prompt.replace(/\s+/g, " ")}`)] : []),
	];
}

/** The card for one field of a form: the header, progress, and that field's prompt. */
function fieldCard(app: App, q: PendingQuestion, index: number, field: QuestionField): string[] {
	const [originLine = ""] = questionCard(app, q);
	return [originLine, "", ...q.question.split("\n").map((l) => c.dim(l)), "", c.bold(`field ${index + 1}/${q.fields?.length ?? 1}`), ...field.prompt.split("\n")];
}

/** Ask one field of a form; "" when skipped, undefined when the user stepped back (Esc). `previous` is the answer given on an earlier pass. */
async function askField(app: App, q: PendingQuestion, index: number, field: QuestionField, previous?: string): Promise<string | undefined> {
	const lines = fieldCard(app, q, index, field);
	const hint = index === 0 ? "Esc back" : "Esc previous field";
	const options = field.options ?? [];
	if (options.length) {
		const at = previous === undefined ? -1 : options.indexOf(previous);
		const picked = await app.pick<string | typeof OTHER>(
			"question",
			[...options.map((o) => ({ value: o, label: o })), { value: OTHER, label: "other…", description: "type your own answer" }],
			{ lines, hint: `Enter choose · ${hint}`, ...(at >= 0 ? { selected: at } : previous ? { selected: options.length } : {}) },
		);
		if (!picked) return undefined;
		if (picked.value !== OTHER) return picked.value;
	}
	return (await app.ask("answer", { lines, hint: `Enter next · empty skips · ${hint}`, ...(previous && !options.includes(previous) ? { initial: previous } : {}) }))?.trim();
}

/** Walk a form field by field; Esc steps back one field and leaves the form (undefined) only from the first. */
async function askForm(app: App, q: PendingQuestion, fields: QuestionField[]): Promise<string[] | undefined> {
	const answers: string[] = [];
	for (let i = 0; i < fields.length; ) {
		const answer = await askField(app, q, i, fields[i]!, answers[i]);
		if (answer === undefined) {
			if (i === 0) return undefined;
			i--;
			continue;
		}
		answers[i] = answer;
		i++;
	}
	return answers;
}

/** Alt+Shift+U: questions the agent asked (open session first); pick one, then choose an option or type an answer. */
export async function showQuestions(app: App): Promise<void> {
	await app.refreshQuestions();
	if (app.questions.length === 0) {
		app.flash("no pending questions");
		return;
	}
	await navigate<PendingQuestion>(app, {
		view: () => {
			const current = app.session.target?.id;
			const pending = [...app.questions].sort(
				(a, b) => Number(b.conversationId === current) - Number(a.conversationId === current) || a.createdAt - b.createdAt,
			);
			return {
				title: `questions (${pending.length})`,
				items: pending.map((q) => ({ value: q, label: q.question.replace(/\s+/g, " ").slice(0, 80), description: origin(app, q) })),
				hint: "Enter answer · Esc back",
			};
		},
		key: (q) => q.callId,
		onPick: async (picked) => {
			const chosen = picked.value;
			if (!chosen) return "stay";
			const body = await collectAnswer(app, chosen);
			if (!body) return "stay"; // cancelled or empty: nothing is submitted
			try {
				await app.api().answer(chosen.callId, { ...body.request, conversationId: chosen.conversationId });
				app.flash(body.done);
			} catch (err) {
				// Expired or answered elsewhere (404/409): drop the stale row and stay in the list.
				const gone = err instanceof ApiRequestError && (err.status === 404 || err.status === 409);
				app.flash(gone ? "already resolved" : err instanceof Error ? err.message : String(err));
			}
			await app.refreshQuestions();
			return app.questions.length > 0 ? "refresh" : "close";
		},
	});
}

/** Gather the answer to one question (form, option pick or free text); undefined when the user backed out or sent nothing. */
async function collectAnswer(app: App, q: PendingQuestion): Promise<{ request: { answer: string } | { answers: string[] }; done: string } | undefined> {
	if (q.fields?.length) {
		const answers = await askForm(app, q, q.fields);
		if (!answers) return undefined;
		if (answers.every((a) => a === "")) {
			app.flash("empty answers not sent");
			return undefined;
		}
		return { request: { answers }, done: `answered ${answers.length} fields` };
	}
	let answer: string | undefined;
	if (q.options?.length) {
		const picked = await app.pick<string | typeof OTHER>(
			"question",
			[...q.options.map((o) => ({ value: o, label: o })), { value: OTHER, label: "other…", description: "type your own answer" }],
			{ lines: questionCard(app, q), hint: "Enter choose · Esc back" },
		);
		if (!picked) return undefined;
		if (picked.value !== OTHER) answer = picked.value;
	}
	if (answer === undefined) {
		answer = (await app.ask("answer", { lines: questionCard(app, q), hint: "Enter send · Esc back" }))?.trim();
		if (answer === undefined) return undefined;
		if (answer === "") {
			app.flash("empty answer not sent");
			return undefined;
		}
	}
	return { request: { answer }, done: `answered: ${answer.length > 40 ? `${answer.slice(0, 39)}…` : answer}` };
}
