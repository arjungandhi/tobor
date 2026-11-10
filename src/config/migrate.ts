// One-time move of node state from the root of `$TOBOR_HOME` into `.tobor/state/` (design: "Deployment and $TOBOR_HOME layout").
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./home.js";

/** Legacy root-level entries that move into `.tobor/state/` (the database sidecars only together with the database). */
const FILES = ["auth.json", "agent.env", "node.json", "artifacts"] as const;
/** The database moves last: while it is still at the root a crashed migration stays discoverable and the next run finishes it. */
const DB_FILES = ["tobor.sqlite-wal", "tobor.sqlite-shm", "tobor.sqlite"] as const;
const DB = "tobor.sqlite";

/**
 * Move legacy root-level state files of `home` into `.tobor/state/`, each only when the legacy file exists and the new
 * one does not (a home with nothing to move is left untouched). `.tobor/.gitignore` gets `state/` before anything
 * moves so the agent-data auto-commit never sees the state dir. Idempotent.
 */
export async function migrateHomeLayout(home: string): Promise<void> {
	if (!existsSync(home)) return;
	const p = paths(home);
	const moves: string[] = FILES.filter((name) => existsSync(join(home, name)) && !existsSync(join(p.stateDir, name)));
	// -wal/-shm travel only with their database; a stale sidecar is never paired with a database already at the new location.
	if (existsSync(join(home, DB)) && !existsSync(p.db)) {
		moves.push(...DB_FILES.filter((name) => existsSync(join(home, name)) && !existsSync(join(p.stateDir, name))));
	}
	if (moves.length === 0) return;

	await ensureStateDir(home);
	for (const name of moves) await rename(join(home, name), join(p.stateDir, name));
}

/** Create `.tobor/state/` (mode 0700) and make sure `.tobor/.gitignore` lists it, so state is never auto-committed. */
export async function ensureStateDir(home: string): Promise<void> {
	const p = paths(home);
	await mkdir(p.stateDir, { recursive: true, mode: 0o700 });
	await ensureStateIgnored(p.toborDir);
}

/** Make `.tobor/.gitignore` list `state/`, creating the file or appending the line. */
async function ensureStateIgnored(toborDir: string): Promise<void> {
	const file = join(toborDir, ".gitignore");
	if (!existsSync(file)) return void (await writeFile(file, "state/\n"));
	const text = await readFile(file, "utf8");
	if (text.split(/\r?\n/).some((line) => line.trim() === "state/")) return;
	await appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}state/\n`);
}
