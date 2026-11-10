import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { HostError } from "../../host.js";

/** Parse dotenv-style text: `KEY=value`, optional `export `, `#` comments, single/double quotes (`\n` in double). */
export function parseEnvText(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1]!;
		let value = m[2]!;
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
			value = value.slice(1, -1);
			if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		} else {
			value = value.replace(/\s+#.*$/, "");
		}
		out[key] = value;
	}
	return out;
}

/** Read the `env_file`; a missing file is empty. */
export async function loadEnvFile(path: string): Promise<Record<string, string>> {
	try {
		return parseEnvText(await readFile(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

/** Options for `EnvCache`. */
export type EnvCacheOptions = {
	/** Variables layered over `process.env` for shell commands. */
	shellEnv: Readonly<Record<string, string>>;
	/** Idle time (ms) before an entry is cleaned up and evicted; read at each use. */
	idleMs: () => number;
};

type CacheEntry = { env: NodeExecutionEnv; timer: NodeJS.Timeout };

/** One `NodeExecutionEnv` per cwd, released after `idleMs` without use. Pass `cache.env` as `HarnessOptions.env`. */
export class EnvCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly shellEnv: NodeJS.ProcessEnv;

	constructor(private readonly options: EnvCacheOptions) {
		this.shellEnv = { ...process.env, ...options.shellEnv };
	}

	/** `HarnessOptions.env`: undefined without a cwd (the system conversation). */
	readonly env = (target: EnvTarget): NodeExecutionEnv | undefined => {
		const cwd = target.cwd;
		if (!cwd) return undefined;
		const existing = this.entries.get(cwd);
		if (existing) clearTimeout(existing.timer);
		const env = existing?.env ?? new NodeExecutionEnv({ cwd, shellEnv: this.shellEnv });
		const timer = setTimeout(() => void this.evict(cwd), this.options.idleMs());
		timer.unref();
		this.entries.set(cwd, { env, timer });
		return env;
	};

	/** Number of cached cwds. */
	get size(): number {
		return this.entries.size;
	}

	/** Clean up and drop every entry (shutdown). */
	async cleanup(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((cwd) => this.evict(cwd)));
	}

	private async evict(cwd: string): Promise<void> {
		const entry = this.entries.get(cwd);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.entries.delete(cwd);
		await entry.env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
	}
}

/** Resolve a session cwd: absolute, an existing directory, realpath inside a (realpath'd) root. */
export async function resolveCwd(cwd: string, roots: readonly string[]): Promise<string> {
	if (!isAbsolute(cwd)) throw new HostError(400, "invalid_cwd", `cwd must be absolute: ${cwd}`);
	let real: string;
	try {
		real = await realpath(cwd);
		if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
	} catch (err) {
		throw new HostError(400, "invalid_cwd", `cwd ${cwd}: ${(err as Error).message}`);
	}
	for (const root of roots) {
		const realRoot = await realpath(root).catch(() => undefined);
		if (realRoot && isInside(realRoot, real)) return real;
	}
	throw new HostError(403, "outside_roots", `cwd ${cwd} is outside the configured roots`);
}

/** True when `path` equals `root` or lies below it. */
export function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The nearest ancestor of `dir` (inclusive) holding `.git`, or undefined. */
export async function findGitRoot(dir: string): Promise<string | undefined> {
	for (let cur = dir; ; cur = dirname(cur)) {
		if (await stat(join(cur, ".git")).then(() => true, () => false)) return cur;
		if (dirname(cur) === cur) return undefined;
	}
}
