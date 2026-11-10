import { access, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths } from "../../config/home.js";
import { migrateHomeLayout } from "../../config/migrate.js";

/** `tobor backup <file>`: consistent copy of `.tobor/state/tobor.sqlite` via `VACUUM INTO` (safe beside a running node). */
export async function run(args: CliArgs): Promise<number> {
	const target = resolve(args.positionals[0]!);
	await migrateHomeLayout(args.home);
	const source = homePaths(args.home).db;
	if (await access(target).then(() => true, () => false)) {
		process.stderr.write(`tobor backup: ${target} already exists\n`);
		return 1;
	}
	if (!(await access(source).then(() => true, () => false))) {
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
