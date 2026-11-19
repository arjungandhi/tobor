import type { SessionState, SessionSummary } from "../../api/types.js";
import type { App } from "../app.js";
import { navigate } from "../nav.js";
import { c } from "../theme.js";
import { startSession } from "./new-session.js";
import { showSchedules } from "./schedules.js";
import { showWorkspaces } from "./workspaces.js";

const STATE: Record<SessionState, (text: string) => string> = {
	idle: c.dim,
	running: c.accent,
	waiting: c.warning,
	failed: c.error,
	working: c.tool,
};

function when(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

/**
 * Ctrl+L: sessions with state tag and cost; Enter/→ opens, n new, r rename, a archive/unarchive, d delete, h archived, s schedules.
 * One tier of the hierarchy workspaces → sessions → session: Esc/← always goes up (to the workspace picker, from the
 * archived view to the active list), however the list was opened.
 */
export async function showSessions(app: App, archived = false): Promise<void> {
	const result = await sessionsTier(app, archived);
	if (result === "up") return archived ? showSessions(app, false) : showWorkspaces(app);
}

/** One sessions list as a `navigate` loop. Resolves "up" when the user went up a tier, "done" when a session was opened (or started). */
async function sessionsTier(app: App, archived: boolean): Promise<"up" | "done"> {
	const client = app.api();
	let opened = false;
	await navigate<SessionSummary>(app, {
		view: async () => {
			const sessions = archived ? (await client.sessions(true)).filter((s) => s.archived) : await client.sessions();
			if (!archived) app.sessions = sessions;
			const now = app.now();
			const open = app.session.target?.id ?? app.lastSessionId();
			return {
				title: archived ? "archived sessions" : `sessions on ${app.workspace?.name ?? ""}`,
				items: sessions.map((s) => ({
					value: s,
					label: `${STATE[s.state](`[${s.state}]`.padEnd(9))} #${s.id} ${s.title}`,
					description: `$${s.usage.cost.toFixed(3)}${s.pending ? ` · ⚠ ${s.pending}` : ""} · ${s.kind === "schedule" ? "scheduled · " : ""}${s.mode} · ${when(s.updatedAt, now)} · ${s.cwd}`,
				})),
				hint: `→/Enter open · n new · r rename · a ${archived ? "unarchive" : "archive"} · d delete · s schedules · h ${archived ? "active" : "archived"} · ${archived ? "←/Esc back" : "← workspaces · Esc back"}`,
				emptyHint: `n new · s schedules · h ${archived ? "active" : "archived"} · ←/Esc back`,
				keys: ["n", "r", "a", "d", "s", "h", "left", "right"],
				commands: true,
				initial: open === undefined ? undefined : String(open),
			};
		},
		key: (s) => String(s.id),
		onPick: async (picked) => {
			const s = picked.value;
			const current = app.session.target?.id;
			if (picked.key === "left") return "up";
			if (picked.command === "sessions") return archived ? "close" : "refresh";
			if (picked.command && picked.command !== "new") {
				// Like a composer command run through `app.guard`: an error flashes, and the list comes back. The list is
				// opened inside an exclusive flow (hotkey, Esc or /sessions), so the command continues that flow.
				// Session-scoped commands act on the highlighted row, not on the open session.
				await app.continueCommand(`/${picked.command}`, { sessionId: s?.id });
				return "refresh";
			}
			switch (picked.command ? "n" : picked.key) {
				case "n": {
					// Cancelled the cwd fallback picker with nothing started: stay on this level of the hierarchy.
					opened = await startSession(app);
					return opened ? "close" : "stay";
				}
				case "s":
					await showSchedules(app);
					return "refresh";
				case "h": {
					if (archived) return "close";
					const inner = await sessionsTier(app, true);
					opened = inner === "done";
					return opened ? "close" : "refresh";
				}
				case "enter":
				case "right":
					if (!s) return "stay";
					app.openSession(s.id);
					opened = true;
					return "close";
			}
			if (!s) return "stay";
			if (picked.key === "r") {
				const title = await app.ask(`rename #${s.id}`, { initial: s.title });
				if (!title?.trim()) return "stay";
				await client.patchSession(s.id, { title: title.trim() });
			} else if (picked.key === "a") {
				await client.patchSession(s.id, { archived: !archived });
				if (s.id === current) app.session.close();
			} else if (picked.key === "d") {
				if (!(await app.confirm(`delete #${s.id}`, [`Delete “${s.title}”? This aborts it and removes it from the list.`]))) return "stay";
				await client.deleteSession(s.id);
				if (s.id === current) app.session.close();
			}
			await app.refreshSessions();
			return "refresh";
		},
	});
	return opened ? "done" : "up";
}
