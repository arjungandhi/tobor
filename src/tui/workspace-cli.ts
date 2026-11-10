import type { CliArgs } from "../cli.js";
import {
	configPath,
	findWorkspace,
	formatAddress,
	loadClientConfig,
	migrateLegacy,
	parseAddress,
	putWorkspace,
	removeWorkspace,
	saveClientConfig,
	setDefault,
} from "./workspaces.js";

/** `tobor workspace list|add <name> <host:port>|remove <name>|use <name>` on the client config.yml. */
export async function run(args: CliArgs): Promise<number> {
	const notice = migrateLegacy();
	if (notice) process.stderr.write(`${notice}\n`);
	const path = configPath();
	let config = loadClientConfig(path);
	const [action, ...rest] = args.positionals;
	const arity: Record<string, number> = { list: 0, add: 2, remove: 1, use: 1 };
	if (action === undefined || arity[action] === undefined || rest.length !== arity[action]) {
		process.stderr.write("usage: tobor workspace list | add <name> <host:port> | remove <name> | use <name>\n");
		return 2;
	}
	const [name, address] = rest as [string, string];
	try {
		switch (action) {
			case "list": {
				if (config.workspaces.length === 0) {
					process.stdout.write(`no workspaces (${path}); add one with: tobor workspace add <name> <host:port>\n`);
					return 0;
				}
				const width = Math.max(...config.workspaces.map((w) => w.name.length));
				for (const w of config.workspaces) {
					process.stdout.write(`${w.name === config.default ? "*" : " "} ${w.name.padEnd(width)}  ${formatAddress(w)}\n`);
				}
				return 0;
			}
			case "add":
				if (findWorkspace(config, name)) throw new Error(`workspace ${name} already exists`);
				config = putWorkspace(config, name, parseAddress(address));
				break;
			case "remove":
				config = removeWorkspace(config, name);
				break;
			case "use":
				config = setDefault(config, name);
				break;
		}
	} catch (err) {
		process.stderr.write(`tobor workspace ${action}: ${(err as Error).message}\n`);
		return 1;
	}
	saveClientConfig(path, config);
	const ws = findWorkspace(config, name);
	const done = { add: `added ${name} (${ws ? formatAddress(ws) : ""})`, remove: `removed ${name}`, use: `default workspace: ${name}` }[action as "add" | "remove" | "use"];
	process.stdout.write(`${done}\n`);
	return 0;
}
