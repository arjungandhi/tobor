import type { CreateScheduleRequest, Schedule, UpdateScheduleRequest } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

function describe(s: Schedule): string {
	const timing = s.cron ? `cron ${s.cron}` : `at ${s.at}`;
	const next = s.nextFireAt ? ` · next ${new Date(s.nextFireAt).toLocaleString()}` : "";
	const last = s.runs.at(-1);
	return `${timing} ${s.tz}${next}${last ? ` · last ${last.status}` : ""} · ${s.cwd}`;
}

/** Parse the timing answer: a 5-field cron expression, or anything else as a one-shot ISO time. */
export function parseTiming(input: string): Pick<CreateScheduleRequest, "cron" | "at"> {
	const text = input.trim();
	if (text.split(/\s+/).length === 5) return { cron: text };
	const at = new Date(text);
	if (Number.isNaN(at.getTime())) throw new Error(`not a 5-field cron expression or a date: ${text}`);
	return { at: at.toISOString() };
}

/** Schedules: list, n create, d delete, e enable/disable, Enter edit. */
export async function showSchedules(app: App, focus?: { id: string; index: number }): Promise<void> {
	const client = app.api();
	const schedules = await client.schedules();
	const picked = await app.pick(
		"schedules",
		schedules.map((s) => ({ value: s, label: `${s.enabled ? c.success("●") : c.dim("○")} ${s.name}`, description: describe(s) })),
		{ hint: "Enter edit · n new · e enable/disable · d delete · Esc close", keys: ["n", "e", "d"], selected: initialIndex(schedules, focus) },
	);
	if (!picked) return;
	const s = picked.value;
	if (picked.key === "n") {
		await createSchedule(app);
		return showSchedules(app);
	}
	if (!s) return;
	const at = { id: s.id, index: schedules.findIndex((x) => x.id === s.id) };
	if (picked.key === "e") {
		await client.updateSchedule(s.id, { enabled: !s.enabled });
		return showSchedules(app, at);
	}
	if (picked.key === "d") {
		if (await app.confirm(`delete ${s.name}`, [`Delete schedule “${s.name}”? Its pending fire is cancelled.`])) await client.deleteSchedule(s.id);
		return showSchedules(app, at);
	}
	return editSchedule(app, s.id);
}

export type ScheduleField = "name" | "timing" | "tz" | "cwd" | "prompt" | "model" | "approval_mode" | "misfire_grace";

/** One row of the schedule field editor: the field name and its current value (dim when defaulted or absent). */
export function fieldRows(s: Schedule): { field: ScheduleField; label: string; description: string }[] {
	const firstLine = s.prompt.split("\n")[0] ?? "";
	const prompt = firstLine.length > 60 || s.prompt.includes("\n") ? `${firstLine.slice(0, 60)}…` : firstLine;
	const next = s.nextFireAt ? ` · next ${new Date(s.nextFireAt).toLocaleString()}` : "";
	return [
		{ field: "name", label: "name", description: s.name },
		{ field: "timing", label: "timing", description: `${s.cron ? `cron ${s.cron}` : `at ${s.at}`}${next}` },
		{ field: "tz", label: "tz", description: s.tz },
		{ field: "cwd", label: "cwd", description: s.cwd },
		{ field: "prompt", label: "prompt", description: prompt || c.dim("unset") },
		{ field: "model", label: "model", description: s.model ?? c.dim("default") },
		{ field: "approval_mode", label: "approval mode", description: s.approval_mode ?? c.dim("ask (default)") },
		{ field: "misfire_grace", label: "misfire grace", description: s.misfire_grace ?? c.dim("2h (default)") },
	];
}

/** Field editor for one schedule: Enter edits the selected field, r runs, e enable/disable, d delete, Esc back to the list. */
async function editSchedule(app: App, id: string, selected = 0): Promise<void> {
	const client = app.api();
	const s = (await client.schedules()).find((x) => x.id === id);
	if (!s) return showSchedules(app);
	const rows = fieldRows(s);
	const picked = await app.pick(
		s.name,
		rows.map((r) => ({ value: r.field, label: r.label, description: r.description })),
		{
			lines: [c.dim(`${s.enabled ? "enabled" : "disabled"} · ${describe(s)}`)],
			hint: "Enter edit · r runs · e enable/disable · d delete · Esc back",
			keys: ["r", "e", "d"],
			selected,
		},
	);
	if (!picked) return showSchedules(app, { id, index: 0 });
	if (picked.key === "r") {
		await showRuns(app, s);
		return editSchedule(app, id, selected);
	}
	if (picked.key === "e") {
		await client.updateSchedule(s.id, { enabled: !s.enabled });
		return editSchedule(app, id, selected);
	}
	if (picked.key === "d") {
		if (await app.confirm(`delete ${s.name}`, [`Delete schedule “${s.name}”? Its pending fire is cancelled.`])) {
			await client.deleteSchedule(s.id);
			return showSchedules(app);
		}
		return editSchedule(app, id, selected);
	}
	if (!picked.value) return editSchedule(app, id, selected);
	const update = await promptField(app, s, picked.value);
	if (update) await client.updateSchedule(s.id, update);
	return editSchedule(app, id, rows.findIndex((r) => r.field === picked.value));
}

/** Ask for a new value for one field; undefined means leave it unchanged. */
async function promptField(app: App, s: Schedule, field: ScheduleField): Promise<UpdateScheduleRequest | undefined> {
	if (field === "approval_mode") {
		const mode = await app.pick(
			`${s.name} · approval mode`,
			(["ask", "auto"] as const).map((value) => ({ value, label: value })),
			{ selected: s.approval_mode === "auto" ? 1 : 0 },
		);
		return mode?.value ? { approval_mode: mode.value } : undefined;
	}
	if (field === "timing") {
		const answer = await app.ask(`${s.name} · when`, {
			initial: s.cron ?? s.at ?? "",
			lines: [c.dim("a 5-field cron expression (`0 9 * * 1-5`) or a one-shot time (`2026-12-01T09:00`)")],
		});
		return answer?.trim() ? parseTiming(answer) : undefined;
	}
	if (field === "model") {
		const answer = await app.ask(`${s.name} · model`, { initial: s.model ?? "", lines: [c.dim("provider/modelId")] });
		if (answer === undefined) return undefined;
		if (!answer.trim()) {
			app.flash("model unchanged — cannot be cleared");
			return undefined;
		}
		return { model: answer.trim() };
	}
	const initial = field === "name" ? s.name : field === "tz" ? s.tz : field === "cwd" ? s.cwd : field === "prompt" ? s.prompt : (s.misfire_grace ?? "");
	const answer = await app.ask(`${s.name} · ${field.replace("_", " ")}`, { initial });
	return answer?.trim() ? { [field]: answer.trim() } : undefined;
}

async function showRuns(app: App, s: Schedule): Promise<void> {
	await app.info(`${s.name} · runs`, [
		c.dim(describe(s)),
		"",
		...(s.runs.length === 0
			? [c.dim("none yet")]
			: s.runs
					.slice(-10)
					.reverse()
					.map((r) => `${new Date(r.fireAt).toLocaleString()}  ${r.status}${r.conversationId ? ` #${r.conversationId}` : ""}${r.notice ? c.dim(` ${r.notice}`) : ""}`)),
	]);
}

/** Cursor row: the schedule just acted on (or its nearest successor once it is gone), else the top. */
function initialIndex(schedules: Schedule[], focus?: { id: string; index: number }): number {
	if (!focus) return 0;
	const i = schedules.findIndex((s) => s.id === focus.id);
	return i >= 0 ? i : Math.max(0, Math.min(focus.index, schedules.length - 1));
}

async function createSchedule(app: App): Promise<void> {
	const name = await app.ask("new schedule · name");
	if (!name?.trim()) return;
	let when: Pick<CreateScheduleRequest, "cron" | "at">;
	for (let problem = "", initial = ""; ; ) {
		const timing = await app.ask("new schedule · when", {
			initial,
			lines: [c.dim("a 5-field cron expression (`0 9 * * 1-5`) or a one-shot time (`2026-12-01T09:00`)"), ...(problem ? [c.error(problem)] : [])],
		});
		if (!timing?.trim()) return;
		try {
			when = parseTiming(timing);
			break;
		} catch (err) {
			problem = (err as Error).message;
			initial = timing;
			app.flash(problem);
		}
	}
	const cwd = await app.ask("new schedule · working directory", { initial: app.session.detail?.cwd ?? (await app.api().cwds()).roots[0] ?? "" });
	if (!cwd?.trim()) return;
	const prompt = await app.ask("new schedule · prompt");
	if (!prompt?.trim()) return;
	const { id } = await app.api().createSchedule({ name: name.trim(), ...when, cwd: cwd.trim(), prompt: prompt.trim() });
	app.flash(`schedule ${name.trim()} created (${id})`);
}
