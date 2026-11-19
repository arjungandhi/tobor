import type { CliArgs } from "../cli.js";
import { App } from "./app.js";
import { configPath, loadClientConfig, migrateLegacy, resolveStart, type Start, statePath } from "./workspaces.js";

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
		const app = new App(config, path, statePath());
		return await runUntilQuit(app, start, notice);
	} catch (err) {
		process.stderr.write(`tobor: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

/** Exit codes of a death by signal (128 + signal number). */
const SIGNAL_EXIT: Readonly<Record<"SIGHUP" | "SIGTERM", number>> = { SIGHUP: 129, SIGTERM: 143 };

/**
 * Run the app, with SIGHUP (terminal closed) and SIGTERM going through the normal quit path: pi-tui restores the terminal
 * from an 'exit' listener, which does not run when a signal kills the process by default.
 */
async function runUntilQuit(app: App, start: Start, notice: string | undefined): Promise<number> {
	const handlers = Object.entries(SIGNAL_EXIT).map(([signal, code]) => {
		const handler = (): void => {
			// A closed terminal can make the restore itself fail: leave anyway. Backstop if something keeps the loop alive.
			setTimeout(() => process.exit(code), 2000).unref();
			try {
				app.quit(code);
			} catch {
				process.exit(code);
			}
		};
		process.on(signal, handler);
		return [signal, handler] as const;
	});
	try {
		return await app.run(start, notice);
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}
