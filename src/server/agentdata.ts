// The node-level `$TOBOR_HOME/.tobor/` git repo (design: "Agent data", "Self-editing"). Operator edits arrive through
// `write`/`remove` and are validated before they touch disk; agent edits land on disk directly and are picked up by
// `watch()`, validated, guarded and committed as `agent: <paths>`. Every git operation runs through one queue.
import { execFile } from "node:child_process";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition, PutToborFileRequest, ToborFileResponse, ToborFileWriteResponse } from "../api/types.js";
import type { HomePaths } from "../config/home.js";
import { parseConfigText } from "../config/load.js";
import type { Config, ConfigError } from "../config/schema.js";
import type { EventBus } from "../events.js";
import { type AgentDataCommit, type AgentDataService, HostError } from "../host.js";
import { loadAgents } from "./harness/workers/agents.js";
import { validateToborFile } from "./validate.js";

const run = promisify(execFile);

/** `config.yml` keys only the operator may change (via the API); agent edits to them are reverted. */
export const OPERATOR_ONLY_KEYS = [
	"defaults.approval_mode",
	"mcp.approval",
	"roots",
	"listen",
	"artifacts_listen",
] as const;

/** An agent edit that was reverted: failed validation or touched an operator-only key. */
export type InvalidChange = {
	/** Paths (relative to `.tobor/`) restored to their last committed state. */
	reverted: string[];
	errors: ConfigError[];
};

export type AgentDataOptions = {
	home: string;
	paths: HomePaths;
	/** Current node config (read at use). */
	config: () => Config;
	events: EventBus;
	/** Debounce of the `.tobor/` watcher, in ms (default 500). */
	debounceMs?: number;
	/** Reverted agent edits; default logs to stderr. */
	onInvalid?: (change: InvalidChange) => void;
};

/** Git-backed `AgentDataService` over `$TOBOR_HOME/.tobor`. */
export class AgentData implements AgentDataService {
	private readonly dir: string;
	private queue: Promise<unknown> = Promise.resolve();
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private rootReal?: string;

	constructor(private readonly o: AgentDataOptions) {
		this.dir = o.paths.toborDir;
	}

	async listAgents(cwd?: string): Promise<AgentDefinition[]> {
		return (await loadAgents(this.o.paths.agentsDir, cwd)).agents;
	}

	async getAgent(name: string, cwd?: string): Promise<AgentDefinition | undefined> {
		return (await this.listAgents(cwd)).find((a) => a.name === name);
	}

	async read(path: string): Promise<ToborFileResponse | undefined> {
		const { rel, abs } = await this.resolve(path);
		const st = await lstat(abs).catch(() => undefined);
		if (!st) return undefined;
		if (st.isDirectory()) {
			const entries = (await readdir(abs, { withFileTypes: true }))
				.filter((e) => e.name !== ".git" && !(rel === "" && e.name.toLowerCase() === "state"))
				.map((e) => ({ name: e.name, type: e.isDirectory() ? ("dir" as const) : ("file" as const) }))
				.sort((a, b) => a.name.localeCompare(b.name));
			return { type: "dir", path: rel, entries };
		}
		const content = await readFile(abs, "utf8");
		const sha = await this.blobSha(rel);
		return { type: "file", path: rel, content, ...(sha ? { sha } : {}) };
	}

	async write(path: string, request: PutToborFileRequest): Promise<ToborFileWriteResponse> {
		const { rel, abs } = await this.resolve(path);
		if (rel === "") throw new HostError(400, "invalid_path", "a file path is required");
		return this.serial(async () => {
			if ((await lstat(abs).catch(() => undefined))?.isDirectory()) {
				throw new HostError(400, "invalid_path", `${rel} is a directory`);
			}
			await this.checkSha(rel, request.sha);
			const errors = await validateToborFile(rel, request.content, { home: this.o.home, toborDir: this.dir });
			if (errors.length > 0) throw new HostError(422, "invalid", `${rel} is invalid`, errors);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, request.content);
			return { ok: true, commit: await this.commit([rel], request.message ?? `operator: ${rel}`) };
		});
	}

	async remove(path: string): Promise<ToborFileWriteResponse> {
		const { rel, abs } = await this.resolve(path);
		if (rel === "") throw new HostError(400, "invalid_path", "a file path is required");
		return this.serial(async () => {
			const st = await lstat(abs).catch(() => undefined);
			if (!st) throw new HostError(404, "not_found", `${rel} does not exist`);
			if (st.isDirectory()) throw new HostError(400, "invalid_path", `${rel} is a directory`);
			const errors = await validateToborFile(rel, undefined, { home: this.o.home, toborDir: this.dir });
			if (errors.length > 0) throw new HostError(422, "invalid", `deleting ${rel} is invalid`, errors);
			await rm(abs);
			return { ok: true, commit: await this.commit([rel], `operator: delete ${rel}`) };
		});
	}

	async history(opts: { path?: string; limit?: number }): Promise<AgentDataCommit[]> {
		const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 1000);
		const args = ["log", "--format=%H%x1f%cI%x1f%s", "-n", String(limit)];
		if (opts.path) args.push("--", (await this.resolve(opts.path)).rel || ".");
		let stdout: string;
		try {
			stdout = await this.git(args);
		} catch {
			return []; // no commits yet
		}
		return stdout
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => {
				const [sha = "", date = "", message = ""] = line.split("\x1f");
				return { sha, date, message };
			});
	}

	async diff(opts: { commit?: string; path?: string }): Promise<string> {
		const commit = opts.commit ?? "HEAD";
		if (commit !== "HEAD" && !/^[0-9a-f]{4,64}$/i.test(commit)) {
			throw new HostError(400, "invalid_commit", "commit must be a hex sha");
		}
		const args = ["show", "--format=", "--patch", commit];
		if (opts.path) args.push("--", (await this.resolve(opts.path)).rel || ".");
		try {
			return await this.git(args);
		} catch {
			throw new HostError(404, "not_found", `unknown commit ${commit}`);
		}
	}

	/** Start the debounced watcher that commits agent edits; also sweeps changes made while the node was down. */
	async watch(): Promise<void> {
		if (this.watcher) return;
		this.watcher = fsWatch(this.dir, { recursive: true }, (_event, filename) => {
			const name = filename?.toString();
			if (name === ".git" || name?.startsWith(`.git${sep}`)) return;
			if (name === "state" || name?.startsWith(`state${sep}`)) return;
			this.schedule();
		});
		this.watcher.on("error", (error) => console.error("tobor: .tobor watcher failed:", error));
		this.schedule();
	}

	/** Stop watching and wait for in-flight git work. */
	async stop(): Promise<void> {
		this.watcher?.close();
		this.watcher = undefined;
		clearTimeout(this.timer);
		this.timer = undefined;
		await this.queue.catch(() => {});
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.serial(() => this.sweep()).catch((error) => console.error("tobor: committing .tobor changes failed:", error));
		}, this.o.debounceMs ?? 500);
	}

	/** Validate and commit uncommitted changes (made outside `write`/`remove`); revert the invalid ones. */
	private async sweep(): Promise<void> {
		const changed = (await this.changedPaths()).filter((rel) => !isStatePath(rel));
		if (changed.length === 0) return;
		const ctx = { home: this.o.home, toborDir: this.dir };
		const good: string[] = [];
		const reverted: string[] = [];
		const errors: ConfigError[] = [];
		for (const rel of changed) {
			const content = await readFile(join(this.dir, rel), "utf8").catch(() => undefined);
			const found = (await validateToborFile(rel, content, ctx)).map((e) => ({
				path: e.path ? `${rel}: ${e.path}` : rel,
				message: e.message,
			}));
			if (rel === "config.yml") found.push(...(await this.guardrail(content)));
			if (found.length === 0) {
				good.push(rel);
				continue;
			}
			errors.push(...found);
			reverted.push(rel);
			await this.revert(rel);
		}
		if (good.length > 0) {
			const shown = good.length > 3 ? `${good.slice(0, 3).join(", ")} and ${good.length - 3} more` : good.join(", ");
			await this.commit(good, `agent: ${shown}`);
		}
		if (reverted.length > 0) {
			const change = { reverted, errors };
			if (this.o.onInvalid) this.o.onInvalid(change);
			else console.error(`tobor: reverted invalid .tobor edits (${reverted.join(", ")}):`, errors);
		}
	}

	/** Errors for operator-only keys whose (normalized) value differs from the committed `config.yml`. */
	private async guardrail(content: string | undefined): Promise<ConfigError[]> {
		const before = parseConfigText(await this.git(["show", "HEAD:config.yml"]).catch(() => ""), this.o.home).config;
		const after = parseConfigText(content ?? "", this.o.home).config;
		return OPERATOR_ONLY_KEYS.filter(
			(key) => JSON.stringify(pick(before, key)) !== JSON.stringify(pick(after, key)),
		).map((key) => ({ path: `config.yml: ${key}`, message: "operator-only; change it through the API" }));
	}

	/** Restore `rel` to HEAD, or delete it when it is not committed. */
	private async revert(rel: string): Promise<void> {
		if (await this.blobSha(rel)) {
			await this.git(["checkout", "HEAD", "--", rel]);
			return;
		}
		await this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", rel]);
		await rm(join(this.dir, rel), { force: true });
	}

	/** Paths with uncommitted changes (worktree or index), relative to `.tobor/`. */
	private async changedPaths(): Promise<string[]> {
		// `state/` is excluded at the git level, so editing `.gitignore` can never expose it to the sweep.
		const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude)state"]);
		const fields = out.split("\0");
		const paths = new Set<string>();
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i] ?? "";
			if (field.length < 4) continue;
			paths.add(field.slice(3));
			// Renames and copies carry the source path as the next field.
			if (field[0] === "R" || field[0] === "C") paths.add(fields[++i] ?? "");
		}
		paths.delete("");
		return [...paths].sort();
	}

	/** Stage and commit exactly `rels`; returns the new HEAD (or the current one when nothing changed). */
	private async commit(all: string[], message: string): Promise<string> {
		const rels = all.filter((rel) => !isStatePath(rel));
		if (rels.length === 0) return (await this.git(["rev-parse", "HEAD"]).catch(() => "")).trim();
		await this.git(["add", "-A", "--", ...rels]);
		const staged = await this.git(["diff", "--cached", "--name-only", "-z", "--", ...rels]);
		if (staged === "") return (await this.git(["rev-parse", "HEAD"]).catch(() => "")).trim();
		await this.git(["commit", "-q", "--no-verify", "-m", message, "--", ...rels]);
		const commit = (await this.git(["rev-parse", "HEAD"])).trim();
		this.o.events.emit({ type: "agent.committed", commit, message, paths: staged.split("\0").filter(Boolean) });
		return commit;
	}

	private async checkSha(rel: string, expected: string | undefined): Promise<void> {
		if (expected === undefined) return;
		const current = await this.blobSha(rel);
		if (current !== expected) {
			throw new HostError(409, "stale", `${rel} changed since sha ${expected} (now ${current ?? "absent"})`);
		}
	}

	/** Blob sha of `rel` in HEAD; undefined when not committed. */
	private async blobSha(rel: string): Promise<string | undefined> {
		const out = await this.git(["rev-parse", "--verify", "-q", `HEAD:${rel}`]).catch(() => "");
		return out.trim() || undefined;
	}

	/**
	 * Normalize a client path (relative to `.tobor/`, `/`-separated) and prove it stays inside `.tobor/`, symlinks
	 * included. `.git` and the top-level `state/` (node state) are never addressable. The empty path is the root.
	 */
	private async resolve(path: string): Promise<{ rel: string; abs: string }> {
		const parts = path.split("/").filter((p) => p !== "" && p !== ".");
		if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
			throw new HostError(400, "invalid_path", "path must be relative to .tobor/");
		}
		if (parts.some((p) => p === ".." || p.toLowerCase() === ".git") || parts[0]?.toLowerCase() === "state") {
			throw new HostError(403, "forbidden_path", "path escapes .tobor/");
		}
		const rel = parts.join("/");
		const abs = rel === "" ? this.dir : join(this.dir, ...parts);
		this.rootReal ??= await realpath(this.dir);
		let probe = abs;
		while (!(await lstat(probe).then(() => true, () => false)) && probe !== this.dir) probe = dirname(probe);
		const real = await realpath(probe).catch(() => probe);
		if (real !== this.rootReal && !real.startsWith(this.rootReal + sep)) {
			throw new HostError(403, "forbidden_path", "path escapes .tobor/");
		}
		return { rel, abs };
	}

	private async git(args: string[]): Promise<string> {
		const env = { ...process.env };
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[key];
		// Pin the repo: never fall through to an enclosing repository when `.tobor/.git` is missing.
		const pinned = [`--git-dir=${join(this.dir, ".git")}`, `--work-tree=${this.dir}`];
		const config = ["-c", "user.name=tobor", "-c", "user.email=tobor@localhost", "-c", "commit.gpgsign=false"];
		const { stdout } = await run("git", [...pinned, ...config, "-c", "core.quotepath=off", ...args], {
			cwd: this.dir,
			env,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => {});
		return next;
	}
}

/** The top-level `state/` (node state): never staged, committed or swept, whatever `.gitignore` says. */
function isStatePath(rel: string): boolean {
	return rel === "state" || rel.startsWith("state/");
}

/** The value at a dotted key path. */
function pick(value: unknown, key: string): unknown {
	let cur = value;
	for (const k of key.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[k];
	return cur;
}
