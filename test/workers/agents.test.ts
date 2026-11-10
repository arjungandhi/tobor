import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load.js";
import {
	findGitRoot,
	loadAgents,
	parseAgentFile,
	selectTools,
	toolMatches,
} from "../../src/server/harness/workers/agents.js";
import { composeBrief, DIRECTOR_TOOLS, taskSpawnsAutoWorker } from "../../src/server/harness/workers/tools.js";
import { reportText } from "../../src/server/harness/workers/holder.js";
import { skeletonFiles } from "../../src/server/skeleton/index.js";

function tmp(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "tobor-agents-")));
}

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

describe("parseAgentFile", () => {
	it("parses every field and defaults approval to inherit", () => {
		const { agent, errors } = parseAgentFile(
			"---\nname: fast\ndescription: quick\nmodel: anthropic/claude-haiku-5-5\nthinking: low\ntools: [read, 'mcp__gh__*']\nmax_turns: 5\n---\n\nBody text.\n",
			"/n/fast.md",
			"node",
		);
		expect(errors).toEqual([]);
		expect(agent).toEqual({
			name: "fast",
			description: "quick",
			model: "anthropic/claude-haiku-5-5",
			thinking: "low",
			tools: ["read", "mcp__gh__*"],
			max_turns: 5,
			approval: "inherit",
			source: "node",
			path: "/n/fast.md",
			body: "Body text.",
		});
	});

	it("takes the name from the file when omitted", () => {
		expect(parseAgentFile("---\ndescription: d\n---\nx", "/a/my-agent.md", "project").agent?.name).toBe("my-agent");
	});

	it("reports each invalid field", () => {
		const { agent, errors } = parseAgentFile(
			"---\nname: Bad Name\nmodel: nope\nthinking: huge\ntools: read\nmax_turns: 0\napproval: always\n---\n",
			"/a/x.md",
			"node",
		);
		expect(agent).toBeUndefined();
		expect(errors.map((e) => e.path).sort()).toEqual(
			["approval", "description", "max_turns", "model", "name", "thinking", "tools"].sort(),
		);
	});

	it("rejects missing or broken frontmatter", () => {
		expect(parseAgentFile("no frontmatter", "/a/x.md", "node").errors[0]?.message).toContain("frontmatter");
		expect(parseAgentFile("---\n[: bad\n---\n", "/a/x.md", "node").errors[0]?.message).toContain("frontmatter");
		expect(parseAgentFile("---\n- a\n---\n", "/a/x.md", "node").errors[0]?.message).toBe("frontmatter must be a mapping");
	});
});

describe("loadAgents", () => {
	it("overlays project agents of the cwd's git root over node agents", async () => {
		const home = tmp();
		const nodeDir = join(home, ".tobor", "agents");
		write(join(nodeDir, "worker.md"), "---\ndescription: node worker\n---\nnode");
		write(join(nodeDir, "scout.md"), "---\ndescription: node scout\n---\nnode");
		write(join(nodeDir, "broken.md"), "---\nname: x\n---\n");
		const repo = tmp();
		mkdirSync(join(repo, ".git"));
		write(join(repo, ".tobor", "agents", "worker.md"), "---\ndescription: project worker\n---\nproject");
		write(join(repo, ".tobor", "agents", "extra.md"), "---\ndescription: extra\n---\n");
		const sub = join(repo, "src", "deep");
		mkdirSync(sub, { recursive: true });

		const nodeOnly = await loadAgents(nodeDir);
		expect(nodeOnly.agents.map((a) => `${a.name}:${a.source}`)).toEqual(["scout:node", "worker:node"]);
		expect(nodeOnly.errors[0]?.path).toBe(`${join(nodeDir, "broken.md")}:description`);

		const withProject = await loadAgents(nodeDir, sub);
		expect(withProject.agents.map((a) => `${a.name}:${a.source}`)).toEqual(["extra:project", "scout:node", "worker:project"]);
		expect(withProject.agents.find((a) => a.name === "worker")?.body).toBe("project");
		expect(await findGitRoot(sub)).toBe(repo);
	});

	it("tolerates a missing directory", async () => {
		expect(await loadAgents(join(tmp(), "none"))).toEqual({ agents: [], errors: [] });
	});
});

describe("tool selection", () => {
	const available = ["read", "bash", "edit", "task", "wait", "agent_output", "mcp__gh__list", "mcp__gh__create", "mcp__x__y"];

	it("matches exact names and globs", () => {
		expect(toolMatches("mcp__gh__*", "mcp__gh__list")).toBe(true);
		expect(toolMatches("mcp__gh__*", "mcp__ghx__list")).toBe(false);
		expect(toolMatches("read", "read")).toBe(true);
		expect(toolMatches("re.d", "read")).toBe(false);
	});

	it("gives the full set minus director tools when unset", () => {
		expect(selectTools(available, undefined, DIRECTOR_TOOLS)).toEqual(["read", "bash", "edit", "mcp__gh__list", "mcp__gh__create", "mcp__x__y"]);
	});

	it("keeps registry order for listed tools", () => {
		expect(selectTools(available, ["mcp__gh__*", "read"], DIRECTOR_TOOLS)).toEqual(["read", "mcp__gh__list", "mcp__gh__create"]);
	});
});

describe("briefs and reports", () => {
	it("composes context then task", () => {
		expect(composeBrief({ task: " do it ", context: "background\n" })).toBe("background\n\ndo it");
		expect(composeBrief({ task: "do it", context: "  " })).toBe("do it");
	});

	it("formats the director follow-up", () => {
		expect(reportText("a", "done", "hello")).toBe("[worker a finished: done]\nhello");
		expect(reportText("a", "failed", "", "turn_limit")).toBe("[worker a finished: failed (turn_limit)]\n(no final text)");
	});

	it("detects auto workers for the approval gate", async () => {
		const agents = async () => [
			{ name: "safe", description: "", approval: "inherit" as const, source: "node" as const, path: "", body: "" },
			{ name: "yolo", description: "", approval: "auto" as const, source: "node" as const, path: "", body: "" },
		];
		expect(await taskSpawnsAutoWorker({ tasks: [{ agent: "safe", task: "x" }] }, "/", agents)).toBe(false);
		expect(await taskSpawnsAutoWorker({ tasks: [{ agent: "safe" }, { agent: "yolo" }] }, "/", agents)).toBe(true);
		expect(await taskSpawnsAutoWorker("junk", "/", agents)).toBe(false);
	});
});

describe("skeleton", () => {
	const files = skeletonFiles();

	it("ships the documented layout", () => {
		expect(Object.keys(files).sort()).toEqual(
			[
				"AGENTS.md",
				"RULES.md",
				"agents/fast.md",
				"agents/reviewer.md",
				"agents/scout.md",
				"agents/worker.md",
				"config.yml",
				"mcp.json",
				"skills/tobor-self/SKILL.md",
			].sort(),
		);
	});

	it("has valid agent definitions with read-only scout and reviewer", () => {
		for (const name of ["worker", "fast", "scout", "reviewer"]) {
			const { agent, errors } = parseAgentFile(files[`agents/${name}.md`] as string, `/s/${name}.md`, "node");
			expect(errors).toEqual([]);
			expect(agent?.name).toBe(name);
			if (name === "scout") expect(agent?.tools).toEqual(["read", "bash", "fetch_url", "web_search"]);
			else if (name === "reviewer") expect(agent?.tools).toEqual(["read", "bash"]);
			else expect(agent?.tools).toBeUndefined();
		}
	});

	it("has a config.yml the node accepts and a valid mcp.json", () => {
		expect(parseConfigText(files["config.yml"] as string, "/home/t").errors).toEqual([]);
		expect(JSON.parse(files["mcp.json"] as string)).toEqual({ servers: {} });
	});

	it("has tobor-self skill frontmatter", () => {
		expect(files["skills/tobor-self/SKILL.md"]).toMatch(/^---\nname: tobor-self\ndescription: .+\n---\n/);
	});
});
