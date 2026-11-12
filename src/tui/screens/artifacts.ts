import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactRevision, SessionId } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

/** `<dir>/<project>-<slug>-r<n>.pdf`, by default in `~/Downloads`. */
export function pdfPath(rev: ArtifactRevision, dir = join(homedir(), "Downloads")): string {
	const safe = `${rev.projectId}-${rev.slug}-r${rev.revision}`.replace(/[^A-Za-z0-9._-]+/g, "_");
	return join(dir, `${safe}.pdf`);
}

/** The session whose artifacts `/artifacts` shows: the open session, or a worker's parent. Undefined when none is open. */
function currentSessionId(app: App): SessionId | undefined {
	const target = app.session.target;
	return target?.worker ? target.worker.parent.id : target?.id;
}

/** Artifacts feed, by default of the open session (`a` toggles to all, `s` back): Enter prints the viewer URLs, `p` saves the latest revision's PDF (prefs `pdf_dir`, default ~/Downloads), `v` lists revisions. */
export async function showArtifacts(app: App, scope?: "session" | "all"): Promise<void> {
	const client = app.api();
	const sessionId = currentSessionId(app);
	const inSession = scope !== "all" && sessionId !== undefined;
	const artifacts = await client.artifacts(inSession ? { session: sessionId } : {});
	const toggle = inSession ? "a: all artifacts" : sessionId !== undefined ? "s: this session" : undefined;
	const picked = await app.pick(
		inSession ? `artifacts · #${sessionId}` : "artifacts · all",
		artifacts.map((a) => ({
			value: a,
			label: a.title,
			description: `${a.projectId}/${a.slug} · r${a.latest.revision} of ${a.revisions} · ${new Date(a.latest.createdAt).toLocaleString()}`,
		})),
		{
			hint: `Enter URL · p download PDF · v revisions${toggle ? ` · ${toggle}` : ""} · Esc close`,
			keys: toggle ? ["p", "v", inSession ? "a" : "s"] : ["p", "v"],
		},
	);
	if (picked?.key === "a" && inSession) return showArtifacts(app, "all");
	if (picked?.key === "s" && !inSession && sessionId !== undefined) return showArtifacts(app, "session");
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
		else await app.info(`${artifact.title} r${rev.value.revision}`, [c.accent("viewer"), rev.value.url, "", c.accent("pdf"), rev.value.pdfUrl]);
		return;
	}
	await app.info(artifact.title, [
		c.accent("latest"),
		artifact.url,
		"",
		c.accent(`this revision (r${artifact.latest.revision})`),
		artifact.latest.url,
		"",
		c.accent("pdf"),
		artifact.latest.pdfUrl,
		"",
		c.dim("select with the mouse to copy · p in the list saves the PDF"),
	]);
}

async function downloadPdf(app: App, rev: ArtifactRevision): Promise<void> {
	app.flash(`rendering PDF of ${rev.title}…`);
	const bytes = await app.api().download(rev.pdfUrl);
	const dir = app.config.prefs?.pdf_dir;
	const path = dir ? pdfPath(rev, dir.replace(/^~(?=\/|$)/, homedir())) : pdfPath(rev);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
	app.flash(`saved ${path}`);
}
