import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Schedule } from "../../../api/types.js";
import { SchedulesDoc } from "../../../docs.js";
import { HostError, type ScheduleService } from "../../../host.js";
import type { ToolModule } from "../../../tools/registry.js";
import type { ScheduleTask } from "./task.js";

/** Schedule tools the approval gate asks about in `ask` mode. */
export const SCHEDULE_GATED_TOOLS = ["schedule_create"] as const;

/** One line per schedule for the model. */
export function describeSchedule(s: Schedule): string {
	const when = s.cron !== undefined ? `cron "${s.cron}" ${s.tz}` : `at ${s.at} ${s.tz}`;
	const next = s.nextFireAt !== undefined ? `, next ${new Date(s.nextFireAt).toISOString()}` : "";
	const last = s.runs.at(-1);
	const lastText = last ? `, last ${last.status} ${new Date(last.fireAt).toISOString()}` : "";
	return `${s.id} ${JSON.stringify(s.name)}: ${when}${s.enabled ? "" : " (disabled)"}${next}${lastText} in ${s.cwd}`;
}

function failure(error: unknown) {
	const text = error instanceof HostError ? error.message : `failed: ${(error as Error).message}`;
	return { output: [{ type: "text" as const, text }], isError: true };
}

/** `schedule_create`, `schedule_list`, `schedule_delete` and the `tobor.schedule` task. `service` is read lazily. */
export function schedulesModule(task: ScheduleTask, service: () => ScheduleService): ToolModule {
	const create = defineTool({
		name: "schedule_create",
		description:
			"Schedule a prompt to run later in a fresh session: `cron` (5 fields) or `at` (ISO 8601), in `tz` " +
			"(default host zone). The session uses `cwd` (default this session's) and approval_mode ask.",
		parameters: obj({
			name: str(),
			prompt: str({ description: "Self-contained instructions for the run" }),
			cron: opt(str()),
			at: opt(str()),
			tz: opt(str({ description: "IANA zone, e.g. Europe/Berlin" })),
			cwd: opt(str()),
			model: opt(str({ description: "provider/modelId" })),
			approval_mode: opt(oneOf(["ask", "auto"] as const, { description: "auto is refused for agent-created schedules" })),
			misfire_grace: opt(str({ description: "Skip a fire missed by more than this, default 2h" })),
		}),
		async execute(args, api, context) {
			const cwd = args.cwd ?? (await api.agent(context)).cwd;
			if (!cwd) return failure(new HostError(400, "invalid", "cwd required"));
			try {
				const { id } = await service().create({ ...args, cwd }, { fromAgent: true });
				const created = await service().get(id);
				return { output: [{ type: "text", text: created ? describeSchedule(created) : id }], details: { id } };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const list = defineTool({
		name: "schedule_list",
		description: "List schedules with their next fire time and last run.",
		parameters: obj({}),
		replay: "safe",
		async execute() {
			const schedules = await service().list();
			const text = schedules.length === 0 ? "(no schedules)" : schedules.map(describeSchedule).join("\n");
			return { output: [{ type: "text", text }], details: { schedules } };
		},
	});

	const remove = defineTool({
		name: "schedule_delete",
		description: "Delete a schedule by id; runs already started are not affected.",
		parameters: obj({ id: str() }),
		async execute(args) {
			try {
				await service().delete(args.id);
				return { output: [{ type: "text", text: `deleted ${args.id}` }] };
			} catch (error) {
				return failure(error);
			}
		},
	});

	return { tools: [create, list, remove], tasks: [task], docs: [SchedulesDoc] };
}
