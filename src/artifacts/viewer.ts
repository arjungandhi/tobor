import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactService, PdfResult } from "../host.js";
import { mimeFor } from "./export.js";
import { sanitizeHtml } from "./sanitize.js";

/** Header CSP on every artifact response. */
export const ARTIFACT_CSP = [
	"sandbox allow-scripts allow-popups",
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' 'self'",
	"style-src 'unsafe-inline' 'self'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

/** What the viewer needs from the artifact service. */
export type ViewerService = Pick<ArtifactService, "latest" | "revision" | "revisionDir" | "pdf">;

/** HTTP handler for the artifacts listener; resolves `false` for paths outside `/art/`. */
export type ArtifactHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const ID = "[A-Za-z0-9_-]+";
const SLUG = "[a-z0-9][a-z0-9-]*";
const REV_PDF = new RegExp(`^/art/r/(${ID})\\.pdf$`);
const REV_BARE = new RegExp(`^/art/r/(${ID})$`);
const REV_INDEX = new RegExp(`^/art/r/(${ID})/(?:index\\.html)?$`);
const REV_ASSET = new RegExp(`^/art/r/(${ID})/(assets/.+)$`);
const LATEST_PDF = new RegExp(`^/art/(${ID})/(${SLUG})\\.pdf$`);
const LATEST = new RegExp(`^/art/(${ID})/(${SLUG})/?$`);

/** Resolve a URL-encoded relative path inside `root`, or `undefined` if it escapes, is malformed or is not a file. */
export async function containedFile(root: string, encoded: string): Promise<string | undefined> {
	let rel: string;
	try {
		rel = encoded
			.split("/")
			.map((s) => decodeURIComponent(s))
			.join("/");
	} catch {
		return undefined;
	}
	if (rel.includes("\0") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) return undefined;
	const file = join(root, rel);
	try {
		const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
		const inside = relative(realRoot, realFile);
		if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
		return (await stat(realFile)).isFile() ? realFile : undefined;
	} catch {
		return undefined;
	}
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
	res.end(body);
}

/** Viewer routes: `/art/<projectId>/<slug>` (redirect to latest), `/art/r/<rev>/`, `/art/r/<rev>/assets/*`, and `.pdf` of both. */
export function createArtifactHandler(service: ViewerService): ArtifactHandler {
	const servePdf = async (res: ServerResponse, head: boolean, rev: string, name: string): Promise<void> => {
		const result: PdfResult = await service.pdf(rev);
		if (result.status === "rendering") {
			send(res, 503, "Rendering PDF, retry shortly.\n", { "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" });
			return;
		}
		if (result.status === "unavailable") {
			send(res, 503, `PDF unavailable: ${result.reason}\n`, { "Cache-Control": "no-store" });
			return;
		}
		const info = await stat(result.path);
		res.writeHead(200, {
			"Content-Type": "application/pdf",
			"Content-Length": info.size,
			"Content-Disposition": `attachment; filename="${name}.pdf"`,
			"Cache-Control": "private, max-age=31536000, immutable",
		});
		if (head) res.end();
		else createReadStream(result.path).pipe(res);
	};

	const serveFile = async (res: ServerResponse, head: boolean, file: string): Promise<void> => {
		const type = mimeFor(file);
		const body = type.startsWith("text/html") ? Buffer.from(sanitizeHtml(await readFile(file, "utf8"))) : await readFile(file);
		res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "private, max-age=31536000, immutable" });
		res.end(head ? undefined : body);
	};

	return async (req, res) => {
		const path = new URL(req.url ?? "/", "http://artifacts.invalid").pathname;
		if (path !== "/art" && !path.startsWith("/art/")) return false;
		res.setHeader("Content-Security-Policy", ARTIFACT_CSP);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			send(res, 405, "Method not allowed\n", { Allow: "GET, HEAD" });
			return true;
		}
		const head = method === "HEAD";
		let m: RegExpExecArray | null;
		if ((m = REV_PDF.exec(path))) {
			const revision = await service.revision(m[1]!);
			if (!revision) send(res, 404, "Not found\n");
			else await servePdf(res, head, revision.rev, `${revision.slug}-r${revision.revision}`);
			return true;
		}
		if ((m = REV_BARE.exec(path))) {
			send(res, 301, "", { Location: `/art/r/${m[1]}/` });
			return true;
		}
		if ((m = REV_INDEX.exec(path)) || (m = REV_ASSET.exec(path))) {
			const dir = await service.revisionDir(m[1]!);
			const file = dir && (await containedFile(dir, m[2] ?? "index.html"));
			if (!file) send(res, 404, "Not found\n");
			else await serveFile(res, head, file);
			return true;
		}
		if ((m = LATEST_PDF.exec(path))) {
			const latest = await service.latest(m[1]!, m[2]!);
			if (!latest) send(res, 404, "Not found\n");
			else await servePdf(res, head, latest.rev, `${latest.slug}-r${latest.revision}`);
			return true;
		}
		if ((m = LATEST.exec(path))) {
			const latest = await service.latest(m[1]!, m[2]!);
			if (!latest) send(res, 404, "Not found\n");
			else send(res, 302, "", { Location: `/art/r/${latest.rev}/`, "Cache-Control": "no-store" });
			return true;
		}
		send(res, 404, "Not found\n");
		return true;
	};
}
