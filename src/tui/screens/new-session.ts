import type { ApprovalMode, SessionMode } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

const OTHER = "\0other";

/** Ctrl+N: cwd (from /api/cwds), model, approval mode, mode, then the first prompt; opens the new session. */
export async function newSession(app: App, prompt?: string): Promise<void> {
	const client = app.api();
	const [cwds, models] = await Promise.all([client.cwds(), client.models()]);
	const dirs = [...new Set([...cwds.recent, ...cwds.roots])];
	const cwdPick = await app.pick(
		"new session · working directory",
		[
			...dirs.map((dir) => ({ value: dir, label: dir, description: cwds.roots.includes(dir) ? "root" : "recent" })),
			{ value: OTHER, label: "other…", description: "type a path inside a root" },
		],
		{ lines: [c.dim(`roots limit where a session starts, not what the agent can touch · roots: ${cwds.roots.join(", ") || "none"}`)] },
	);
	if (!cwdPick?.value) return;
	let cwd = cwdPick.value;
	if (cwd === OTHER) {
		const typed = await app.ask("working directory", { initial: cwds.roots[0] ? `${cwds.roots[0]}/` : "", placeholder: "/absolute/path" });
		if (!typed?.trim()) return;
		cwd = typed.trim();
	}

	const ordered = [...models.models].sort((a, b) => Number(b.ref === models.defaults.model) - Number(a.ref === models.defaults.model) || Number(b.available) - Number(a.available));
	const modelPick = await app.pick(
		"new session · model",
		ordered.map((m) => ({
			value: m.ref,
			label: `${m.ref === models.defaults.model ? c.accent("● ") : "  "}${m.ref}`,
			description: `${m.name}${m.available ? "" : " · no credential"}`,
		})),
	);
	if (!modelPick?.value) return;

	const approvalPick = await app.pick<ApprovalMode>("new session · approval mode", [
		{ value: "ask", label: "ask", description: "bash, write, edit and other gated tools wait for you" },
		{ value: "auto", label: "auto", description: "tools run without asking" },
	]);
	if (!approvalPick?.value) return;
	if (approvalPick.value === "auto" && !(await app.confirm("auto approval", ["Tools will run without asking, with your full filesystem and shell access. Continue?"]))) return;

	const modePick = await app.pick<SessionMode>("new session · mode", [
		{ value: "director", label: "director", description: "plans and dispatches workers, then verifies" },
		{ value: "solo", label: "solo", description: "one agent does the work itself" },
	]);
	if (!modePick?.value) return;

	const text = prompt ?? (await app.ask("new session · first prompt", { lines: [c.dim(`${cwd} · ${modelPick.value} · ${approvalPick.value} · ${modePick.value}`)] }));
	if (!text?.trim()) return;
	const { id } = await client.createSession({
		cwd,
		model: modelPick.value,
		approval_mode: approvalPick.value,
		mode: modePick.value,
		prompt: text.trim(),
	});
	await app.refreshSessions();
	app.openSession(id);
}
