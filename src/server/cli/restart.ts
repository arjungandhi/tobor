import type { CliArgs } from "../../cli.js";
import { resolveNode, restartNode } from "./upgrade.js";

/** `tobor restart <workspace>`: restart a node over its API and wait for it to come back. */
export async function run(args: CliArgs): Promise<number> {
	const node = resolveNode(args.positionals[0]!);
	if (typeof node === "string") {
		process.stderr.write(`tobor restart: ${node}\n`);
		return 1;
	}
	return restartNode(node);
}
