// The node's tool modules in composition order (also prompt section order, after the core module).
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { type ArtifactsDeps, artifactsModule } from "../artifacts/tools.js";
import type { Schedules } from "../server/harness/schedules/service.js";
import { schedulesModule } from "../server/harness/schedules/tools.js";
import { todoModule } from "../server/harness/todo/tool.js";
import { type WorkerHost, workersModule } from "../server/harness/workers/tools.js";
import { fileToolsModule } from "./filetools.js";
import type { Tool, ToolModule } from "./registry.js";

/** `bash` timeout (seconds) when the model gives none. */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 600;

/** pi-durable's `bash` with a default timeout of `BASH_DEFAULT_TIMEOUT_SECONDS`. */
export function bashTool(): Tool {
	const bash = createBashTool();
	return {
		...bash,
		prepareArguments: (args: unknown) =>
			(typeof args === "object" && args !== null && !Array.isArray(args) && !("timeout" in args)
				? { ...args, timeout: BASH_DEFAULT_TIMEOUT_SECONDS }
				: args) as never,
	};
}

/** What the built-in tool modules need; `workers` is read lazily (the Harness opens after composition). */
export type ToolDeps = {
	home: string;
	artifacts: ArtifactsDeps;
	workers: () => WorkerHost;
	schedules: Schedules;
};

/** Every built-in module: shell, file tools, todo, artifacts, workers, schedules. MCP tools are added on reload. */
export function toolModules(deps: ToolDeps): ToolModule[] {
	return [
		{ tools: [bashTool()] },
		fileToolsModule({ home: deps.home }),
		todoModule,
		artifactsModule(deps.artifacts),
		workersModule(deps.workers),
		schedulesModule(deps.schedules.task, () => deps.schedules),
	];
}
