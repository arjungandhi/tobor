import type { ApprovalDecision } from "../../../api/types.js";
import { invalid, reqEnum } from "../json.js";
import { notFound, type Router } from "../router.js";

const DECISIONS: readonly ApprovalDecision[] = ["approve", "approve_session", "deny"];

/** Pending approvals and decisions (409 when already decided). */
export function approvalsRoutes(r: Router): void {
	r.on("GET", "/api/approvals", async ({ host }) => host.approvals.pending());

	r.on("POST", "/api/approvals/:callId", async ({ host, params, body }) => {
		const callId = params.callId!;
		const b = await body();
		const decision = reqEnum(b, "decision", DECISIONS);
		let conversationId = b.conversationId;
		if (conversationId !== undefined && (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId))) {
			throw invalid("conversationId must be an integer");
		}
		if (conversationId === undefined) {
			const pending = await host.approvals.find(callId);
			if (!pending) throw notFound("approval");
			conversationId = pending.conversationId;
		}
		await host.approvals.decide(conversationId as number, callId, decision);
		return { ok: true };
	});
}
