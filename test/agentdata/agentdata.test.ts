import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "../../src/api/types.js";
import { paths as homePaths } from "../../src/config/home.js";
import { parseConfigText } from "../../src/config/load.js";
import { EventBus } from "../../src/events.js";
import { HostError } from "../../src/host.js";
import { AgentData, type InvalidChange } from "../../src/server/agentdata.js";

const CONFIG = "defaults:\n  approval_mode: ask\n  thinking: high\n";
const AGENT = "---\ndescription: helper\n---\nDo things.\n";

let home: string;
let dir: string;
let data: AgentData;
let events: NodeEvent[];
let invalid: InvalidChange[];

function git(...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
}

/** Resolves once `predicate` holds; the real fs watcher has no completion signal to await. */
const until = (predicate: () => boolean) =>
	vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 20 });

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "tobor-agentdata-"));
	const paths = homePaths(home);
	dir = paths.toborDir;
	await mkdir(join(dir, "agents"), { recursive: true });
	await writeFile(join(dir, "config.yml"), CONFIG);
	await writeFile(join(dir, "agents", "helper.md"), AGENT);
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "init: skeleton");
	const bus = new EventBus();
	events = [];
	invalid = [];
	bus.onAny((e) => events.push(e));
	data = new AgentData({
		home,
		paths,
		config: () => parseConfigText(CONFIG, home).config,
		events: bus,
		debounceMs: 30,
		onInvalid: (c) => invalid.push(c),
	});
});

afterEach(async () => {
	await data.stop();
	await rm(home, { recursive: true, force: true });
});

describe("AgentData files", () => {
	it("lists the root for the empty path and hides .git", async () => {
		const root = await data.read("");
		expect(root).toEqual({
			type: "dir",
			path: "",
			entries: [
				{ name: "agents", type: "dir" },
				{ name: "config.yml", type: "file" },
			],
		});
	});

	it("writes, commits, and reports history and diff", async () => {
		const before = await data.read("config.yml");
		expect(before).toMatchObject({ type: "file", content: CONFIG });
		const sha = before?.type === "file" ? before.sha : undefined;
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		const next = CONFIG.replace("high", "low");
		const res = await data.write("config.yml", { content: next, sha });
		expect(res.ok).toBe(true);
		expect(git("rev-parse", "HEAD").trim()).toBe(res.commit);
		expect(git("log", "-1", "--format=%s").trim()).toBe("operator: config.yml");
		expect(events).toContainEqual({
			type: "agent.committed",
			commit: res.commit,
			message: "operator: config.yml",
			paths: ["config.yml"],
		});

		await expect(data.write("config.yml", { content: CONFIG, sha })).rejects.toMatchObject({ status: 409 });

		const history = await data.history({});
		expect(history.map((c) => c.message)).toEqual(["operator: config.yml", "init: skeleton"]);
		expect(history[0]?.sha).toBe(res.commit);
		expect(await data.history({ path: "agents/helper.md" })).toHaveLength(1);
		expect(await data.history({ limit: 1 })).toHaveLength(1);

		const diff = await data.diff({});
		expect(diff).toContain("-  thinking: high");
		expect(diff).toContain("+  thinking: low");
		expect(await data.diff({ commit: res.commit, path: "agents/helper.md" })).toBe("");
		await expect(data.diff({ commit: "--output=/tmp/x" })).rejects.toMatchObject({ status: 400 });

		const removed = await data.remove("agents/helper.md");
		expect(git("log", "-1", "--format=%s").trim()).toBe("operator: delete agents/helper.md");
		expect(removed.commit).toBe(git("rev-parse", "HEAD").trim());
		expect(await data.read("agents/helper.md")).toBeUndefined();
	});

	it("rejects an invalid config.yml with 422 and leaves the file untouched", async () => {
		const error = await data.write("config.yml", { content: "defaults:\n  approval_mode: sometimes\n" }).catch((e) => e);
		expect(error).toBeInstanceOf(HostError);
		expect(error.status).toBe(422);
		expect(error.errors.length).toBeGreaterThan(0);
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe(CONFIG);
		expect(git("status", "--porcelain")).toBe("");
		expect(events).toEqual([]);
	});

	it("validates agents, skills, mcp.json and design systems", async () => {
		await expect(data.write("agents/bad.md", { content: "no frontmatter" })).rejects.toMatchObject({ status: 422 });
		await expect(data.write("skills/x/SKILL.md", { content: "---\nname: x\n---\n" })).rejects.toMatchObject({
			status: 422,
		});
		await data.write("skills/x/SKILL.md", { content: "---\nname: x\ndescription: does x\n---\nbody\n" });
		await expect(data.write("mcp.json", { content: "{" })).rejects.toMatchObject({ status: 422 });
		await data.write("mcp.json", { content: '{"servers":{}}' });
		await expect(data.write("design-systems/t/design-system.md", { content: "# t" })).rejects.toMatchObject({
			status: 422,
		});
		await data.write("design-systems/t/tokens.css", { content: ":root{}" });
		await data.write("design-systems/t/design-system.md", { content: "# t" });
		await expect(data.remove("design-systems/t/tokens.css")).rejects.toMatchObject({ status: 422 });
	});

	it("hides the state dir from listings", async () => {
		await mkdir(join(dir, "state"), { recursive: true });
		await writeFile(join(dir, "state", "auth.json"), "{}");
		await mkdir(join(dir, "agents", "state"), { recursive: true });
		const root = await data.read("");
		expect(root).toMatchObject({ type: "dir" });
		expect((root as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(["agents", "config.yml"]);
		expect(await data.read("agents/state")).toMatchObject({ type: "dir" });
	});

	it("keeps every path inside .tobor/", async () => {
		for (const bad of ["../node.json", "agents/../../auth.json", ".git/config", "agents/.git", "/etc/passwd", "state", "state/auth.json", "State/node.json"]) {
			await expect(data.read(bad), bad).rejects.toBeInstanceOf(HostError);
			await expect(data.write(bad, { content: "x" }), bad).rejects.toBeInstanceOf(HostError);
		}
		await writeFile(join(home, "secret"), "s");
		await symlink(home, join(dir, "out"));
		await expect(data.read("out/secret")).rejects.toMatchObject({ status: 403 });
		await expect(data.write("out/new", { content: "x" })).rejects.toMatchObject({ status: 403 });
		await expect(data.write("", { content: "x" })).rejects.toMatchObject({ status: 400 });
	});
});

describe("AgentData self-edits", () => {
	it("commits agent edits as agent: <paths>", async () => {
		await data.watch();
		await writeFile(join(dir, "AGENTS.md"), "# node\n");
		await writeFile(join(dir, "agents", "helper.md"), AGENT.replace("helper", "assistant"));
		await until(() => git("status", "--porcelain") === "" && events.length > 0);
		expect(git("log", "-1", "--format=%s").trim()).toBe("agent: AGENTS.md, agents/helper.md");
		expect(events).toEqual([
			expect.objectContaining({ type: "agent.committed", paths: ["AGENTS.md", "agents/helper.md"] }),
		]);
		expect(invalid).toEqual([]);
	});

	it("reverts invalid agent edits and reports them", async () => {
		await data.watch();
		await writeFile(join(dir, "agents", "helper.md"), "broken");
		await writeFile(join(dir, "agents", "new.md"), "also broken");
		await until(() => invalid.length > 0);
		expect(await readFile(join(dir, "agents", "helper.md"), "utf8")).toBe(AGENT);
		await expect(readFile(join(dir, "agents", "new.md"), "utf8")).rejects.toThrow();
		expect(invalid[0]?.reverted).toEqual(["agents/helper.md", "agents/new.md"]);
		expect(git("status", "--porcelain")).toBe("");
		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
	});

	it("reverts an agent change to an operator-only config key", async () => {
		await data.watch();
		await writeFile(join(dir, "config.yml"), CONFIG.replace("approval_mode: ask", "approval_mode: auto"));
		await until(() => invalid.length > 0);
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe(CONFIG);
		expect(invalid[0]?.errors).toContainEqual(expect.objectContaining({ path: "config.yml: defaults.approval_mode" }));
		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");

		// Other keys stay agent-editable.
		await writeFile(join(dir, "config.yml"), CONFIG.replace("high", "low"));
		await until(() => events.length > 0);
		expect(git("log", "-1", "--format=%s").trim()).toBe("agent: config.yml");
	});

	it("does not double-commit operator writes while watching", async () => {
		await data.watch();
		await data.write("RULES.md", { content: "be nice\n" });
		await writeFile(join(dir, "AGENTS.md"), "# node\n");
		await until(() => events.length >= 2);
		expect(git("log", "--format=%s").trim().split("\n")).toEqual([
			"agent: AGENTS.md",
			"operator: RULES.md",
			"init: skeleton",
		]);
	});
});

describe("AgentData agents", () => {
	it("lists and finds node agents", async () => {
		expect((await data.listAgents()).map((a) => a.name)).toEqual(["helper"]);
		expect((await data.getAgent("helper"))?.description).toBe("helper");
		expect(await data.getAgent("missing")).toBeUndefined();
	});
});
