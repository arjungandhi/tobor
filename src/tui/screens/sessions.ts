import type { SessionState, SessionSummary } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";
import { newSession } from "./new-session.js";
import { showWorkspaces } from "./workspaces.js";

const STATE: Record<SessionState, (text: string) => string> = {
	idle: c.dim,
	running: c.accent,
	waiting: c.warning,
	failed: c.error,
};

function when(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

/**
 * Ctrl+L: sessions with state tag and cost; Enter opens, n new, r rename, a archive/unarchive, x delete, h archived.
 * `nav` is the Esc meaning: "close" (mid-session: back to where you were) or "up" (the hierarchy workspace → sessions →
 * session: startup, or Esc from an idle session; Esc goes back to the workspace picker, from the archived view to the
 * active list).
 */
export async function showSessions(app: App, archived = false, focus?: { id: number; index: number }, nav: "close" | "up" = "close"): Promise<void> {
	const client = app.api();
	const sessions = archived ? (await client.sessions(true)).filter((s) => s.archived) : await client.sessions();
	if (!archived) app.sessions = sessions;
	const now = app.whoami?.now ?? Date.now();
	const items = sessions.map((s: SessionSummary) => ({
		value: s,
		label: `${STATE[s.state](`[${s.state}]`.padEnd(9))} #${s.id} ${s.title}`,
		description: `$${s.usage.cost.toFixed(3)}${s.pending ? ` · ⚠ ${s.pending}` : ""} · ${s.kind === "schedule" ? "scheduled · " : ""}${s.mode} · ${when(s.updatedAt, now)} · ${s.cwd}`,
	}));
	const current = app.session.target?.id;
	const picked = await app.pick(archived ? "archived sessions" : `sessions on ${app.workspace?.name ?? ""}`, items, {
		hint: `Enter open · n new · r rename · a ${archived ? "unarchive" : "archive"} · x delete · h ${archived ? "active" : "archived"} · Esc ${nav === "up" ? "back" : "close"}`,
		keys: ["n", "r", "a", "x", "h"],
		selected: initialIndex(sessions, current ?? app.lastSessionId(), focus),
	});
	if (!picked) {
		if (nav !== "up") return;
		return archived ? showSessions(app, false, undefined, nav) : showWorkspaces(app, "switch", undefined, true);
	}
	const s = picked.value;
	switch (picked.key) {
		case "n": {
			await newSession(app);
			// Cancelled out of the wizard with nothing opened: stay on this level of the hierarchy.
			if (nav === "up" && app.session.target?.id === current) return showSessions(app, archived, undefined, nav);
			return;
		}
		case "h":
			return showSessions(app, !archived, undefined, nav);
		case "enter":
			if (s) app.openSession(s.id);
			return;
	}
	if (!s) return showSessions(app, archived, undefined, nav);
	const at = { id: s.id, index: sessions.findIndex((x) => x.id === s.id) };
	if (picked.key === "r") {
		const title = await app.ask(`rename #${s.id}`, { initial: s.title });
		if (title?.trim()) await client.patchSession(s.id, { title: title.trim() });
	} else if (picked.key === "a") {
		await client.patchSession(s.id, { archived: !archived });
		if (s.id === current) app.session.close();
	} else if (picked.key === "x") {
		if (await app.confirm(`delete #${s.id}`, [`Delete “${s.title}”? This aborts it and removes it from the list.`])) {
			await client.deleteSession(s.id);
			if (s.id === current) app.session.close();
		}
	}
	await app.refreshSessions();
	return showSessions(app, archived, at, nav);
}

/** Cursor row: the row just acted on (or its nearest successor once it is gone), else the open (or last opened) session, else the top. */
function initialIndex(sessions: SessionSummary[], current: number | undefined, focus?: { id: number; index: number }): number {
	if (focus) {
		const i = sessions.findIndex((s) => s.id === focus.id);
		return i >= 0 ? i : Math.max(0, Math.min(focus.index, sessions.length - 1));
	}
	return Math.max(0, sessions.findIndex((s) => s.id === current));
}
