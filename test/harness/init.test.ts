import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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
			[...Object.keys(nodeSkeleton()).map((p) => `.tobor/${p}`), "agent.env"].sort(),
		);
		expect(first.created).toContain(".tobor/skills/artifacts/SKILL.md");
		expect((await stat(join(home, ".tobor", "design-systems"))).isDirectory()).toBe(true);
		expect(first.committed).toBe(true);
		expect((await stat(join(home, "agent.env"))).mode & 0o777).toBe(0o600);
		const log = await git("git", ["log", "--oneline"], { cwd: join(home, ".tobor") });
		expect(log.stdout).toContain("init: skeleton");
		const node = JSON.parse(await readFile(join(home, "node.json"), "utf8"));
		expect(node).toEqual({ ntfyTopic: first.ntfyTopic, systemConversationId: first.systemConversationId });

		const second = await initHome(home);
		expect(second).toEqual({ ...first, created: [], committed: false });
	});
});
