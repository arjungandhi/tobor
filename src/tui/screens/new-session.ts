import { basename } from "node:path";
import type { ImageAttachment } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

const OTHER = "\0other";

/** Roots are absolute; a recent cwd only starts a session when it sits inside one (the node rejects anything else). */
function inRoots(dir: string, roots: string[]): boolean {
	return roots.some((root) => dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));
}

/** The old cwd step, now an explicit override: recents + roots + "other…". Resolves undefined when cancelled. */
async function pickCwd(app: App, cwds: { roots: string[]; recent: string[] }): Promise<string | undefined> {
	const dirs = [...new Set([...cwds.recent, ...cwds.roots])];
	const machine = app.whoami?.host ?? app.workspace?.name ?? "node";
	const picked = await app.pick(
		"new session · working directory",
		[
			...dirs.map((dir) => ({ value: dir, label: `${basename(dir) || dir} @ ${machine}`, description: `${dir} · ${cwds.roots.includes(dir) ? "root" : "recent"}` })),
			{ value: OTHER, label: "other…", description: "type a path inside a root" },
		],
		{ lines: [c.dim(`roots limit where a session starts, not what the agent can touch · roots: ${cwds.roots.join(", ") || "none"}`)] },
	);
	if (!picked?.value) return undefined;
	if (picked.value !== OTHER) return picked.value;
	const typed = await app.ask("working directory", { initial: cwds.roots[0] ? `${cwds.roots[0]}/` : "", placeholder: "/absolute/path" });
	return typed?.trim() || undefined;
}

/**
 * Ctrl+N, /new, `n` in the sessions list, or a prompt typed with no session open: no wizard. Model, approval mode and
 * mode are left out of the request so the node applies its own defaults (config.yml, plus the project overlay).
 * The cwd is the most recent session's cwd that is still inside a root (`/api/cwds` `recent`), else the first root;
 * only when the node knows neither does the cwd picker appear. Creates the session, opens it, and flashes what was assumed.
 *
 * Without a prompt the session is still created (idle, no turns); with one, the node submits it immediately.
 * Resolves false only when the cwd picker was cancelled.
 * `{ pickCwd: true }` (for a future `/new <dir>` or deliberate picker) shows the cwd picker first; it then asks for the
 * first prompt too, as the chosen cwd could not be remembered otherwise.
 */
export async function startSession(app: App, prompt?: string, options: { pickCwd?: boolean; attachments?: ImageAttachment[] } = {}): Promise<boolean> {
	const cwds = await app.api().cwds();
	let cwd = options.pickCwd ? undefined : (cwds.recent.find((dir) => inRoots(dir, cwds.roots)) ?? cwds.roots[0]);
	let asked = false;
	if (!cwd) {
		cwd = await pickCwd(app, cwds);
		if (!cwd) return false;
		asked = true;
	}
	let text = prompt?.trim();
	const attachments = options.attachments?.length ? options.attachments : undefined;
	if (!text && asked && !attachments) {
		text = (await app.ask("new session · first prompt", { lines: [c.dim(cwd)] }))?.trim();
		if (!text) return false;
	}
	const { id } = await app.api().createSession({ cwd, ...(text || attachments ? { prompt: text ?? "" } : {}), ...(attachments ? { attachments } : {}) });
	await app.refreshSessions();
	app.openSession(id);
	app.flash(`new session #${id} · ${cwd}${text || attachments ? " · node defaults" : ""}`);
	return true;
}

/** `startSession` for callers that only need it to run (app.ts, session.ts). */
export async function newSession(app: App, prompt?: string, options: { pickCwd?: boolean } = {}): Promise<void> {
	await startSession(app, prompt, options);
}
