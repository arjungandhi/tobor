// Validation of `.tobor/` files before they are committed (design: "Agent data", "Self-editing").
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseConfigText, validateMcpJson } from "../config/load.js";
import type { ConfigError } from "../config/schema.js";
import { parseAgentFile, splitFrontmatter } from "./harness/workers/agents.js";

/** Where the file lives: `home` for config path normalization, `toborDir` for directory rules. */
export type ValidateContext = { home: string; toborDir: string };

/**
 * Validate one `.tobor/` file. `relPath` uses `/` separators relative to `.tobor/`; `content` is the new text, or
 * undefined when the file is deleted. Only known files are checked; everything else passes.
 */
export async function validateToborFile(
	relPath: string,
	content: string | undefined,
	ctx: ValidateContext,
): Promise<ConfigError[]> {
	const parts = relPath.split("/");
	if (relPath === "config.yml") {
		return content === undefined ? [] : parseConfigText(content, ctx.home).errors;
	}
	if (relPath === "mcp.json") return content === undefined ? [] : validateMcp(content);
	if (parts.length === 2 && parts[0] === "agents" && relPath.endsWith(".md")) {
		if (content === undefined) return [];
		return parseAgentFile(content, join(ctx.toborDir, relPath), "node").errors;
	}
	if (parts.length === 3 && parts[0] === "skills" && parts[2] === "SKILL.md") {
		return content === undefined ? [] : validateSkill(content);
	}
	if (parts.length >= 3 && parts[0] === "design-systems") return validateDesignDir(parts[1] ?? "", relPath, content, ctx);
	return [];
}

function validateMcp(content: string): ConfigError[] {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (error) {
		return [{ path: "", message: `invalid JSON: ${(error as Error).message}` }];
	}
	return validateMcpJson(raw).errors;
}

function validateSkill(content: string): ConfigError[] {
	const { frontmatter } = splitFrontmatter(content);
	if (frontmatter === undefined) return [{ path: "", message: "missing --- frontmatter" }];
	let raw: unknown;
	try {
		raw = parseYaml(frontmatter);
	} catch (error) {
		return [{ path: "", message: `frontmatter: ${(error as Error).message}` }];
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return [{ path: "", message: "frontmatter must be a mapping" }];
	}
	const fm = raw as Record<string, unknown>;
	const errors: ConfigError[] = [];
	for (const key of ["name", "description"]) {
		const v = fm[key];
		if (typeof v !== "string" || v.trim() === "") errors.push({ path: key, message: "required string" });
	}
	return errors;
}

/** A theme directory that still holds anything after the change must contain `tokens.css`. */
async function validateDesignDir(
	name: string,
	relPath: string,
	content: string | undefined,
	ctx: ValidateContext,
): Promise<ConfigError[]> {
	const dir = join(ctx.toborDir, "design-systems", name);
	const entries = new Set(await readdir(dir).catch(() => [] as string[]));
	const top = relPath.split("/")[2] ?? "";
	if (content !== undefined) entries.add(top);
	else if (relPath === `design-systems/${name}/${top}`) entries.delete(top);
	if (entries.size === 0 || entries.has("tokens.css")) return [];
	return [{ path: `design-systems/${name}/tokens.css`, message: `design system ${name} must contain tokens.css` }];
}
