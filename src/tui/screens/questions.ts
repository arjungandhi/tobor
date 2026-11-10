import type { PendingQuestion } from "../../api/types.js";
import type { App } from "../app.js";
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

/** The card shown for one question: where it came from, expiry, and the question text. */
export function questionCard(app: App, q: PendingQuestion): string[] {
	const now = app.whoami?.now ?? Date.now();
	return [
		c.dim(`${origin(app, q)} · asked ${age(now - q.createdAt)} ago · gives up in ${age(q.expiresAt - now)}`),
		"",
		...q.question.split("\n"),
	];
}

/** Alt+Shift+U: questions the agent asked (open session first); pick one, then choose an option or type an answer. */
export async function showQuestions(app: App): Promise<void> {
	await app.refreshQuestions();
	const current = app.session.target?.id;
	const pending = [...app.questions].sort(
		(a, b) => Number(b.conversationId === current) - Number(a.conversationId === current) || a.createdAt - b.createdAt,
	);
	if (pending.length === 0) {
		app.flash("no pending questions");
		return;
	}
	let chosen: PendingQuestion | undefined = pending[0];
	if (pending.length > 1) {
		const picked = await app.pick(
			`questions (${pending.length})`,
			pending.map((q) => ({ value: q, label: q.question.replace(/\s+/g, " ").slice(0, 80), description: origin(app, q) })),
			{ hint: "Enter answer · Esc close" },
		);
		chosen = picked?.value;
	}
	if (!chosen) return;
	const back = () => (pending.length > 1 ? showQuestions(app) : undefined);

	let answer: string | undefined;
	if (chosen.options?.length) {
		const picked = await app.pick<string | typeof OTHER>(
			"question",
			[...chosen.options.map((o) => ({ value: o, label: o })), { value: OTHER, label: "other…", description: "type your own answer" }],
			{ lines: questionCard(app, chosen), hint: "Enter choose · Esc back" },
		);
		if (!picked) return back();
		if (picked.value !== OTHER) answer = picked.value;
	}
	if (answer === undefined) {
		answer = (await app.ask("answer", { lines: questionCard(app, chosen), hint: "Enter send · Esc back" }))?.trim();
		if (answer === undefined) return back();
		if (answer === "") {
			app.flash("empty answer not sent");
			return showQuestions(app);
		}
	}
	await app.api().answer(chosen.callId, { answer, conversationId: chosen.conversationId });
	app.flash(`answered: ${answer.length > 40 ? `${answer.slice(0, 39)}…` : answer}`);
	await app.refreshQuestions();
	if (app.questions.length > 0) await showQuestions(app);
}
