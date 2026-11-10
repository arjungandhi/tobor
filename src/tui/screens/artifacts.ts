import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactRevision } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

/** `~/Downloads/<project>-<slug>-r<n>.pdf`. */
export function pdfPath(rev: ArtifactRevision, dir = join(homedir(), "Downloads")): string {
	const safe = `${rev.projectId}-${rev.slug}-r${rev.revision}`.replace(/[^A-Za-z0-9._-]+/g, "_");
	return join(dir, `${safe}.pdf`);
}

/** Artifacts feed: Enter prints the viewer URLs, `p` saves the latest revision's PDF to ~/Downloads, `v` lists revisions. */
export async function showArtifacts(app: App): Promise<void> {
	const client = app.api();
	const artifacts = await client.artifacts();
	const picked = await app.pick(
		"artifacts",
		artifacts.map((a) => ({
			value: a,
			label: a.title,
			description: `${a.projectId}/${a.slug} · r${a.latest.revision} of ${a.revisions} · ${new Date(a.latest.createdAt).toLocaleString()}`,
		})),
		{ hint: "Enter URL · p download PDF · v revisions · Esc close", keys: ["p", "v"] },
	);
	if (!picked?.value) return;
	const artifact = picked.value;
	if (picked.key === "p") {
		await downloadPdf(app, artifact.latest);
		return;
	}
	if (picked.key === "v") {
		const revisions = await client.revisions(artifact.projectId, artifact.slug);
		const rev = await app.pick(
			`${artifact.title} · revisions`,
			revisions.map((r) => ({ value: r, label: `r${r.revision}`, description: `${new Date(r.createdAt).toLocaleString()} · ${r.rev}` })),
			{ hint: "Enter URL · p download PDF · Esc close", keys: ["p"] },
		);
		if (!rev?.value) return;
		if (rev.key === "p") await downloadPdf(app, rev.value);
		else await app.info(`${artifact.title} r${rev.value.revision}`, [c.gold("viewer"), rev.value.url, "", c.gold("pdf"), rev.value.pdfUrl]);
		return;
	}
	await app.info(artifact.title, [
		c.gold("latest"),
		artifact.url,
		"",
		c.gold(`this revision (r${artifact.latest.revision})`),
		artifact.latest.url,
		"",
		c.gold("pdf"),
		artifact.latest.pdfUrl,
		"",
		c.dim("select with the mouse to copy · p in the list saves the PDF"),
	]);
}

async function downloadPdf(app: App, rev: ArtifactRevision): Promise<void> {
	app.flash(`rendering PDF of ${rev.title}…`);
	const bytes = await app.api().download(rev.pdfUrl);
	const path = pdfPath(rev);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
	app.flash(`saved ${path}`);
}
