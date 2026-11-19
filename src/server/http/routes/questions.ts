import { invalid, reqString } from "../json.js";
import { notFound, type Router } from "../router.js";

/** Pending `ask_user` questions and operator answers (409 when already answered). */
export function questionsRoutes(r: Router): void {
	r.on("GET", "/api/questions", async ({ host }) => host.questions.pending());

	r.on("POST", "/api/questions/:callId", async ({ host, params, body }) => {
		const callId = params.callId!;
		const b = await body();
		if ((b.answer === undefined) === (b.answers === undefined)) throw invalid("provide exactly one of answer or answers");
		let reply: { text?: string; answers?: string[] };
		if (b.answers !== undefined) {
			if (!Array.isArray(b.answers) || b.answers.length === 0 || b.answers.some((a) => typeof a !== "string")) {
				throw invalid("answers must be a non-empty array of strings");
			}
			const answers = (b.answers as string[]).map((a) => a.trim());
			if (answers.every((a) => a === "")) throw invalid("at least one answer must be non-empty");
			reply = { answers };
		} else {
			const text = reqString(b, "answer").trim();
			if (text === "") throw invalid("answer must be a non-empty string");
			reply = { text };
		}
		let conversationId = b.conversationId;
		if (conversationId !== undefined && (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId))) {
			throw invalid("conversationId must be an integer");
		}
		if (conversationId === undefined) {
			const pending = await host.questions.find(callId);
			if (!pending) throw notFound("question");
			conversationId = pending.conversationId;
		}
		await host.questions.answer(conversationId as number, callId, reply);
		return { ok: true };
	});
}
