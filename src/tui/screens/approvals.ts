import type { ApprovalDecision, PendingApproval } from "../../api/types.js";
import type { App } from "../app.js";
import { ApiRequestError } from "../client.js";
import { argsSummary } from "../components/tool-slot.js";
import { navigate } from "../nav.js";
import { c } from "../theme.js";

function origin(app: App, a: PendingApproval): string {
	const title = app.sessions.find((s) => s.id === a.sessionId)?.title ?? "";
	return `#${a.sessionId}${title ? ` ${title}` : ""}${a.worker ? ` ▸ ${a.worker}` : ""}`;
}

function age(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** The card shown for one approval: tool, where it came from, expiry, and the arguments. */
export function approvalCard(app: App, a: PendingApproval): string[] {
	const now = app.now();
	const args = JSON.stringify(a.args, null, 2) ?? "";
	const argLines = args.split("\n");
	return [
		`${c.bold(c.accent(a.tool))}  ${c.dim(origin(app, a))}`,
		c.dim(`requested ${age(now - a.createdAt)} ago · auto-denied in ${age(a.expiresAt - now)} · call ${a.callId}`),
		"",
		...argLines.slice(0, 20),
		...(argLines.length > 20 ? [c.dim(`… ${argLines.length - 20} more lines`)] : []),
	];
}

const DECISIONS: { value: ApprovalDecision; label: string; description: string }[] = [
	{ value: "approve", label: "approve", description: "run this call" },
	{ value: "approve_session", label: "approve for session", description: "run it and stop asking for this tool in this conversation" },
	{ value: "deny", label: "deny", description: "block the call; the agent sees “Denied by operator”" },
];

const SHORTCUTS: Record<string, ApprovalDecision> = { y: "approve", s: "approve_session", n: "deny" };
/** The list decides without showing the full arguments, so it offers only the one-shot decisions; session-wide approval needs the review card. */
const LIST_SHORTCUTS: Record<string, ApprovalDecision> = { y: "approve", n: "deny" };

/** Open approvals, the open session's first. */
function pendingApprovals(app: App): PendingApproval[] {
	const current = app.session.target?.id;
	return [...app.approvals].sort(
		(a, b) => Number(b.conversationId === current) - Number(a.conversationId === current) || a.createdAt - b.createdAt,
	);
}

/** Alt+Shift+A: pending approvals (open session first); Enter reviews one (approve / approve for session / deny), y/n decide the highlighted row. */
export async function showApprovals(app: App): Promise<void> {
	await app.refreshApprovals();
	if (app.approvals.length === 0) {
		app.flash("no pending approvals");
		return;
	}
	await navigate<PendingApproval>(app, {
		view: () => {
			const pending = pendingApprovals(app);
			return {
				title: `approvals (${pending.length})`,
				items: pending.map((a) => ({ value: a, label: a.tool, description: `${origin(app, a)} · ${argsSummary(a.tool, a.args)}` })),
				hint: "Enter review · y approve · n deny · Esc back",
				keys: Object.keys(LIST_SHORTCUTS),
			};
		},
		key: (a) => a.callId,
		onPick: async (picked) => {
			const chosen = picked.value;
			if (!chosen) return "stay";
			let decision = LIST_SHORTCUTS[picked.key];
			if (!decision) {
				const card = await app.pick(`approve ${chosen.tool}?`, DECISIONS, {
					lines: approvalCard(app, chosen),
					hint: "Enter choose · y/s/n shortcuts · Esc back",
					keys: Object.keys(SHORTCUTS),
				});
				if (!card) return "stay";
				decision = SHORTCUTS[card.key] ?? card.value;
			}
			if (!decision) return "stay";
			try {
				await app.api().decide(chosen.callId, { decision, conversationId: chosen.conversationId });
				app.flash(`${decision.replace("_", " ")}: ${chosen.tool}`);
			} catch (err) {
				// Expired or decided elsewhere (404/409): drop the stale row and stay in the list instead of falling out to the transcript.
				const gone = err instanceof ApiRequestError && (err.status === 404 || err.status === 409);
				app.flash(gone ? `already resolved: ${chosen.tool}` : err instanceof Error ? err.message : String(err));
			}
			await app.refreshApprovals();
			// The decided row is gone, so the cursor (kept by navigate) lands on the next pending item.
			return app.approvals.length > 0 ? "refresh" : "close";
		},
	});
}
