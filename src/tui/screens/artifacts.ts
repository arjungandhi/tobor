import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactRevision, ArtifactSummary, SessionId } from "../../api/types.js";
import type { App } from "../app.js";
import { type NavOutcome, navigate } from "../nav.js";
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

/** Artifacts feed, by default of the open session (`a` toggles to all, `s` back): Enter prints the viewer URLs, `p` saves the latest revision's PDF (prefs `pdf_dir`, default ~/Downloads), `v` lists revisions. Every action comes back to this list with the cursor on the same artifact. */
export async function showArtifacts(app: App, scope?: "session" | "all"): Promise<void> {
	const client = app.api();
	const sessionId = currentSessionId(app);
	let inSession = scope !== "all" && sessionId !== undefined;
	await navigate<ArtifactSummary>(app, {
		view: async () => {
			const artifacts = await client.artifacts(inSession ? { session: sessionId } : {});
			const toggle = inSession ? "a: all artifacts" : sessionId !== undefined ? "s: this session" : undefined;
			return {
				title: inSession ? `artifacts · #${sessionId}` : "artifacts · all",
				items: artifacts.map((a) => ({
					value: a,
					label: a.title,
					description: `${a.projectId}/${a.slug} · r${a.latest.revision} of ${a.revisions} · ${new Date(a.latest.createdAt).toLocaleString()}`,
				})),
				hint: `Enter URL · p download PDF · v revisions${toggle ? ` · ${toggle}` : ""} · Esc back`,
				emptyHint: "Esc back",
				keys: toggle ? ["p", "v", inSession ? "a" : "s"] : ["p", "v"],
			};
		},
		key: (a) => `${a.projectId}/${a.slug}`,
		onPick: async (picked) => {
			if (picked.key === "a" && inSession) {
				inSession = false;
				return "refresh";
			}
			if (picked.key === "s" && !inSession && sessionId !== undefined) {
				inSession = true;
				return "refresh";
			}
			const artifact = picked.value;
			if (!artifact) return "stay";
			if (picked.key === "p") {
				await downloadPdf(app, artifact.latest);
				return "stay";
			}
			if (picked.key === "v") {
				await showRevisions(app, artifact);
				return "stay";
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
			return "stay";
		},
	});
}

/** The revisions of one artifact; Esc goes back to the artifacts list. */
async function showRevisions(app: App, artifact: ArtifactSummary): Promise<void> {
	const revisions = await app.api().revisions(artifact.projectId, artifact.slug);
	await navigate<ArtifactRevision>(app, {
		view: () => ({
			title: `${artifact.title} · revisions`,
			items: revisions.map((r) => ({ value: r, label: `r${r.revision}`, description: `${new Date(r.createdAt).toLocaleString()} · ${r.rev}` })),
			hint: "Enter URL · p download PDF · Esc back",
			emptyHint: "Esc back",
			keys: ["p"],
		}),
		key: (r) => String(r.revision),
		onPick: async (picked): Promise<NavOutcome> => {
			const rev = picked.value;
			if (!rev) return "stay";
			if (picked.key === "p") await downloadPdf(app, rev);
			else await app.info(`${artifact.title} r${rev.revision}`, [c.accent("viewer"), rev.url, "", c.accent("pdf"), rev.pdfUrl]);
			return "stay";
		},
	});
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
