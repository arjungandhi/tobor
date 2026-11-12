import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PathCompleteEntry, PathCompleteResponse } from "../../api/types.js";
import { expandTilde } from "../../config/home.js";
import { isInside } from "./env.js";

/** Most entries one completion returns. */
export const COMPLETE_LIMIT = 50;

/**
 * List the entries that complete `prefix` (a raw path token: empty, relative to `cwd`, absolute or `~/…`).
 * Best-effort: a parent that is missing, not a directory or outside the (realpath'd) `roots` yields no entries, never an error.
 */
export async function completePath(prefix: string, cwd: string, roots: readonly string[]): Promise<PathCompleteResponse> {
	// Split the raw token (not the resolved path, which would swallow `.`, `..` and a trailing slash).
	const token = prefix === "~" ? "~/" : prefix;
	const slash = token.lastIndexOf("/");
	const dirPart = token.slice(0, slash + 1);
	const base = token.slice(slash + 1);
	const parent = resolve(cwd, dirPart === "" ? "." : expandTilde(dirPart));

	let real: string;
	try {
		real = await realpath(parent);
		if (!(await stat(real)).isDirectory()) return { dir: parent, entries: [] };
	} catch {
		return { dir: parent, entries: [] };
	}
	let allowed = false;
	for (const root of roots) {
		const realRoot = await realpath(root).catch(() => undefined);
		if (realRoot && isInside(realRoot, real)) {
			allowed = true;
			break;
		}
	}
	if (!allowed) return { dir: parent, entries: [] };

	const names = await readdir(real).catch(() => [] as string[]);
	const wanted = base.toLowerCase();
	const showHidden = base.startsWith(".");
	const entries: PathCompleteEntry[] = [];
	for (const name of names) {
		if (name.startsWith(".") && !showHidden) continue;
		if (!name.toLowerCase().startsWith(wanted)) continue;
		const isDir = await stat(join(real, name)).then((s) => s.isDirectory(), () => false);
		entries.push({ name, type: isDir ? "dir" : "file" });
	}
	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		const la = a.name.toLowerCase();
		const lb = b.name.toLowerCase();
		return la < lb ? -1 : la > lb ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	return { dir: real, entries: entries.slice(0, COMPLETE_LIMIT) };
}
