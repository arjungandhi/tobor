import type { CliArgs } from "../cli.js";
import { App } from "./app.js";
import { activeContext, addOrSelect, loadContexts, saveContexts, tuiConfigPath } from "./contexts.js";

/** `tobor tui [host:port]`: add/select `host:port` as the active context (saved in tui.json), then run the TUI. */
export async function run(args: CliArgs): Promise<number> {
	const path = tuiConfigPath();
	let config = loadContexts(path);
	const target = args.positionals[0];
	if (target !== undefined) {
		config = addOrSelect(config, target);
		saveContexts(path, config);
	}
	if (!activeContext(config)) {
		process.stderr.write(`tobor tui: no saved host; run \`tobor tui <host:port>\` once (contexts live in ${path})\n`);
		return 2;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("tobor tui: needs an interactive terminal\n");
		return 2;
	}
	return new App(config, path).run();
}
