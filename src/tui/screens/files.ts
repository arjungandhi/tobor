import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ApiRequestError } from "../client.js";
import type { App } from "../app.js";
import { navigate } from "../nav.js";
import { c } from "../theme.js";

/** Agent files: browse `.tobor/`, one level per directory (Esc / ← go up one directory, Esc at the root closes); Enter on a file opens the editor (prefs `editor`, `$VISUAL`, `$EDITOR`, vi) on a temp copy and PUTs it back when changed. */
export async function showFiles(app: App, dir = ""): Promise<void> {
	const listing = await app.api().file(dir);
	if (listing.type === "file") return editFile(app, listing.path);
	// ← on a directory the screen was opened at (not just reached) climbs from there.
	while ((await browse(app, dir)) === "up" && dir) dir = parentDir(dir);
}

function parentDir(dir: string): string {
	return dir.split("/").slice(0, -1).join("/");
}

/** One directory as a list. Resolves "up" for ←, "close" for Esc; subdirectories are nested browses, so coming back lands on the directory you left. */
function browse(app: App, dir: string): Promise<"close" | "up"> {
	const kinds = new Map<string, string>();
	return navigate<string>(app, {
		view: async () => {
			const listing = await app.api().file(dir);
			if (listing.type === "file") throw new Error(`${dir} is a file`);
			const entries = [...listing.entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
			kinds.clear();
			for (const e of entries) kinds.set(e.name, e.type);
			return {
				title: `.tobor/${dir}`,
				items: entries.map((e) => ({ value: e.name, label: e.type === "dir" ? c.accent(`${e.name}/`) : e.name, description: e.type })),
				hint: `Enter open${dir ? " · ← up" : ""} · Esc back`,
				emptyHint: dir ? "← up · Esc back" : "Esc back",
				keys: dir ? ["left"] : [],
			};
		},
		key: (name) => name,
		onPick: async (picked) => {
			if (picked.key === "left") return "up";
			if (picked.value === undefined) return "stay";
			const path = dir ? `${dir}/${picked.value}` : picked.value;
			if (kinds.get(picked.value) === "dir") {
				await browse(app, path); // Esc and ← both come back to this directory
				return "stay";
			}
			await editFile(app, path);
			return "refresh"; // the directory is re-read (a saved file may have changed it) with the cursor on the edited file
		},
	});
}

async function editFile(app: App, path: string): Promise<void> {
	const client = app.api();
	const opened = await client.file(path);
	if (opened.type !== "file") throw new Error(`${path} is a directory`);
	let file: typeof opened = opened;
	const tmp = await mkdtemp(join(tmpdir(), "tobor-edit-"));
	const local = join(tmp, basename(path));
	// The temp copy holds the user's edits: only a confirmed save (or no changes) may delete it.
	let keep = false;
	try {
		await writeFile(local, file.content);
		for (;;) {
			const editor = app.config.prefs?.editor || process.env.VISUAL || process.env.EDITOR || "vi";
			const quoted = `'${local.replace(/'/g, "'\\''")}'`;
			const result = await app.suspend(() => spawnSync(`${editor} ${quoted}`, { stdio: "inherit", shell: true }));
			if (result.error) throw new Error(`${editor}: ${result.error.message}`);
			if (result.status !== 0 || result.signal) {
				const edited = (await readFile(local, "utf8").catch(() => file.content)) !== file.content;
				keep = edited;
				app.flash(`✗ editor \`${editor}\` failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}); ${path} not saved${edited ? ` · edits kept at ${local}` : ""}`);
				return;
			}
			const content = await readFile(local, "utf8");
			if (content === file.content) {
				app.flash(`${path}: no changes`);
				return;
			}
			try {
				const { commit } = await client.putFile(path, { content, ...(file.sha ? { sha: file.sha } : {}) });
				app.flash(`${path} saved · ${commit.slice(0, 8)}`);
				return;
			} catch (err) {
				if (!(err instanceof ApiRequestError) || (err.status !== 422 && err.status !== 409)) {
					keep = true;
					throw new Error(`${(err as Error).message} · your edit is kept at ${local}`);
				}
				const problems = err.body?.errors?.map((e) => `${c.accent(e.path)} ${e.message}`) ?? [err.body?.error ?? err.message];
				const again = await app.confirm(err.status === 409 ? `${path} changed on the node` : `${path} rejected`, [
					...problems,
					"",
					err.status === 409
						? "Someone else committed this file since you opened it. Edit again against the latest version (saving replaces it; that version is written next to your copy as .remote)? No keeps your copy."
						: "Edit again? (No keeps your changes in the temp copy.)",
				]);
				if (!again) {
					keep = true;
					app.flash(`✗ ${path} not saved · your edit is kept at ${local}`);
					return;
				}
				if (err.status === 409) {
					// Take the node's current version as the new baseline; the user's edit stays in `local`, the node's copy goes next to it to reconcile against.
					keep = true;
					try {
						const latest = await client.file(path);
						if (latest.type !== "file") throw new Error(`${path} is a directory`);
						await writeFile(`${local}.remote`, latest.content);
						file = latest;
					} catch (fetchErr) {
						throw new Error(`${path}: fetching the latest version failed: ${(fetchErr as Error).message} · your edit is kept at ${local}`);
					}
					keep = false;
				}
			}
		}
	} finally {
		if (!keep) await rm(tmp, { recursive: true, force: true });
	}
}
