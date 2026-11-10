import type { CreateScheduleRequest, UpdateScheduleRequest } from "../../../api/types.js";
import { APPROVAL_MODES } from "../../../config/schema.js";
import { optBool, optEnum, optString, reqString } from "../json.js";
import { notFound, Reply, type Router } from "../router.js";

/** Schedule CRUD. */
export function schedulesRoutes(r: Router): void {
	r.on("GET", "/api/schedules", async ({ host }) => host.schedules.list());

	r.on("POST", "/api/schedules", async ({ host, body }) => {
		const b = await body();
		const request: CreateScheduleRequest = { ...fields(b), name: reqString(b, "name"), cwd: reqString(b, "cwd"), prompt: reqString(b, "prompt") };
		return new Reply(201, await host.schedules.create(request));
	});

	r.on("GET", "/api/schedules/:id", async ({ host, params }) => {
		const schedule = await host.schedules.get(params.id!);
		if (!schedule) throw notFound("schedule");
		return schedule;
	});

	r.on("PUT", "/api/schedules/:id", async ({ host, params, body }) => host.schedules.update(params.id!, fields(await body())));

	r.on("DELETE", "/api/schedules/:id", async ({ host, params }) => {
		await host.schedules.delete(params.id!);
		return { ok: true };
	});
}

function fields(b: Record<string, unknown>): UpdateScheduleRequest {
	const out: UpdateScheduleRequest = {};
	for (const key of ["name", "cron", "at", "tz", "cwd", "prompt", "model", "misfire_grace"] as const) {
		const v = optString(b, key);
		if (v !== undefined) out[key] = v;
	}
	const approvalMode = optEnum(b, "approval_mode", APPROVAL_MODES);
	if (approvalMode !== undefined) out.approval_mode = approvalMode;
	const enabled = optBool(b, "enabled");
	if (enabled !== undefined) out.enabled = enabled;
	return out;
}
