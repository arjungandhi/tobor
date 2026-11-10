import { wrapTool } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { createHashlineEditTool } from "./edit.js";
import { SnapshotStore } from "./hashline/snapshots.js";
import { createHashlineReadTool } from "./read.js";
import type { ToolModule } from "./registry.js";
import { writeWrapper } from "./write.js";

/** What the file tools share: `$TOBOR_HOME` (for the read deny rule) and the snapshot store. */
export interface FileToolDeps {
	home: string;
	store: SnapshotStore;
}

/** `read` and `edit` (hashline), and pi-durable's `write` wrapped to record snapshots. */
export function fileToolsModule(deps: { home: string; store?: SnapshotStore }): ToolModule {
	const shared: FileToolDeps = { home: deps.home, store: deps.store ?? new SnapshotStore() };
	const write = createWriteTool();
	return {
		tools: [createHashlineReadTool(shared), createHashlineEditTool(shared), write],
		wraps: [wrapTool(write, writeWrapper(shared))],
	};
}
