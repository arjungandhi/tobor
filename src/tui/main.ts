import type { CliArgs } from "../cli.js";
import { App } from "./app.js";
import { configPath, loadClientConfig, migrateLegacy, resolveStart, statePath } from "./workspaces.js";

/** `tobor [workspace|host:port]`: open the named workspace, else `TOBOR_WORKSPACE`, else the workspace picker. */
export async function run(args: CliArgs): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("tobor: the TUI needs an interactive terminal\n");
		return 2;
	}
	try {
		const notice = migrateLegacy();
		const path = configPath();
		const config = loadClientConfig(path);
		const start = resolveStart(config, args.positionals[0]);
		return await new App(config, path, statePath()).run(start, notice);
	} catch (err) {
		process.stderr.write(`tobor: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
