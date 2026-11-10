import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDefinition } from "../../../api/types.js";
import { type ConfigError, THINKING_LEVELS, type ThinkingLevel } from "../../../config/schema.js";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Split `---` YAML frontmatter from a markdown body; undefined frontmatter when absent. */
export function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return { body: text };
	return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

/** Parse and validate one agent definition file. */
export function parseAgentFile(
	text: string,
	path: string,
	source: AgentDefinition["source"],
): { agent?: AgentDefinition; errors: ConfigError[] } {
	const errors: ConfigError[] = [];
	const fail = (key: string, message: string) => errors.push({ path: key, message });
	const { frontmatter, body } = splitFrontmatter(text);
	if (frontmatter === undefined) return { errors: [{ path: "", message: "missing --- frontmatter" }] };
	let raw: unknown;
	try {
		raw = parseYaml(frontmatter);
	} catch (error) {
		return { errors: [{ path: "", message: `frontmatter: ${(error as Error).message}` }] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { errors: [{ path: "", message: "frontmatter must be a mapping" }] };
	}
	const fm = raw as Record<string, unknown>;
	const fileName = basename(path).replace(/\.md$/, "");
	const name = fm.name ?? fileName;
	if (typeof name !== "string" || !NAME.test(name)) fail("name", "must match [a-z0-9][a-z0-9_-]*");
	if (typeof fm.description !== "string" || fm.description.trim() === "") fail("description", "required string");
	if (fm.model !== undefined && (typeof fm.model !== "string" || !fm.model.includes("/"))) {
		fail("model", "must be provider/modelId");
	}
	if (fm.thinking !== undefined && !THINKING_LEVELS.includes(fm.thinking as ThinkingLevel)) {
		fail("thinking", `must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	if (fm.tools !== undefined && (!Array.isArray(fm.tools) || fm.tools.some((t) => typeof t !== "string" || t === ""))) {
		fail("tools", "must be a list of tool names or globs");
	}
	if (fm.max_turns !== undefined && (!Number.isInteger(fm.max_turns) || (fm.max_turns as number) < 1)) {
		fail("max_turns", "must be an integer >= 1");
	}
	if (fm.approval !== undefined && fm.approval !== "inherit" && fm.approval !== "auto") {
		fail("approval", "must be inherit or auto");
	}
	if (errors.length > 0) return { errors };
	const agent: AgentDefinition = {
		name: name as string,
		description: (fm.description as string).trim(),
		approval: (fm.approval as "inherit" | "auto" | undefined) ?? "inherit",
		source,
		path,
		body: body.trim(),
	};
	if (fm.model !== undefined) agent.model = fm.model as string;
	if (fm.thinking !== undefined) agent.thinking = fm.thinking as ThinkingLevel;
	if (fm.tools !== undefined) agent.tools = fm.tools as string[];
	if (fm.max_turns !== undefined) agent.max_turns = fm.max_turns as number;
	return { agent, errors };
}

/** Nearest ancestor of `cwd` (inclusive) containing `.git`; undefined outside a repo. */
export async function findGitRoot(cwd: string): Promise<string | undefined> {
	let dir = cwd;
	while (true) {
		if (await exists(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** One agents directory, sorted by name; invalid files are reported, not thrown. */
export async function loadAgentDir(
	dir: string,
	source: AgentDefinition["source"],
): Promise<{ agents: AgentDefinition[]; errors: ConfigError[] }> {
	let names: string[];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
	} catch {
		return { agents: [], errors: [] };
	}
	const agents: AgentDefinition[] = [];
	const errors: ConfigError[] = [];
	for (const n of names) {
		const path = join(dir, n);
		const result = parseAgentFile(await readFile(path, "utf8"), path, source);
		if (result.agent) agents.push(result.agent);
		for (const e of result.errors) errors.push({ path: e.path ? `${path}:${e.path}` : path, message: e.message });
	}
	return { agents, errors };
}

/** Node agents overlaid by project agents of `cwd`'s git root (project shadows node by name), sorted by name. */
export async function loadAgents(
	nodeAgentsDir: string,
	cwd?: string,
): Promise<{ agents: AgentDefinition[]; errors: ConfigError[] }> {
	const node = await loadAgentDir(nodeAgentsDir, "node");
	const byName = new Map(node.agents.map((a) => [a.name, a]));
	const errors = [...node.errors];
	const root = cwd === undefined ? undefined : await findGitRoot(cwd);
	if (root !== undefined) {
		const projectDir = join(root, ".tobor", "agents");
		if (projectDir !== nodeAgentsDir) {
			const project = await loadAgentDir(projectDir, "project");
			for (const a of project.agents) byName.set(a.name, a);
			errors.push(...project.errors);
		}
	}
	return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** Whether `tool` matches an agent `tools` entry: an exact name or a glob with `*`. */
export function toolMatches(pattern: string, tool: string): boolean {
	if (!pattern.includes("*")) return pattern === tool;
	const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
	return re.test(tool);
}

/** Tools from `available` an agent may use: those matching `patterns`, or all but `exclude` when unset. */
export function selectTools(
	available: readonly string[],
	patterns: readonly string[] | undefined,
	exclude: readonly string[],
): string[] {
	if (patterns === undefined) return available.filter((t) => !exclude.includes(t));
	return available.filter((t) => patterns.some((p) => toolMatches(p, t)));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
