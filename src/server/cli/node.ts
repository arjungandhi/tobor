import type { CliArgs } from "../../cli.js";
import { formatListen } from "../../config/load.js";
import { boot } from "../harness/boot.js";
import { buildPlugins } from "../plugins.js";

/** `tobor node`: boot the node, start the listeners and serve until SIGTERM/SIGINT. */
export async function run(args: CliArgs): Promise<number> {
	const built = await buildPlugins(args.home);
	const host = await boot({ home: args.home, plugins: built.plugins });
	const stopListeners = (await built.plugins.listen?.(host)) ?? (async () => {});
	const { api, artifacts } = built.addresses();
	process.stdout.write(
		[
			`tobor node: home ${args.home}, system conversation ${host.systemConversationId}`,
			`  api        http://${api ? formatListen(api) : "-"} (${host.config.public_url})`,
			`  artifacts  http://${artifacts ? formatListen(artifacts) : "-"} (${host.config.artifacts_url})`,
			"",
		].join("\n"),
	);
	const exit = Promise.withResolvers<number>();
	const keepAlive = setInterval(() => {}, 1 << 30);
	const onSignal = async (signal: NodeJS.Signals) => {
		process.stdout.write(`tobor node: ${signal}, shutting down\n`);
		await stopListeners().catch((err: unknown) => process.stderr.write(`tobor node: stopping listeners: ${String(err)}\n`));
		await built.stop().catch((err: unknown) => process.stderr.write(`tobor node: stopping .tobor watcher: ${String(err)}\n`));
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
	const code = await exit.promise;
	clearInterval(keepAlive);
	process.exit(code);
}
