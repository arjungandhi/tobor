// `fetch_url` core, adapted from oh-my-pi's URL reader (MIT, packages/coding-agent/src/tools/fetch.ts): a guarded
// page load (manual redirects with an SSRF check per hop, user-agent fallback on bot blocks, markdown content
// negotiation), then content-type dispatch: JSON pretty-print, RSS/Atom → markdown, text/markdown passthrough,
// PDF → `pdftotext`, HTML → a page-specific markdown alternate, else the local converter with llms.txt and the
// Jina reader as fallbacks when the rendering is JavaScript-gated or empty.
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { delimiter, join } from "node:path";
import { decodeEntities, htmlToText } from "./html.js";

/** Text bodies are cut at this many bytes. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** PDFs are converted whole, so they get a larger cap. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 10;
export const USER_AGENT = "tobor";
/** Rendered output at or under this many characters is no rendering of the page. */
const MIN_RENDERED_CHARS = 100;
/** Cap on one remote reader (Jina) request, so it cannot eat the whole budget. */
const REMOTE_READER_MAX_MS = 10_000;
/** Statuses that commonly mean "bot blocked"; retried once with a browser identity. */
const BLOCKED_STATUSES = [403, 429, 503, 999];

/** A browser navigation identity for sites that refuse unknown user agents. */
const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Upgrade-Insecure-Requests": "1",
};

/** Resolve a hostname to its addresses (injectable for tests). */
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function isPrivateV4(ip: string): boolean {
	const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
	return (
		a === 0 || // "this" network
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local (cloud metadata)
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) || // IETF protocol assignments
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast, reserved, broadcast
	);
}

/** The eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail expanded). */
function ipv6Groups(ip: string): number[] {
	let addr = ip.toLowerCase().replace(/%.*$/, "");
	const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
	if (v4) {
		const [a = 0, b = 0, c = 0, d = 0] = v4[1]!.split(".").map(Number);
		addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = "", tail] = addr.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill("0");
	return [...h, ...fill, ...t].map((g) => Number.parseInt(g, 16));
}

function isPrivateV6(ip: string): boolean {
	const g = ipv6Groups(ip);
	const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
	const embeddedV4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
	if (zeroThrough(8)) return true; // ::
	if (zeroThrough(7) && g[7] === 1) return true; // ::1
	if (zeroThrough(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4); // ::ffff:a.b.c.d
	if (zeroThrough(6)) return isPrivateV4(embeddedV4); // ::a.b.c.d (deprecated compatible form)
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4); // NAT64
	const first = g[0]!;
	return (
		(first & 0xfe00) === 0xfc00 || // unique local fc00::/7
		(first & 0xffc0) === 0xfe80 || // link-local fe80::/10
		(first & 0xffc0) === 0xfec0 || // site-local (deprecated)
		(first & 0xff00) === 0xff00 // multicast
	);
}

/** Whether an IP literal is loopback, private, link-local, or otherwise not publicly routable. */
export function isPrivateAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return isPrivateV4(ip);
	if (kind === 6) return isPrivateV6(ip);
	return true;
}

/** Refuse a URL whose host is (or resolves to) a non-public address; returns the reason, or undefined when allowed. */
export async function checkUrlTarget(url: URL, resolve: Resolver = defaultResolver): Promise<string | undefined> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	let addresses: string[];
	if (isIP(host)) addresses = [host];
	else {
		try {
			addresses = await resolve(host);
		} catch (error) {
			return `cannot resolve ${host}: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (addresses.length === 0) return `cannot resolve ${host}`;
	}
	const blocked = addresses.find(isPrivateAddress);
	if (blocked !== undefined) {
		return `${host} resolves to ${blocked}, a private/loopback/link-local address; set fetch.allow_private: true in .tobor/config.yml to allow it`;
	}
	return undefined;
}

export type FetchOptions = {
	maxChars: number;
	timeoutMs: number;
	allowPrivate: boolean;
	/** Use the Jina reader (r.jina.ai) when the local rendering is JavaScript-gated or empty. */
	remoteReader: boolean;
	resolve?: Resolver;
	signal?: AbortSignal;
};

export type FetchDetails = {
	url: string;
	status: number;
	contentType: string;
	bytes: number;
	truncated: boolean;
	/** How the text was produced (`html`, `markdown-alternate`, `llms.txt`, `jina`, `json`, `feed`, `pdftotext`, `text`). */
	method: string;
};
export type FetchResult = { text: string; isError: boolean; details?: FetchDetails };

type Page = {
	url: URL;
	status: number;
	statusText: string;
	contentType: string;
	mime: string;
	bytes: Uint8Array;
	/** The body hit the byte cap. */
	cut: boolean;
};

/** Read at most `limit` bytes of a body; `cut` when more was available. */
async function readCapped(response: Response, limit: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), cut: false };
	let buffer = new Uint8Array(Math.min(limit, 64 * 1024));
	let size = 0;
	let cut = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const accepted = Math.min(value.byteLength, limit - size);
			if (size + accepted > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(limit, Math.max(size + accepted, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, size));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), size);
			size += accepted;
			if (accepted < value.byteLength) {
				cut = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { bytes: buffer.subarray(0, size), cut };
}

/** Decode honoring the declared charset, then (for HTML) a `<meta charset>` sniff; UTF-8 otherwise. */
function decodeBody(bytes: Uint8Array, contentType: string): string {
	let label = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
	if (!label && (contentType.trim() === "" || /html/i.test(contentType))) {
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 2048)).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			// Bun's typings list a narrower label set than its decoder accepts; unknown labels throw below.
			return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
		} catch {
			// unknown label: fall through to UTF-8
		}
	}
	return new TextDecoder().decode(bytes);
}

function looksLikeHtml(content: string): boolean {
	const head = content.trimStart().slice(0, 16).toLowerCase();
	return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body");
}

/**
 * GET `url` following redirects by hand (each hop SSRF-checked unless `allowPrivate`), retrying once with a browser
 * identity on a bot-block status. Throws on network failure or abort; returns a refusal string for blocked targets.
 */
async function loadPage(
	start: URL,
	options: FetchOptions,
	signal: AbortSignal,
	extra: { accept?: string; maxBytes?: number } = {},
): Promise<Page | string> {
	const identities: Record<string, string>[] = [
		{
			"User-Agent": USER_AGENT,
			Accept: extra.accept ?? "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.5",
		},
		{ ...BROWSER_HEADERS, ...(extra.accept ? { Accept: extra.accept } : {}) },
	];
	for (let attempt = 0; ; attempt++) {
		let url = start;
		let response: Response;
		for (let hop = 0; ; hop++) {
			if (!options.allowPrivate) {
				const refused = await checkUrlTarget(url, options.resolve);
				if (refused) return `refused to fetch ${url.href}: ${refused}`;
			}
			// Identity encoding: Cloudflare's markdown-for-agents responses arrive corrupted when compression is negotiated.
			response = await fetch(url, { redirect: "manual", signal, headers: { ...identities[attempt], "Accept-Encoding": "identity" } });
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || location === null) break;
			await response.body?.cancel();
			if (hop >= MAX_REDIRECTS) return `too many redirects (>${MAX_REDIRECTS}) fetching ${start.href}`;
			const next = new URL(location, url);
			if (next.protocol !== "http:" && next.protocol !== "https:") return `redirect to unsupported scheme ${next.protocol}`;
			url = next;
		}
		if (attempt + 1 < identities.length && BLOCKED_STATUSES.includes(response.status)) {
			await response.body?.cancel();
			continue;
		}
		const contentType = response.headers.get("content-type") ?? "";
		const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
		const limit = mime === "application/pdf" ? MAX_PDF_BYTES : (extra.maxBytes ?? MAX_RESPONSE_BYTES);
		const { bytes, cut } = await readCapped(response, limit);
		return { url, status: response.status, statusText: response.statusText, contentType, mime, bytes, cut };
	}
}

/** A JavaScript-gated or near-empty rendering. */
function isLowQuality(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length <= MIN_RENDERED_CHARS) return true;
	const lower = trimmed.toLowerCase();
	const gated = ["enable javascript", "javascript required", "turn on javascript", "please enable javascript", "browser not supported"];
	return trimmed.length < 1024 && gated.some((phrase) => lower.includes(phrase));
}

/** `<link rel="alternate" type="text/markdown">` hrefs describing this page (not a site-wide index). */
function markdownAlternate(html: string, pageUrl: URL): URL | undefined {
	const head = html.slice(0, 256 * 1024);
	const end = head.search(/<\/head\s*>/i);
	const pagePath = pageUrl.pathname.replace(/\/$/, "");
	for (const tag of (end === -1 ? head : head.slice(0, end)).match(/<link\b[^>]*>/gi) ?? []) {
		const attr = (name: string) =>
			new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
		if (!(attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) continue;
		if (!(attr("type") ?? "").toLowerCase().includes("markdown")) continue;
		const href = attr("href");
		if (!href) continue;
		try {
			const alt = new URL(decodeEntities(href), pageUrl);
			if (alt.pathname === pagePath || (pagePath !== "" && (alt.pathname.startsWith(`${pagePath}/`) || alt.pathname.startsWith(`${pagePath}.`)))) {
				return alt;
			}
		} catch {
			// unparsable href
		}
	}
	return undefined;
}

/** llms.txt candidates scoped to the requested URL, nearest scope first. */
function llmsCandidates(url: URL): URL[] {
	if (url.pathname === "/") {
		return ["/.well-known/llms.txt", "/llms.txt", "/llms.md"].map((p) => new URL(p, url.origin));
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const depth = url.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
	const out: URL[] = [];
	for (let d = depth; d >= 1; d--) {
		const scope = `/${segments.slice(0, d).join("/")}/`;
		out.push(new URL(`${scope}llms.txt`, url.origin), new URL(`${scope}llms.md`, url.origin));
	}
	return out;
}

function feedText(value: string): string {
	return decodeEntities(value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Render an RSS or Atom feed (first 10 items) as markdown; undefined when it is neither. */
function feedToMarkdown(xml: string): string | undefined {
	const field = (block: string, tag: string) => {
		const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
		return m ? feedText(m[1]!) : "";
	};
	const rss = /<channel\b/i.test(xml);
	const atom = !rss && /<feed\b/i.test(xml);
	if (!rss && !atom) return undefined;
	const itemTag = rss ? "item" : "entry";
	const firstItem = xml.search(new RegExp(`<${itemTag}\\b`, "i"));
	const title = field(firstItem === -1 ? xml : xml.slice(0, firstItem), "title") || (rss ? "RSS Feed" : "Atom Feed");
	let md = `# ${title}\n\n`;
	for (const m of [...xml.matchAll(new RegExp(`<${itemTag}\\b[^>]*>([\\s\\S]*?)</${itemTag}>`, "gi"))].slice(0, 10)) {
		const item = m[1]!;
		const link = rss ? field(item, "link") : (/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(item)?.[1] ?? "");
		const date = field(item, rss ? "pubDate" : "updated");
		const summary = rss ? field(item, "description") : field(item, "summary") || field(item, "content");
		md += `## ${field(item, "title") || "Untitled"}\n`;
		if (date) md += `*${date}*\n\n`;
		if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n`;
		if (link) md += `[Read more](${decodeEntities(link)})\n\n`;
		md += "---\n\n";
	}
	return md;
}

/** Text of a PDF via `pdftotext` (poppler) when installed; undefined when the binary is missing. */
async function pdfToText(bytes: Uint8Array, timeoutMs: number): Promise<{ text: string } | { error: string } | undefined> {
	const onPath = (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, "pdftotext")));
	if (!onPath) return undefined;
	const { promise, resolve } = Promise.withResolvers<{ text: string } | { error: string }>();
	const child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	child.on("error", (error) => resolve({ error: error.message }));
	child.on("close", (code) => {
		if (code === 0) resolve({ text: Buffer.concat(out).toString("utf8") });
		else resolve({ error: Buffer.concat(err).toString("utf8").trim() || `pdftotext exited with ${code}` });
	});
	child.stdin.on("error", () => undefined);
	child.stdin.end(bytes);
	return promise;
}

/** The Jina reader's markdown for a public URL, or undefined. */
async function jinaReader(url: URL, signal: AbortSignal): Promise<string | undefined> {
	const response = await fetch(`https://r.jina.ai/${url.href}`, {
		headers: { Accept: "text/markdown", "X-No-Cache": "true", "User-Agent": USER_AGENT },
		signal: AbortSignal.any([signal, AbortSignal.timeout(REMOTE_READER_MAX_MS)]),
	});
	if (!response.ok) return undefined;
	const { bytes } = await readCapped(response, 2 * 1024 * 1024);
	const body = new TextDecoder().decode(bytes);
	const marker = body.indexOf("Markdown Content:");
	const content = (marker === -1 ? body : body.slice(marker + "Markdown Content:".length)).trim();
	if (content.length <= MIN_RENDERED_CHARS || content.startsWith("Loading...") || content.startsWith("Please enable JavaScript")) return undefined;
	return content;
}

type Rendered = { title: string; text: string; method: string; url: URL; cut: boolean; error?: string };

/** Turn a loaded page into text, trying the digestible alternatives omp tries for HTML. */
async function render(page: Page, options: FetchOptions, signal: AbortSignal): Promise<Rendered> {
	const base = { title: "", url: page.url, cut: page.cut };
	const { mime } = page;
	if (mime === "application/pdf") {
		const pdf = await pdfToText(page.bytes, options.timeoutMs);
		if (pdf && "text" in pdf && pdf.text.trim()) return { ...base, text: pdf.text, method: "pdftotext" };
		const why = pdf && "error" in pdf ? `pdftotext failed: ${pdf.error}` : "pdftotext (poppler-utils) is not installed on this node";
		return {
			...base,
			text: "",
			method: "pdf",
			error: `${page.url.href} is a PDF and ${why}; download it with bash (curl -sL URL -o file.pdf) and extract the text another way`,
		};
	}
	const html = mime.includes("html");
	const textual =
		html ||
		mime === "" ||
		mime.startsWith("text/") ||
		/[/+](json|xml|javascript|ecmascript|x-yaml|yaml|toml|csv|x-sh|markdown|x-ndjson)$/.test(mime) ||
		/rss|atom|feed/.test(mime);
	if (!textual) {
		return {
			...base,
			text: "",
			method: "binary",
			error: `${page.url.href} returned unsupported content type ${page.contentType}; fetch_url reads HTML, text, JSON, feeds and PDFs (use bash with curl for other files)`,
		};
	}
	const body = decodeBody(page.bytes, page.contentType);
	if (mime.includes("json")) {
		try {
			return { ...base, text: JSON.stringify(JSON.parse(body), null, 2), method: "json" };
		} catch {
			return { ...base, text: body, method: "text" };
		}
	}
	if (/rss|atom|feed/.test(mime) || (mime.includes("xml") && !html && /<rss\b|<feed\b/i.test(body))) {
		return { ...base, text: feedToMarkdown(body) ?? body, method: "feed" };
	}
	if (!html && !looksLikeHtml(body)) return { ...base, text: body, method: mime.includes("markdown") ? "markdown" : "text" };

	const rendered = htmlToText(body, page.url.href);
	const alternate = markdownAlternate(body, page.url);
	if (alternate) {
		const alt = await loadPage(alternate, options, signal, { accept: "text/markdown, text/plain;q=0.9" }).catch(() => undefined);
		if (alt && typeof alt !== "string" && alt.status < 300) {
			const text = decodeBody(alt.bytes, alt.contentType);
			if (text.trim().length > MIN_RENDERED_CHARS && !looksLikeHtml(text)) {
				return { title: rendered.title, text, method: "markdown-alternate", url: alt.url, cut: alt.cut };
			}
		}
	}
	if (!isLowQuality(rendered.text)) return { ...base, title: rendered.title, text: rendered.text, method: "html" };

	for (const candidate of llmsCandidates(page.url)) {
		const llms = await loadPage(candidate, options, signal, { accept: "text/plain, text/markdown" }).catch(() => undefined);
		if (!llms || typeof llms === "string" || llms.status >= 300) continue;
		const text = decodeBody(llms.bytes, llms.contentType);
		if (text.trim().length > MIN_RENDERED_CHARS && !looksLikeHtml(text)) {
			return { title: rendered.title, text, method: "llms.txt", url: llms.url, cut: llms.cut };
		}
	}
	if (options.remoteReader) {
		const jina = await jinaReader(page.url, signal).catch(() => undefined);
		if (jina) return { ...base, title: rendered.title, text: jina, method: "jina" };
	}
	return { ...base, title: rendered.title, text: rendered.text, method: "html" };
}

/** Fetch `rawUrl` and render it as text for the model. Never throws for network or HTTP problems. */
export async function fetchUrl(rawUrl: string, options: FetchOptions): Promise<FetchResult> {
	let input = rawUrl.trim();
	if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return { text: `invalid URL: ${rawUrl}`, isError: true };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { text: `unsupported URL scheme ${url.protocol} (only http and https)`, isError: true };
	}
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

	let page: Page | string;
	let rendered: Rendered;
	try {
		page = await loadPage(url, options, signal);
		if (typeof page === "string") return { text: page, isError: true };
		rendered = await render(page, options, signal);
	} catch (error) {
		if (timeout.aborted) return { text: `timed out after ${options.timeoutMs} ms fetching ${url.href}`, isError: true };
		const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return { text: `fetch failed for ${url.href}: ${error instanceof Error ? error.message : String(error)}${cause}`, isError: true };
	}

	const details: FetchDetails = {
		url: rendered.url.href,
		status: page.status,
		contentType: page.contentType,
		bytes: page.bytes.byteLength,
		truncated: false,
		method: rendered.method,
	};
	if (rendered.error) return { text: rendered.error, isError: true, details };

	let text = rendered.text.replace(/\n{3,}/g, "\n\n").trim();
	const total = text.length;
	if (total > options.maxChars) {
		text = `${text.slice(0, options.maxChars)}\n\n[truncated: showing ${options.maxChars} of ${total} characters; call fetch_url with a larger max_chars for more]`;
		details.truncated = true;
	} else if (rendered.cut) {
		text = `${text}\n\n[truncated: response exceeded ${MAX_RESPONSE_BYTES} bytes]`;
		details.truncated = true;
	}
	const ok = page.status >= 200 && page.status < 300;
	const header = `${ok ? "" : `HTTP ${page.status} ${page.statusText}\n`}Title: ${rendered.title || "(none)"}\nURL: ${rendered.url.href}\n\n`;
	return { text: header + (text || "(empty response)"), isError: !ok, details };
}
