import { basename } from "node:path";
import type { ApprovalMode, SessionMode } from "../../api/types.js";
import type { App } from "../app.js";
import { parseNodeConfig, sessionDefaults } from "../node-config.js";
import { c } from "../theme.js";

const OTHER = "\0other";

const DEFAULT = c.accent("● ");

/** Ctrl+N: cwd (from /api/cwds), model, approval mode, mode, then the first prompt; opens the new session. Each picker starts on the node default from config.yml (marked ●), so Enter accepts it. */
export async function newSession(app: App, prompt?: string): Promise<void> {
	const client = app.api();
	const [cwds, models, config] = await Promise.all([client.cwds(), client.models(), client.file("config.yml")]);
	if (config.type !== "file") throw new Error("config.yml is a directory");
	const defaults = sessionDefaults(parseNodeConfig(config.content));
	const defaultModel = defaults.model ?? models.defaults.model;
	const mark = (value: string, preset: string): string => (value === preset ? DEFAULT : "  ");
	const dirs = [...new Set([...cwds.recent, ...cwds.roots])];
	const machine = app.whoami?.host ?? app.workspace?.name ?? "node";
	const cwdPick = await app.pick(
		"new session · working directory",
		[
			...dirs.map((dir) => ({ value: dir, label: `${basename(dir) || dir} @ ${machine}`, description: `${dir} · ${cwds.roots.includes(dir) ? "root" : "recent"}` })),
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

	const ordered = [...models.models].sort((a, b) => Number(b.ref === defaultModel) - Number(a.ref === defaultModel) || Number(b.available) - Number(a.available));
	const modelPick = await app.pick(
		"new session · model",
		ordered.map((m) => ({
			value: m.ref,
			label: `${mark(m.ref, defaultModel)}${m.ref}`,
			description: `${m.name}${m.ref === defaultModel ? " · default" : ""}${m.available ? "" : " · no credential"}`,
		})),
		{ selected: Math.max(0, ordered.findIndex((m) => m.ref === defaultModel)) },
	);
	if (!modelPick?.value) return;

	const approvals: { value: ApprovalMode; description: string }[] = [
		{ value: "ask", description: "bash, write, edit and other gated tools wait for you" },
		{ value: "auto", description: "tools run without asking" },
	];
	const approvalPick = await app.pick<ApprovalMode>(
		"new session · approval mode",
		approvals.map(({ value, description }) => ({ value, label: `${mark(value, defaults.approval_mode)}${value}`, description: `${description}${value === defaults.approval_mode ? " · default" : ""}` })),
		{ selected: approvals.findIndex((a) => a.value === defaults.approval_mode) },
	);
	if (!approvalPick?.value) return;
	if (approvalPick.value === "auto" && !(await app.confirmAuto("auto approval", "Tools will run without asking, with your full filesystem and shell access. Continue?"))) return;

	const modes: { value: SessionMode; description: string }[] = [
		{ value: "director", description: "plans and dispatches workers, then verifies" },
		{ value: "solo", description: "one agent does the work itself" },
	];
	const modePick = await app.pick<SessionMode>(
		"new session · mode",
		modes.map(({ value, description }) => ({ value, label: `${mark(value, defaults.mode)}${value}`, description: `${description}${value === defaults.mode ? " · default" : ""}` })),
		{ selected: modes.findIndex((m) => m.value === defaults.mode) },
	);
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
