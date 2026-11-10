import type { CliArgs } from "../../cli.js";
import { formatListen } from "../../config/load.js";
import { boot, type NodePlugins } from "../harness/boot.js";

/** Modules, services and listeners plugged into `tobor node`. */
export const plugins: NodePlugins = { modules: [] };

/** `tobor node`: boot the node, start the listeners and serve until SIGTERM/SIGINT. */
export async function run(args: CliArgs): Promise<number> {
	const host = await boot({ home: args.home, plugins });
	const stopListeners = (await plugins.listen?.(host)) ?? (async () => {});
	process.stdout.write(
		`tobor node: home ${args.home}, system conversation ${host.systemConversationId}, api ${formatListen(host.config.listen)}\n`,
	);
	const exit = Promise.withResolvers<number>();
	const onSignal = async (signal: NodeJS.Signals) => {
		process.stdout.write(`tobor node: ${signal}, shutting down\n`);
		await stopListeners().catch((err: unknown) => process.stderr.write(`tobor node: stopping listeners: ${String(err)}\n`));
		if ((await host.shutdown()) === "left_open") process.stdout.write("tobor node: approvals pending; exiting without close\n");
		exit.resolve(0);
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	void host.harness.closed.then((end) => {
		if (end.kind !== "failed") return;
		process.stderr.write(`tobor node: storage failed: ${String(end.error)}\n`);
		exit.resolve(1);
	});
	process.exit(await exit.promise);
}
