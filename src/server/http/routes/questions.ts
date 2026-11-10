import { invalid, reqString } from "../json.js";
import { notFound, type Router } from "../router.js";

/** Pending `ask_user` questions and operator answers (409 when already answered). */
export function questionsRoutes(r: Router): void {
	r.on("GET", "/api/questions", async ({ host }) => host.questions.pending());

	r.on("POST", "/api/questions/:callId", async ({ host, params, body }) => {
		const callId = params.callId!;
		const b = await body();
		const answer = reqString(b, "answer");
		let conversationId = b.conversationId;
		if (conversationId !== undefined && (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId))) {
			throw invalid("conversationId must be an integer");
		}
		if (conversationId === undefined) {
			const pending = await host.questions.find(callId);
			if (!pending) throw notFound("question");
			conversationId = pending.conversationId;
		}
		await host.questions.answer(conversationId as number, callId, answer);
		return { ok: true };
	});
}
