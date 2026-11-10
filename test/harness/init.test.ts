import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load.js";
import { initHome, nodeSkeleton } from "../../src/server/cli/init.js";

const git = promisify(execFile);

describe("tobor init", () => {
	it("ships a skeleton config that validates cleanly", () => {
		expect(parseConfigText(nodeSkeleton()["config.yml"]!, "/home/x").errors).toEqual([]);
	});

	it("creates the home, commits the skeleton, writes node.json, and is idempotent", async () => {
		const home = join(await mkdtemp(join(tmpdir(), "tobor-init-")), "home");
		const first = await initHome(home);
		expect(first.created.sort()).toEqual(
			[...Object.keys(nodeSkeleton()).map((p) => `.tobor/${p}`), ".tobor/state/agent.env"].sort(),
		);
		expect(first.created).toContain(".tobor/skills/artifacts/SKILL.md");
		expect((await stat(join(home, ".tobor", "design-systems"))).isDirectory()).toBe(true);
		expect(first.committed).toBe(true);
		expect(await readFile(join(home, ".tobor", ".gitignore"), "utf8")).toBe("state/\n");
		const tracked = await git("git", ["ls-files"], { cwd: join(home, ".tobor") });
		expect(tracked.stdout).toContain(".gitignore");
		expect(tracked.stdout).not.toContain("state/");
		expect((await stat(join(home, ".tobor", "state", "agent.env"))).mode & 0o777).toBe(0o600);
		const log = await git("git", ["log", "--oneline"], { cwd: join(home, ".tobor") });
		expect(log.stdout).toContain("init: skeleton");
		const node = JSON.parse(await readFile(join(home, ".tobor", "state", "node.json"), "utf8"));
		expect(node).toEqual({ ntfyTopic: first.ntfyTopic, systemConversationId: first.systemConversationId });

		const second = await initHome(home);
		expect(second).toEqual({ ...first, created: [], committed: false });
	});

	it("migrates a legacy home's root-level state before it commits", async () => {
		const home = join(await mkdtemp(join(tmpdir(), "tobor-init-")), "home");
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "agent.env"), "KEY=1\n", { mode: 0o600 });
		await writeFile(join(home, "node.json"), JSON.stringify({ ntfyTopic: "tobor-old" }));
		const result = await initHome(home);
		expect(result.ntfyTopic).toBe("tobor-old");
		expect(await readFile(join(home, ".tobor", "state", "agent.env"), "utf8")).toBe("KEY=1\n");
		expect(await stat(join(home, "agent.env")).catch(() => undefined)).toBeUndefined();
		expect(result.created).not.toContain(".tobor/state/agent.env");
		const tracked = await git("git", ["ls-files"], { cwd: join(home, ".tobor") });
		expect(tracked.stdout).not.toContain("state/");
	});
});
