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

/** CSP for the durable-URL wrapper page and its `/rev` endpoint: it must poll same-origin and frame revisions, so it cannot use {@link ARTIFACT_CSP}. */
export const WRAPPER_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"frame-src 'self'",
	"connect-src 'self'",
	"img-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
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
const LATEST_REV = new RegExp(`^/art/(${ID})/(${SLUG})/rev$`);
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

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline JSON for a `<script>`: `<` is escaped so the value cannot close the element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/** Wrapper page for the durable URL: frames the current revision and swaps it when `revUrl` reports a new one. */
function wrapperPage(title: string, rev: string, revUrl: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;margin:0;width:100%;height:100%}</style>
</head><body>
<iframe id="art" sandbox="allow-scripts allow-popups" src="/art/r/${rev}/"></iframe>
<script>
(function () {
	var frame = document.getElementById("art");
	var current = ${scriptJson(rev)};
	var revUrl = ${scriptJson(revUrl)};
	var timer = 0;
	var busy = false;
	function check() {
		if (busy || document.hidden) return;
		busy = true;
		fetch(revUrl, { cache: "no-store" })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (data) {
				if (data && typeof data.rev === "string" && data.rev !== current) {
					current = data.rev;
					frame.src = "/art/r/" + encodeURIComponent(current) + "/";
				}
			})
			.catch(function () {})
			.then(function () { busy = false; });
	}
	function start() { if (!timer) timer = setInterval(check, 2000); }
	function stop() { clearInterval(timer); timer = 0; }
	document.addEventListener("visibilitychange", function () {
		if (document.hidden) stop();
		else { check(); start(); }
	});
	if (!document.hidden) start();
})();
</script>
</body></html>
`;
}

/** Viewer routes: `/art/<projectId>/<slug>` (live wrapper around the latest revision), `/art/<projectId>/<slug>/rev`, `/art/r/<rev>/`, `/art/r/<rev>/assets/*`, and `.pdf` of both. */
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
		if ((m = LATEST_REV.exec(path))) {
			const latest = await service.latest(m[1]!, m[2]!);
			if (!latest) send(res, 404, "Not found\n");
			else send(res, 200, JSON.stringify({ rev: latest.rev }), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": WRAPPER_CSP });
			return true;
		}
		if ((m = LATEST.exec(path))) {
			const latest = await service.latest(m[1]!, m[2]!);
			if (!latest) send(res, 404, "Not found\n");
			else {
				const body = wrapperPage(latest.title, latest.rev, `/art/${m[1]}/${m[2]}/rev`);
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": Buffer.byteLength(body),
					"Cache-Control": "no-store",
					"Content-Security-Policy": WRAPPER_CSP,
				});
				res.end(head ? undefined : body);
			}
			return true;
		}
		send(res, 404, "Not found\n");
		return true;
	};
}
