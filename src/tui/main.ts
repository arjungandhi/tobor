import type { CliArgs } from "../cli.js";
import { App } from "./app.js";
import { configPath, loadClientConfig, migrateLegacy, resolveStart, statePath } from "./workspaces.js";

/** `tobor [workspace|host:port]`: open the named workspace, else `TOBOR_WORKSPACE`, else the workspace picker. */
export async function run(args: CliArgs): Promise<number> {
	const notice = migrateLegacy();
	const path = configPath();
	const config = loadClientConfig(path);
	const start = resolveStart(config, args.positionals[0]);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("tobor: the TUI needs an interactive terminal\n");
		return 2;
	}
	return new App(config, path, statePath()).run(start, notice);
}
