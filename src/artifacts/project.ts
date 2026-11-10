import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

/** Where a cwd's artifacts belong: its git root (or the cwd) and a stable project id. */
export type ProjectInfo = {
	projectId: string;
	/** Git work tree root, else the realpath of the cwd. */
	root: string;
	name: string;
	/** Identity key hashed into `projectId`. */
	key: string;
};

function git(cwd: string, args: string[]): Promise<string | undefined> {
	const { promise, resolve: done } = Promise.withResolvers<string | undefined>();
	execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => done(error ? undefined : stdout.trim()));
	return promise;
}

/** `"proj_" + sha256(key).slice(0, 12)`. */
export function projectIdFor(key: string): string {
	return `proj_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Git root of `cwd`, or undefined outside a work tree. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Project identity: `git:<first commit>` (`:wt:<gitdir name>` for linked worktrees), else `path:<realpath>`. */
export async function projectInfo(cwd: string): Promise<ProjectInfo> {
	const real = await realpath(cwd);
	const root = await gitRoot(real);
	if (root) {
		const roots = await git(root, ["rev-list", "--max-parents=0", "HEAD"]);
		const first = roots?.split("\n").filter(Boolean).at(-1);
		if (first) {
			let key = `git:${first}`;
			const [gitDir, commonDir] = await Promise.all([
				git(root, ["rev-parse", "--absolute-git-dir"]),
				git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			]);
			if (gitDir && commonDir && resolve(gitDir) !== resolve(commonDir)) key += `:wt:${basename(gitDir)}`;
			return { projectId: projectIdFor(key), root, name: basename(root), key };
		}
	}
	const base = root ?? real;
	const key = `path:${base}`;
	return { projectId: projectIdFor(key), root: base, name: basename(base), key };
}
