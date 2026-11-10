import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { section } from "@earendil-works/pi-durable";
import { parse as parseYaml } from "yaml";
import type { HomePaths } from "../../config/home.js";
import { SessionDoc } from "../../docs.js";
import type { Section } from "../../tools/registry.js";
import { findGitRoot } from "./env.js";

/** tobor's identity and working style; replaced by `.tobor/SYSTEM.md` when present. */
export const PREAMBLE = `You are tobor, a coding agent running on the operator's host. You work through tools against the real file system and shell; there is no sandbox.

Working style:
- Read before you change anything; base every edit on what the files say now.
- Make the smallest change that fully solves the task. Keep the surrounding style.
- Verify with real commands where it matters, and report only what you observed.
- Be concise. Lead with the result, then the evidence. Say plainly when something is blocked and why.`;

/** Director-mode rules, appended to the preamble when the session's mode is `director`. */
export const DIRECTOR_RULES = `You are a director for one-shot background workers, not a worker. Workers search, edit, run and build; you plan, dispatch and verify.
- Own the todo list (\`todo\`): keep it current as work is planned, dispatched and verified.
- Split work into small independent tasks with clear file boundaries. Spawn every independent task in one \`task\` call. Call \`wait\` only when you are blocked on a result.
- Each brief is complete and self-contained: goal, target files, non-goals, interfaces, acceptance. One concern per worker; one worker owns each shared file.
- Workers skip build, lint and tests mid-flight; after all land, one worker runs them.
- Verify every result: read the touched files and the worker's output (\`agent_output\`). Re-orient with \`agent_list\`; steer a live worker with \`agent_send\`; stop an obsolete one with \`agent_stop\`. A correction to a finished worker is a new \`task\`.
- Report only exercised evidence.
- Pick agents by tier: \`fast\` (mechanical), \`worker\` (judgment), \`scout\` (read-only research), \`reviewer\` (read-only review).`;

/** Guidance for tobor's own tools: hashline read/edit and artifacts. */
export const TOOLS_GUIDANCE = `Reading and editing files:
- \`read\` returns \`[path#TAG]\` and numbered rows \`N:TEXT\`. Select lines with a suffix: \`path:A-B\`, \`path:A+C\`, \`path:N\` (to end), \`path:-N\` (last N), \`path:a,b\`, or \`path:raw\` for verbatim text.
- \`edit\` takes a patch: a header \`[path#TAG]\` copied from your latest read, then ops:
  \`PUT N.=M:\` replace lines N..M, \`PUT <N:\` insert before N, \`PUT >N:\` insert after N, \`PUT >$:\` append; each followed by body rows starting with \`+\` (\`+\` alone is a blank line, \`++x\` is \`+x\`). \`REM\` deletes the file; \`MV dest\` moves it.
- Line numbers always refer to the tagged snapshot, never to earlier hunks. Only anchor on lines you have read. A stale tag is refused: re-read, then edit with the fresh tag.
- Use \`write\` for new files or full rewrites.

Artifacts:
- For reports, dashboards and other documents meant to be viewed, create an artifact: \`artifact_create\` scaffolds \`.tobor/artifacts/<slug>/index.html\`, edit it, then \`artifact_publish\` and share the returned URL. \`artifact_export\` renders a PDF.`;

/** Read a text file, or undefined when it is absent or unreadable. */
async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Present, non-blank file texts joined with blank lines; undefined when none. */
async function joinFiles(paths: readonly string[], headed: boolean): Promise<string | undefined> {
	const parts: string[] = [];
	for (const path of paths) {
		const text = (await readText(path))?.trim();
		if (text) parts.push(headed ? `## ${path}\n\n${text}` : text);
	}
	return parts.length ? parts.join("\n\n") : undefined;
}

/** `name`/`description` from a markdown file's YAML frontmatter. */
export function parseFrontmatter(text: string): Record<string, unknown> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!m) return {};
	try {
		const value: unknown = parseYaml(m[1]!);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** `- name — description (path)` for each `skills/<dir>/SKILL.md` under `skillsDir`, sorted by directory. */
async function listSkills(skillsDir: string): Promise<string[]> {
	let dirs: string[];
	try {
		dirs = (await readdir(skillsDir, { withFileTypes: true }))
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
	const lines: string[] = [];
	for (const dir of dirs) {
		const path = join(skillsDir, dir, "SKILL.md");
		const text = await readText(path);
		if (text === undefined) continue;
		const fm = parseFrontmatter(text);
		const name = typeof fm.name === "string" && fm.name ? fm.name : dir;
		const description = typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
		lines.push(`- ${name}${description ? ` — ${description}` : ""} (${path})`);
	}
	return lines;
}

/** Directories from `root` down to `cwd`, outermost first; just `cwd` when it is not under `root`. */
function walkDown(root: string | undefined, cwd: string): string[] {
	if (!root) return [cwd];
	const rel = relative(root, cwd);
	if (rel.startsWith("..")) return [cwd];
	const dirs = [root];
	let cur = root;
	for (const part of rel.split(sep).filter(Boolean)) {
		cur = join(cur, part);
		dirs.push(cur);
	}
	return dirs;
}

/** The system prompt sections in design order; every file is read at render time. */
export function createSections(paths: HomePaths): Section[] {
	const projectDir = async (cwd: string | undefined) => {
		if (!cwd) return undefined;
		const root = await findGitRoot(cwd);
		return root ? { root, tobor: join(root, ".tobor") } : undefined;
	};
	return [
		section("preamble", async (input, ctx) => {
			const session = await input.read.snapshot(SessionDoc, input.conversationId, ctx);
			const base = (await readText(paths.systemMd))?.trim() || PREAMBLE;
			return session?.mode === "director" && !session.worker ? `${base}\n\n${DIRECTOR_RULES}` : base;
		}),
		section("append_system", async (input) => {
			const project = await projectDir(input.agent.cwd);
			return joinFiles(
				[paths.appendSystemMd, ...(project ? [join(project.tobor, "APPEND_SYSTEM.md")] : [])],
				false,
			);
		}),
		section("tools", () => TOOLS_GUIDANCE),
		section("rules", async (input) => {
			const project = await projectDir(input.agent.cwd);
			return joinFiles([paths.rulesMd, ...(project ? [join(project.tobor, "RULES.md")] : [])], true);
		}),
		section("project_context", async (input) => {
			const cwd = input.agent.cwd;
			const project = await projectDir(cwd);
			const files = [paths.agentsMd];
			if (project) files.push(join(project.tobor, "AGENTS.md"));
			if (cwd) {
				for (const dir of walkDown(project?.root, cwd)) files.push(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
			}
			return joinFiles(files, true);
		}),
		section("skills", async (input) => {
			const project = await projectDir(input.agent.cwd);
			const lines = [
				...(await listSkills(paths.skillsDir)),
				...(project ? await listSkills(join(project.tobor, "skills")) : []),
			];
			return lines.length ? `Open a skill with \`read\` when it applies.\n${lines.join("\n")}` : undefined;
		}),
		section("cwd", (input) => (input.agent.cwd ? `Working directory: ${input.agent.cwd}` : undefined)),
	];
}
