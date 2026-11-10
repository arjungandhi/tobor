import { access, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths } from "../../config/home.js";

/** `tobor backup <file>`: consistent copy of `.tobor/state/tobor.sqlite` (or the legacy root-level one, never moved from here) via `VACUUM INTO` (safe beside a running node). */
export async function run(args: CliArgs): Promise<number> {
	const target = resolve(args.positionals[0]!);
	const exists = (path: string) => access(path).then(() => true, () => false);
	let source = homePaths(args.home).db;
	const legacy = join(args.home, "tobor.sqlite");
	if (!(await exists(source)) && (await exists(legacy))) source = legacy;
	if (await exists(target)) {
		process.stderr.write(`tobor backup: ${target} already exists\n`);
		return 1;
	}
	if (!(await exists(source))) {
		process.stderr.write(`tobor backup: no database at ${source}\n`);
		return 1;
	}
	const db = new DatabaseSync(source, { readOnly: true });
	try {
		db.prepare("VACUUM INTO ?").run(target);
	} finally {
		db.close();
	}
	await chmod(target, 0o600);
	process.stdout.write(`tobor backup: ${source} -> ${target}\n`);
	return 0;
}
