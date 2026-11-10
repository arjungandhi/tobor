import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ApiRequestError } from "../client.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

/** Agent files: browse `.tobor/`; Enter on a file opens `$EDITOR` on a temp copy and PUTs it back when changed. */
export async function showFiles(app: App, dir = ""): Promise<void> {
	const listing = await app.api().file(dir);
	if (listing.type === "file") return editFile(app, listing.path);
	const entries = [...listing.entries].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
	const items = [
		...(dir ? [{ value: "..", label: "..", description: "up" }] : []),
		...entries.map((e) => ({ value: e.name, label: e.type === "dir" ? c.gold(`${e.name}/`) : e.name, description: e.type })),
	];
	const picked = await app.pick(`.tobor/${dir}`, items, { hint: "Enter open · Esc close" });
	if (!picked?.value) return;
	if (picked.value === "..") return showFiles(app, dir.split("/").slice(0, -1).join("/"));
	const path = dir ? `${dir}/${picked.value}` : picked.value;
	if (entries.find((e) => e.name === picked.value)?.type === "dir") return showFiles(app, path);
	await editFile(app, path);
	return showFiles(app, dir);
}

async function editFile(app: App, path: string): Promise<void> {
	const client = app.api();
	const file = await client.file(path);
	if (file.type !== "file") throw new Error(`${path} is a directory`);
	const tmp = await mkdtemp(join(tmpdir(), "tobor-edit-"));
	const local = join(tmp, basename(path));
	try {
		await writeFile(local, file.content);
		for (;;) {
			const editor = process.env.VISUAL || process.env.EDITOR || "vi";
			const quoted = `'${local.replace(/'/g, "'\\''")}'`;
			const result = await app.suspend(() => spawnSync(`${editor} ${quoted}`, { stdio: "inherit", shell: true }));
			if (result.error) throw new Error(`${editor}: ${result.error.message}`);
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
				if (!(err instanceof ApiRequestError) || (err.status !== 422 && err.status !== 409)) throw err;
				const problems = err.body?.errors?.map((e) => `${c.gold(e.path)} ${e.message}`) ?? [err.body?.error ?? err.message];
				const again = await app.confirm(err.status === 409 ? `${path} changed on the node` : `${path} rejected`, [
					...problems,
					"",
					err.status === 409 ? "Someone else committed this file since you opened it." : "Edit again? (No discards your changes.)",
				]);
				if (!again || err.status === 409) return;
			}
		}
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
