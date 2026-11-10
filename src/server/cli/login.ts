import { createInterface } from "node:readline/promises";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths } from "../../config/home.js";
import { loadConfig } from "../../config/load.js";
import { HostError } from "../../host.js";
import { AuthService } from "../auth.js";
import { FileCredentialStore } from "../harness/credentials.js";
import { loadEnvFile } from "../harness/env.js";
import { createModels } from "../harness/models.js";

/** `tobor login <provider>`: headless OAuth (open the URL anywhere, paste the code) into `auth.json`. */
export async function run(args: CliArgs): Promise<number> {
	const provider = args.positionals[0]!;
	const { config } = await loadConfig(args.home);
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
		if (!(err instanceof HostError)) throw err;
		process.stderr.write(`tobor login: ${err.message}\n`);
		return 1;
	} finally {
		rl.close();
		auth.cancelLogins();
	}
}
