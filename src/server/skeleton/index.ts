import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Skeleton files shipped next to this module (the build must copy them beside the compiled `index.js`). */
const FILES = [
	"AGENTS.md",
	"RULES.md",
	"config.yml",
	"agents/worker.md",
	"agents/fast.md",
	"agents/scout.md",
	"agents/reviewer.md",
	"skills/tobor-self/SKILL.md",
] as const;

/** Files `tobor init` writes into `$TOBOR_HOME/.tobor/`, keyed by path relative to it. */
export function skeletonFiles(): Record<string, string> {
	const files: Record<string, string> = { "mcp.json": `${JSON.stringify({ servers: {} }, null, "\t")}\n` };
	for (const path of FILES) files[path] = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
	return files;
}
