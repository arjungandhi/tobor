import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { WhoamiResponse } from "../../api/types.js";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths, resolveHome } from "../../config/home.js";
import { formatListen, loadConfig } from "../../config/load.js";
import type { Config, ListenAddress } from "../../config/schema.js";
import { HostError } from "../../host.js";
import { BUILD, VERSION } from "../../version.js";
import { AuthService } from "../auth.js";
import { FileCredentialStore } from "../harness/credentials.js";
import { loadEnvFile, parseEnvText } from "../harness/env.js";
import { createModels } from "../harness/models.js";
import { staleNodeHint } from "../../tui/node-upgrade.js";

export { staleNodeHint };

/** `tobor login <provider>`: headless OAuth (open the URL anywhere, paste the code) into `.tobor/state/auth.json`. */
export async function run(args: CliArgs): Promise<number> {
	const { config } = await loadConfig(args.home);
	const code = await login(args, config);
	const node = await fetchWhoami(config.listen);
	const hint = staleNodeHint({ version: VERSION, build: BUILD }, node, await nodeUnit(args.home));
	if (hint) process.stderr.write(`${hint}\n`);
	return code;
}

/** `.tobor/state/auth.json`, or the legacy root-level `auth.json` of a home not yet migrated by `node`/`init` (never moved from here). */
function authPath(home: string): string {
	const auth = homePaths(home).auth;
	const legacy = join(home, "auth.json");
	return !existsSync(auth) && existsSync(legacy) ? legacy : auth;
}

async function login(args: CliArgs, config: Config): Promise<number> {
	const provider = args.positionals[0]!;
	const credentials = new FileCredentialStore(authPath(args.home));
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
