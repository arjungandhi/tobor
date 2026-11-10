import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/config/home.js";
import { migrateHomeLayout } from "../src/config/migrate.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

async function legacyHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "tobor-migrate-"));
	await mkdir(join(home, ".tobor"));
	await writeFile(join(home, ".tobor", "config.yml"), "");
	for (const [name, mode] of [["auth.json", 0o600], ["agent.env", 0o600], ["node.json", 0o644], ["tobor.sqlite", 0o644], ["tobor.sqlite-wal", 0o644], ["tobor.sqlite-shm", 0o644]] as const) {
		await writeFile(join(home, name), name, { mode });
	}
	await mkdir(join(home, "artifacts", "store"), { recursive: true });
	await writeFile(join(home, "artifacts", "feed.jsonl"), "feed\n");
	return home;
}

describe("migrateHomeLayout", () => {
	it("moves a legacy home into .tobor/state, gitignores it, and is idempotent", async () => {
		const home = await legacyHome();
		const p = paths(home);
		await migrateHomeLayout(home);

		for (const name of ["auth.json", "agent.env", "node.json", "tobor.sqlite", "tobor.sqlite-wal", "tobor.sqlite-shm"]) {
			expect(await exists(join(home, name)), name).toBe(false);
			expect(await readFile(join(p.stateDir, name), "utf8")).toBe(name);
		}
		expect(await exists(join(home, "artifacts"))).toBe(false);
		expect(await readFile(p.artifactsFeed, "utf8")).toBe("feed\n");
		expect((await stat(p.artifactsStore)).isDirectory()).toBe(true);
		expect((await stat(p.auth)).mode & 0o777).toBe(0o600);
		expect((await stat(p.agentEnv)).mode & 0o777).toBe(0o600);
		expect(await readFile(join(p.toborDir, ".gitignore"), "utf8")).toBe("state/\n");

		await migrateHomeLayout(home);
		expect((await readdir(p.stateDir)).sort()).toEqual(
			["agent.env", "artifacts", "auth.json", "node.json", "tobor.sqlite", "tobor.sqlite-shm", "tobor.sqlite-wal"],
		);
		expect(await readFile(join(p.toborDir, ".gitignore"), "utf8")).toBe("state/\n");
	});

	it("appends state/ to an existing .gitignore and never overwrites files already in the new place", async () => {
		const home = await legacyHome();
		const p = paths(home);
		await writeFile(join(p.toborDir, ".gitignore"), "*.log");
		await mkdir(p.stateDir, { recursive: true });
		await writeFile(p.nodeJson, "new");
		await migrateHomeLayout(home);

		expect(await readFile(join(p.toborDir, ".gitignore"), "utf8")).toBe("*.log\nstate/\n");
		expect(await readFile(p.nodeJson, "utf8")).toBe("new");
		expect(await readFile(join(home, "node.json"), "utf8")).toBe("node.json");
		expect(await readFile(p.auth, "utf8")).toBe("auth.json");
	});

	it("leaves a fresh or missing home untouched", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "tobor-migrate-"));
		await migrateHomeLayout(fresh);
		expect(await readdir(fresh)).toEqual([]);
		await migrateHomeLayout(join(fresh, "missing"));
		expect(await exists(join(fresh, "missing"))).toBe(false);
	});
});
