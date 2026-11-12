import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeHtml } from "./sanitize.js";

const CHROME_ENV = "TOBOR_CHROME";
const CHROME_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "microsoft-edge"];
/** Hard limit of one headless Chromium render. */
export const PDF_TIMEOUT_MS = 120_000;

/** Content types by lowercase extension. */
export const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
};

/** Content type of `file` by extension, else `application/octet-stream`. */
export function mimeFor(file: string): string {
	return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

const PAGE_CSS = "@page { size: A4; margin: 12mm; background: var(--color-bg, #fff); }";
const PRINT_CSS = `@media print {
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .min-h-screen { min-height: 0 !important; }
  .break-inside-avoid, .bg-surface, .rounded-lg, .shadow-card, figure, pre, tr, canvas, svg, img { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
}`;
const CHART_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*chart\.js[^"']*["'][^>]*>\s*<\/script>/i;
const CHART_STATIC = "<script>Chart.defaults.animation=false;</script>";

function injectHead(html: string, markup: string): string {
	const close = html.search(/<\/head>/i);
	return close === -1 ? `${markup}\n${html}` : `${html.slice(0, close)}${markup}\n${html.slice(close)}`;
}

/** Add A4 page and print CSS (page rule only if the document has none) and disable Chart.js animation. */
export function printReady(html: string): string {
	const css = /@page\b/.test(html) ? PRINT_CSS : `${PAGE_CSS}\n${PRINT_CSS}`;
	const withCss = injectHead(html, `<style>\n${css}\n</style>`);
	if (withCss.includes("Chart.defaults.animation=false")) return withCss;
	return withCss.replace(CHART_SCRIPT_RE, (tag) => `${tag}\n${CHART_STATIC}`);
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const ATTR_RE = /(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi;
const SRCSET_RE = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const LINK_RE = /<link\b[^>]*>/gi;

function localFile(bundleDir: string, baseDir: string, ref: string): string | undefined {
	const trimmed = ref.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || SCHEME_RE.test(trimmed)) return undefined;
	let clean: string;
	try {
		clean = decodeURIComponent(trimmed.split(/[?#]/)[0] ?? "");
	} catch {
		return undefined;
	}
	const file = clean.startsWith("/") ? join(bundleDir, clean) : resolve(baseDir, clean);
	const rel = relative(bundleDir, file);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	try {
		return statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

function dataUri(file: string): string {
	const mime = mimeFor(file).split(";")[0];
	return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

function inlineCssUrls(bundleDir: string, baseDir: string, css: string): string {
	return css.replace(URL_RE, (match, _quote: string, ref: string) => {
		const file = localFile(bundleDir, baseDir, ref);
		return file ? `url("${dataUri(file)}")` : match;
	});
}

/** Inline local stylesheets, `src`/`href`/`poster`/`srcset` refs and CSS `url()`s as `data:` URIs, staying inside `bundleDir`. */
export function inlineHtml(bundleDir: string, html: string): string {
	const withStyles = html.replace(LINK_RE, (tag) => {
		if (!/\brel\s*=\s*(["']?)stylesheet\1/i.test(tag)) return tag;
		const href = /\bhref\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2];
		const file = href ? localFile(bundleDir, bundleDir, href) : undefined;
		if (!file) return tag;
		return `<style>\n${inlineCssUrls(bundleDir, dirname(file), readFileSync(file, "utf8"))}\n</style>`;
	});
	const withAttrs = withStyles.replace(ATTR_RE, (match, prefix: string, quote: string, ref: string) => {
		const file = localFile(bundleDir, bundleDir, ref);
		return file ? `${prefix}${quote}${dataUri(file)}${quote}` : match;
	});
	const withSrcset = withAttrs.replace(SRCSET_RE, (_match, prefix: string, quote: string, value: string) => {
		const candidates = value.split(",").map((candidate) => {
			const [ref = "", ...descriptor] = candidate.trim().split(/\s+/);
			const file = localFile(bundleDir, bundleDir, ref);
			return [file ? dataUri(file) : ref, ...descriptor].join(" ");
		});
		return `${prefix}${quote}${candidates.join(", ")}${quote}`;
	});
	return inlineCssUrls(bundleDir, bundleDir, withSrcset);
}

/** One self-contained, sanitized, print-ready HTML file from a bundle's `index.html`. */
export function exportHtml(bundleDir: string): string {
	const entry = join(bundleDir, "index.html");
	if (!existsSync(entry)) throw new Error(`No index.html in ${bundleDir}`);
	return printReady(inlineHtml(bundleDir, sanitizeHtml(readFileSync(entry, "utf8"))));
}

function which(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const file = join(dir, name);
		try {
			accessSync(file, constants.X_OK);
			if (statSync(file).isFile()) return file;
		} catch {}
	}
	return undefined;
}

/** Chromium binary: `$TOBOR_CHROME` (path or PATH name), then the first known browser on PATH. Throws if none. */
export function resolveChrome(): string {
	const fromEnv = process.env[CHROME_ENV];
	if (fromEnv) {
		const found = existsSync(fromEnv) ? fromEnv : which(fromEnv);
		if (found) return found;
		throw new Error(`${CHROME_ENV}=${fromEnv} does not point at an executable`);
	}
	for (const name of CHROME_NAMES) {
		const found = which(name);
		if (found) return found;
	}
	throw new Error(`No Chromium found for PDF export. Tried $${CHROME_ENV} (unset) and PATH (${CHROME_NAMES.join(", ")}).`);
}

/** Chrome probe: whether a binary resolves, its path and `--version` output. */
export type ChromeProbe = { found: boolean; version?: string; path?: string; error?: string };

/** Resolve Chromium and read its version. Never throws. */
export async function probeChrome(): Promise<ChromeProbe> {
	let path: string;
	try {
		path = resolveChrome();
	} catch (error) {
		return { found: false, error: error instanceof Error ? error.message : String(error) };
	}
	const { promise, resolve: done } = Promise.withResolvers<ChromeProbe>();
	execFile(path, ["--version"], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
		done(error ? { found: true, path, error: String(error) } : { found: true, path, version: stdout.trim() });
	});
	return promise;
}

type ChromeResult = { code: number | null; stderr: string };

function runChrome(chrome: string, args: string[]): Promise<ChromeResult> {
	const { promise, resolve: done } = Promise.withResolvers<ChromeResult>();
	const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], timeout: PDF_TIMEOUT_MS, killSignal: "SIGKILL" });
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", (err) => done({ code: null, stderr: stderr + String(err) }));
	child.on("close", (code) => done({ code, stderr }));
	return promise;
}

/**
 * Print `html` to `outPath` (A4) with headless Chromium; returns the binary used.
 * The scratch dir (page + profile) is created beside `outPath` because sandboxed
 * (snap/flatpak) Chromium has a private `/tmp` and cannot read the host's.
 */
export async function renderPdf(html: string, outPath: string, chrome = resolveChrome()): Promise<string> {
	const out = resolve(outPath);
	await mkdir(dirname(out), { recursive: true });
	const tmp = await mkdtemp(join(dirname(out), ".tobor-pdf-"));
	const page = join(tmp, "index.html");
	await writeFile(page, html);
	await rm(out, { force: true });
	try {
		const res = await runChrome(chrome, [
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${join(tmp, "profile")}`,
			"--run-all-compositor-stages-before-draw",
			"--no-pdf-header-footer",
			`--print-to-pdf=${out}`,
			"--virtual-time-budget=10000",
			pathToFileURL(page).href,
		]);
		if (!existsSync(out) || statSync(out).size === 0) {
			throw new Error(`${chrome} did not write ${out} (exit ${res.code}): ${res.stderr.trim().slice(-2000)}`);
		}
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
	return chrome;
}
