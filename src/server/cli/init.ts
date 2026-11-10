import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { artifactsSkill } from "../../artifacts/tools.js";
import type { CliArgs } from "../../cli.js";
import { paths as homePaths } from "../../config/home.js";
import { migrateHomeLayout } from "../../config/migrate.js";
import { ensureSystemConversation, readNodeJson, writeNodeJson } from "../harness/boot.js";
import { skeletonFiles } from "../skeleton/index.js";

const run$ = promisify(execFile);

/** Everything `tobor init` writes into `.tobor/`: the shipped skeleton plus the artifacts skill. */
export function nodeSkeleton(): Record<string, string> {
	return { ...skeletonFiles(), "skills/artifacts/SKILL.md": artifactsSkill };
}

/** What `initHome` did. */
export type InitResult = { created: string[]; committed: boolean; systemConversationId: number; ntfyTopic: string };

/** Create `$TOBOR_HOME`, the `.tobor/` git repo with the skeleton, `state/agent.env` and `state/node.json`. Idempotent. */
export async function initHome(
	home: string,
	skeleton: () => Record<string, string> = nodeSkeleton,
): Promise<InitResult> {
	const paths = homePaths(home);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await mkdir(paths.toborDir, { recursive: true });
	await migrateHomeLayout(home);
	await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.artifacts, { recursive: true });
	await mkdir(paths.designSystemsDir, { recursive: true });

	const created: string[] = [];
	for (const [rel, content] of Object.entries(skeleton())) {
		const target = join(paths.toborDir, rel);
		if (await exists(target)) continue;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
		created.push(join(".tobor", rel));
	}
	if (!(await exists(paths.agentEnv))) {
		await writeFile(paths.agentEnv, "# API keys and other secrets, KEY=value per line.\n", { mode: 0o600 });
		created.push(join(".tobor", "state", "agent.env"));
	}

	const git = (...argv: string[]) =>
		run$("git", ["-c", "user.name=tobor", "-c", "user.email=tobor@localhost", ...argv], { cwd: paths.toborDir });
	if (!(await exists(join(paths.toborDir, ".git")))) await git("init", "-q");
	await git("add", "-A");
	const { stdout } = await git("status", "--porcelain");
	const committed = stdout.trim() !== "";
	if (committed) await git("commit", "-q", "-m", "init: skeleton");

	const node = (await readNodeJson(paths.nodeJson)) ?? {};
	const ntfyTopic = node.ntfyTopic ?? `tobor-${randomBytes(6).toString("hex")}`;
	if (node.ntfyTopic === undefined) await writeNodeJson(paths.nodeJson, { ...node, ntfyTopic });
	const harness = await Harness.open(
		await openNodeSqliteStorage(paths.db),
		{ models: builtinModels(), registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		const systemConversationId = await ensureSystemConversation(harness, paths.nodeJson, BACKGROUND_CONTEXT);
		return { created, committed, systemConversationId, ntfyTopic };
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** `tobor init`: create `$TOBOR_HOME`, the `.tobor/` git repo skeleton and `node.json`. */
export async function run(args: CliArgs): Promise<number> {
	const result = await initHome(args.home);
	const out = process.stdout;
	out.write(`tobor home: ${args.home}\n`);
	for (const path of result.created) out.write(`  created ${path}\n`);
	if (result.created.length === 0) out.write("  nothing to create; existing files kept\n");
	if (result.committed) out.write("  committed .tobor/ changes\n");
	out.write(`  system conversation: ${result.systemConversationId}\n`);
	out.write(`  suggested ntfy topic: ${result.ntfyTopic} (set notify.ntfy in .tobor/config.yml to enable)\n`);
	out.write(`next: tobor login anthropic --home ${args.home}, then tobor node --home ${args.home}\n`);
	return 0;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
