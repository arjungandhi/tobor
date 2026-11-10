import type { CreateScheduleRequest, Schedule } from "../../api/types.js";
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

/** Schedules: list, n create, d delete, e enable/disable, Enter details with recent runs. */
export async function showSchedules(app: App): Promise<void> {
	const client = app.api();
	const schedules = await client.schedules();
	const picked = await app.pick(
		"schedules",
		schedules.map((s) => ({ value: s, label: `${s.enabled ? c.success("●") : c.dim("○")} ${s.name}`, description: describe(s) })),
		{ hint: "Enter details · n new · e enable/disable · d delete · Esc close", keys: ["n", "e", "d"] },
	);
	if (!picked) return;
	const s = picked.value;
	if (picked.key === "n") {
		await createSchedule(app);
		return showSchedules(app);
	}
	if (!s) return;
	if (picked.key === "e") {
		await client.updateSchedule(s.id, { enabled: !s.enabled });
		return showSchedules(app);
	}
	if (picked.key === "d") {
		if (await app.confirm(`delete ${s.name}`, [`Delete schedule “${s.name}”? Its pending fire is cancelled.`])) await client.deleteSchedule(s.id);
		return showSchedules(app);
	}
	await app.info(s.name, [
		c.muted(describe(s)),
		c.muted(`model ${s.model ?? "default"} · approval ${s.approval_mode ?? "ask"} · misfire grace ${s.misfire_grace ?? "2h"}`),
		"",
		c.gold("prompt"),
		...s.prompt.split("\n").map((line) => c.cream(line)),
		"",
		c.gold("runs"),
		...(s.runs.length === 0
			? [c.dim("none yet")]
			: s.runs
					.slice(-10)
					.reverse()
					.map((r) => `${new Date(r.fireAt).toLocaleString()}  ${r.status}${r.conversationId ? ` #${r.conversationId}` : ""}${r.notice ? c.dim(` ${r.notice}`) : ""}`)),
	]);
	return showSchedules(app);
}

async function createSchedule(app: App): Promise<void> {
	const name = await app.ask("new schedule · name");
	if (!name?.trim()) return;
	const timing = await app.ask("new schedule · when", {
		lines: [c.muted("a 5-field cron expression (`0 9 * * 1-5`) or a one-shot time (`2026-12-01T09:00`)")],
	});
	if (!timing?.trim()) return;
	const when = parseTiming(timing);
	const cwd = await app.ask("new schedule · working directory", { initial: app.session.detail?.cwd ?? (await app.api().cwds()).roots[0] ?? "" });
	if (!cwd?.trim()) return;
	const prompt = await app.ask("new schedule · prompt");
	if (!prompt?.trim()) return;
	const { id } = await app.api().createSchedule({ name: name.trim(), ...when, cwd: cwd.trim(), prompt: prompt.trim() });
	app.flash(`schedule ${name.trim()} created (${id})`);
}
