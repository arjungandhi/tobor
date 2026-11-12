import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "../../../host.js";
import { invalid, parseInt10, sendJson } from "../json.js";
import type { Router } from "../router.js";

/** Artifact listings on the API origin. */
export function artifactsRoutes(r: Router): void {
	r.on("GET", "/api/artifacts", async ({ host, query }) => {
		const projectId = query.get("project") || undefined;
		const session = parseInt10(query.get("session"), "session");
		if (session === 0) throw invalid("session must be a positive integer");
		const conversations =
			session === undefined
				? undefined
				: [session, ...(await host.workers.list(session)).flatMap((w) => (w.conversationId === undefined ? [] : [w.conversationId]))];
		return host.artifacts.list({
			...(projectId === undefined ? {} : { projectId }),
			...(conversations === undefined ? {} : { conversations }),
		});
	});
	r.on("GET", "/api/artifacts/:projectId/:slug/revisions", async ({ host, params }) =>
		host.artifacts.revisions(params.projectId!, params.slug!),
	);
}

const PDF_REV = /^\/art\/r\/([^/]+)\.pdf$/;
const PDF_LATEST = /^\/art\/([^/]+)\/([^/]+)\.pdf$/;

/** Serve `/art/r/:rev.pdf` and `/art/:projectId/:slug.pdf` on the artifacts origin; false when not a PDF route. */
export async function servePdf(host: Host, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const path = new URL(req.url ?? "/", "http://local").pathname;
	const byRev = PDF_REV.exec(path);
	const byLatest = byRev ? null : PDF_LATEST.exec(path);
	if (!byRev && !byLatest) return false;
	let parts: string[];
	try {
		parts = (byRev ? [byRev[1]!] : [byLatest![1]!, byLatest![2]!]).map(decodeURIComponent);
	} catch {
		parts = [];
	}
	const revision =
		parts.length === 1
			? await host.artifacts.revision(parts[0]!)
			: parts.length === 2
				? await host.artifacts.latest(parts[0]!, parts[1]!)
				: undefined;
	if (!revision) {
		sendJson(res, 404, { error: "artifact not found", code: "not_found" });
		return true;
	}
	const result = await host.artifacts.pdf(revision.rev);
	if (result.status === "rendering") {
		sendJson(res, 503, { error: "pdf is rendering", code: "rendering" }, { "retry-after": String(result.retryAfterSeconds) });
		return true;
	}
	if (result.status === "unavailable") {
		sendJson(res, 503, { error: result.reason, code: "pdf_unavailable" });
		return true;
	}
	const info = await stat(result.path);
	const name = `${revision.slug}-r${revision.revision}.pdf`;
	res.writeHead(200, {
		"content-type": "application/pdf",
		"content-length": info.size,
		"content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
		"cache-control": "no-store",
	});
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	const stream = createReadStream(result.path);
	stream.on("error", () => res.destroy());
	stream.pipe(res);
	return true;
}
