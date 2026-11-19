import type { ApprovalDecision, PendingApproval } from "../../api/types.js";
import type { App } from "../app.js";
import { ApiRequestError } from "../client.js";
import { argsSummary } from "../components/tool-slot.js";
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

/** Alt+Shift+A: pending approvals (open session first); pick one, then approve / approve for session / deny. `selected` is the list row to focus. */
export async function showApprovals(app: App, selected = 0): Promise<void> {
	await app.refreshApprovals();
	const current = app.session.target?.id;
	const pending = [...app.approvals].sort(
		(a, b) => Number(b.conversationId === current) - Number(a.conversationId === current) || a.createdAt - b.createdAt,
	);
	if (pending.length === 0) {
		app.flash("no pending approvals");
		return;
	}
	const at = Math.min(Math.max(selected, 0), pending.length - 1);
	let chosen: PendingApproval | undefined = pending[0];
	let decision: ApprovalDecision | undefined;
	if (pending.length > 1) {
		const picked = await app.pick(
			`approvals (${pending.length})`,
			pending.map((a) => ({ value: a, label: a.tool, description: `${origin(app, a)} · ${argsSummary(a.tool, a.args)}` })),
			{ hint: "Enter review · y approve · n deny · Esc close", keys: Object.keys(LIST_SHORTCUTS), selected: at },
		);
		chosen = picked?.value;
		decision = picked ? LIST_SHORTCUTS[picked.key] : undefined;
	}
	if (!chosen) return;
	if (!decision) {
		const picked = await app.pick(`approve ${chosen.tool}?`, DECISIONS, {
			lines: approvalCard(app, chosen),
			hint: "Enter choose · y/s/n shortcuts · Esc back",
			keys: Object.keys(SHORTCUTS),
		});
		if (!picked) return pending.length > 1 ? showApprovals(app, at) : undefined;
		decision = SHORTCUTS[picked.key] ?? picked.value;
	}
	if (!decision) return;
	try {
		await app.api().decide(chosen.callId, { decision, conversationId: chosen.conversationId });
		app.flash(`${decision.replace("_", " ")}: ${chosen.tool}`);
	} catch (err) {
		// Expired or decided elsewhere (404/409): drop the stale row and stay in the list instead of falling out to the transcript.
		const gone = err instanceof ApiRequestError && (err.status === 404 || err.status === 409);
		app.flash(gone ? `already resolved: ${chosen.tool}` : err instanceof Error ? err.message : String(err));
	}
	await app.refreshApprovals();
	// The decided row is gone, so the same index is the next pending item (clamped to the end).
	if (app.approvals.length > 0) await showApprovals(app, at);
}
