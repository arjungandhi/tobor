import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { WhoamiResponse } from "../../api/types.js";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths, resolveHome } from "../../config/home.js";
import { formatListen, loadConfig } from "../../config/load.js";
import { migrateHomeLayout } from "../../config/migrate.js";
import type { Config, ListenAddress } from "../../config/schema.js";
import { HostError } from "../../host.js";
import { BUILD, VERSION } from "../../version.js";
import { AuthService } from "../auth.js";
import { FileCredentialStore } from "../harness/credentials.js";
import { loadEnvFile, parseEnvText } from "../harness/env.js";
import { createModels } from "../harness/models.js";

/** `tobor login <provider>`: headless OAuth (open the URL anywhere, paste the code) into `.tobor/state/auth.json`. */
export async function run(args: CliArgs): Promise<number> {
	await migrateHomeLayout(args.home);
	const { config } = await loadConfig(args.home);
	const code = await login(args, config);
	const node = await fetchWhoami(config.listen);
	const hint = staleNodeHint({ version: VERSION, build: BUILD }, node, await nodeUnit(args.home));
	if (hint) process.stderr.write(`${hint}\n`);
	return code;
}

async function login(args: CliArgs, config: Config): Promise<number> {
	const provider = args.positionals[0]!;
	const credentials = new FileCredentialStore(homePaths(args.home).auth);
	const models = createModels({ credentials, env: await loadEnvFile(config.env_file) });
	const auth = new AuthService({ models, credentials, config: () => config });
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const start = await auth.loginStart(provider);
		process.stdout.write(`Open this URL on any device and approve:\n\n  ${start.url}\n\n`);
		if (start.instructions) process.stdout.write(`${start.instructions}\n`);
		const code = await rl.question("Code: ");
		const result = await auth.loginCode(provider, code);
		const expiry = result.auth.expiresAt ? `, access token expires ${new Date(result.auth.expiresAt).toISOString()}` : "";
		process.stdout.write(`Logged in to ${provider} (${result.auth.source}${expiry}); credential stored in ${credentials.path}\n`);
		return 0;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			process.stderr.write("tobor login: cancelled\n");
			return 130;
		}
		if (!(err instanceof HostError)) throw err;
		process.stderr.write(`tobor login: ${err.message}\n`);
		return 1;
	} finally {
		rl.close();
		auth.cancelLogins();
	}
}

/** `GET /api/whoami` of the node listening on this home's `listen` address; undefined when none answers. */
async function fetchWhoami(listen: ListenAddress): Promise<WhoamiResponse | undefined> {
	const host = listen.host === "0.0.0.0" ? "127.0.0.1" : listen.host === "::" ? "::1" : listen.host;
	try {
		const res = await fetch(`http://${formatListen({ host, port: listen.port })}/api/whoami`, { signal: AbortSignal.timeout(1500) });
		return res.ok ? ((await res.json()) as WhoamiResponse) : undefined;
	} catch {
		return undefined;
	}
}

/** Name of the `tobor@<name>` unit serving `home`: the `$XDG_CONFIG_HOME/tobor/nodes/<name>.env` whose `TOBOR_HOME` is it. */
export async function nodeUnit(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const dir = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tobor", "nodes");
	const names = await readdir(dir).catch(() => []);
	for (const name of names.filter((n) => n.endsWith(".env")).sort()) {
		const vars = parseEnvText(await readFile(join(dir, name), "utf8"));
		if (resolve(resolveHome({}, vars)) === resolve(home)) return name.slice(0, -".env".length);
	}
	return undefined;
}

/**
 * How to restart a node that runs another build than this CLI (a rebuilt binary is picked up only on restart), or
 * undefined when it runs the same build, none answers, or either side runs from source.
 */
export function staleNodeHint(
	cli: { version: string; build: string },
	node: { version: string; build?: string } | undefined,
	unit: string | undefined,
): string | undefined {
	if (!node || cli.build === "dev" || node.build === "dev") return undefined;
	if (node.version === cli.version && node.build === cli.build) return undefined;
	const restart = unit ? `systemctl --user restart tobor@${unit}` : "stop it and start `tobor node` again";
	return `note: the running node is tobor ${node.version} (build ${node.build ?? "unknown"}), this CLI is ${cli.version} (build ${cli.build}); restart the node to pick up a rebuilt binary: ${restart}`;
}
