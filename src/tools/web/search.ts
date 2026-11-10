// `web_search` core, adapted from oh-my-pi's search providers (MIT, packages/coding-agent/src/web/search): Brave,
// Tavily, SearXNG, Exa (API key or its credential-free MCP endpoint) and DuckDuckGo's no-JS HTML frontend, tried in
// order until one returns results, and rendered like omp's `formatForLLM`.
import type { Config, SearchProvider } from "../../config/schema.js";
import { decodeEntities, stripTags } from "./html.js";

export type Recency = "day" | "week" | "month" | "year";
/** A concrete backend (everything but `auto`/`none`). */
export type SearchBackend = Exclude<SearchProvider, "auto" | "none">;

export type SearchSource = { title: string; url: string; snippet?: string; published?: string };
export type SearchResponse = { provider: SearchBackend; answer?: string; sources: SearchSource[]; related?: string[] };

export const SEARCH_NOT_CONFIGURED =
	"web_search is not configured: set search.provider in .tobor/config.yml and the key in agent.env";

/** Default endpoints; tests and `search.url` override them. */
export const SEARCH_ENDPOINTS: Record<SearchBackend, string> = {
	brave: "https://api.search.brave.com/res/v1/web/search",
	tavily: "https://api.tavily.com/search",
	searxng: "",
	exa: "https://api.exa.ai/search",
	duckduckgo: "https://html.duckduckgo.com/html/",
};
const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";

/** Env-file variable each backend reads its key from unless `search.api_key_env` says otherwise. */
const KEY_ENV: Record<SearchBackend, string> = {
	brave: "BRAVE_API_KEY",
	tavily: "TAVILY_API_KEY",
	searxng: "SEARXNG_TOKEN",
	exa: "EXA_API_KEY",
	duckduckgo: "",
};

const MAX_RESULTS = 20;
const SNIPPET_CHARS = 240;

export type SearchDeps = {
	config: Config["search"];
	/** Env-file variables (agent.env); `process.env` is the fallback. */
	env: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Endpoint overrides per backend (tests); the Exa entry also replaces the MCP endpoint. */
	endpoints?: Partial<Record<SearchBackend, string>>;
};

type Call = { query: string; limit: number; recency?: Recency; key?: string; endpoint: string; signal: AbortSignal };

class ProviderError extends Error {}

function text(value: unknown, max = 600): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = stripTags(value);
	if (!clean) return undefined;
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(asRecord).filter((r): r is Record<string, unknown> => r !== undefined) : [];
}

function source(r: Record<string, unknown>, snippet: unknown, published?: unknown): SearchSource | undefined {
	const url = typeof r.url === "string" && /^https?:\/\//i.test(r.url) ? r.url : undefined;
	if (!url) return undefined;
	const s = text(snippet);
	const p = text(published, 100);
	return { title: text(r.title, 300) ?? url, url, ...(s ? { snippet: s } : {}), ...(p ? { published: p } : {}) };
}

async function failure(provider: string, response: Response): Promise<ProviderError> {
	const body = (await response.text().catch(() => "")).slice(0, 300).trim();
	if (response.status === 401 || response.status === 403) {
		return new ProviderError(`${provider} authorization failed (${response.status}); check the API key${body ? `: ${body}` : ""}`);
	}
	if (response.status === 429) return new ProviderError(`${provider} rate limit reached (429)`);
	return new ProviderError(`${provider} HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function json(provider: string, response: Response): Promise<unknown> {
	if (!response.ok) throw await failure(provider, response);
	try {
		return await response.json();
	} catch {
		throw new ProviderError(`${provider} returned invalid JSON`);
	}
}

/** `after:` date for a recency window. */
function since(recency: Recency): string {
	const days = { day: 1, week: 7, month: 31, year: 366 }[recency];
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function brave(c: Call): Promise<SearchResponse> {
	if (!c.key) throw new ProviderError(`Brave needs an API key: set ${KEY_ENV.brave} in agent.env`);
	const url = new URL(c.endpoint);
	url.searchParams.set("q", c.query);
	url.searchParams.set("count", String(c.limit));
	url.searchParams.set("extra_snippets", "true");
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("safesearch", "moderate");
	if (c.recency) url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[c.recency]);
	const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": c.key }, signal: c.signal });
	const data = asRecord(await json("brave", response));
	const sources = records(asRecord(data?.web)?.results).flatMap((r) => {
		const extra = Array.isArray(r.extra_snippets) ? r.extra_snippets.filter((s) => typeof s === "string") : [];
		return source(r, [r.description, ...extra].filter((s) => typeof s === "string").join(" … "), r.age) ?? [];
	});
	return { provider: "brave", sources: sources.slice(0, c.limit) };
}

async function tavily(c: Call): Promise<SearchResponse> {
	if (!c.key) throw new ProviderError(`Tavily needs an API key: set ${KEY_ENV.tavily} in agent.env`);
	const body: Record<string, unknown> = {
		query: c.query,
		search_depth: "basic",
		max_results: c.limit,
		include_answer: "advanced",
		include_raw_content: false,
		...(c.recency ? { time_range: c.recency } : {}),
	};
	const response = await fetch(c.endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
		body: JSON.stringify(body),
		signal: c.signal,
	});
	const data = asRecord(await json("tavily", response));
	const answer = typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : undefined;
	const sources = records(data?.results).flatMap((r) => source(r, r.content, r.published_date) ?? []);
	return { provider: "tavily", ...(answer ? { answer } : {}), sources: sources.slice(0, c.limit) };
}

async function searxng(c: Call): Promise<SearchResponse> {
	if (!c.endpoint) throw new ProviderError("SearXNG needs search.url in .tobor/config.yml");
	const url = new URL(`${c.endpoint.replace(/\/+$/, "")}/search`);
	url.searchParams.set("q", c.query);
	url.searchParams.set("format", "json");
	// SearXNG has no week window; month is the nearest that still includes it.
	if (c.recency) url.searchParams.set("time_range", c.recency === "week" ? "month" : c.recency);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (c.key) headers.Authorization = `Bearer ${c.key}`;
	const response = await fetch(url, { headers, signal: c.signal });
	const data = asRecord(await json("searxng", response));
	const sources = records(data?.results).flatMap((r) => source(r, r.content ?? r.snippet, r.publishedDate ?? r.published_date) ?? []);
	const answers = (Array.isArray(data?.answers) ? data.answers : [])
		.map((a) => (typeof a === "string" ? a : text(asRecord(a)?.answer)))
		.filter((a): a is string => typeof a === "string" && a.trim() !== "");
	const related = (Array.isArray(data?.suggestions) ? data.suggestions : []).filter((s): s is string => typeof s === "string");
	if (sources.length === 0 && Array.isArray(data?.unresponsive_engines) && data.unresponsive_engines.length > 0) {
		throw new ProviderError(`searxng: no results; unresponsive engines: ${JSON.stringify(data.unresponsive_engines).slice(0, 200)}`);
	}
	return {
		provider: "searxng",
		...(answers.length ? { answer: answers.join("\n") } : {}),
		sources: sources.slice(0, c.limit),
		...(related.length ? { related } : {}),
	};
}

/** Parse an MCP JSON-RPC reply (plain JSON or an SSE stream) for request `id`. */
async function mcpResult(response: Response, id: string): Promise<unknown> {
	const body = await response.text();
	const messages: unknown[] = [];
	if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
		for (const event of body.split(/\r?\n\r?\n/)) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data && data !== "[DONE]") messages.push(JSON.parse(data));
		}
	} else messages.push(JSON.parse(body));
	for (const message of messages.flat()) {
		const m = asRecord(message);
		if (m?.id !== id) continue;
		const error = asRecord(m.error);
		if (error) throw new ProviderError(`exa MCP error: ${String(error.message ?? "unknown")}`);
		return m.result;
	}
	throw new ProviderError("exa MCP response did not include a result");
}

/** Exa MCP text payload: `Title: …\nURL: …\nPublished Date: …\nText: …` sections. */
function exaTextResults(result: Record<string, unknown>): Record<string, unknown>[] {
	const blocks = records(result.content)
		.map((part) => (typeof part.text === "string" ? part.text.replace(/\r\n?/g, "\n").trim() : ""))
		.filter(Boolean);
	for (const block of blocks) {
		try {
			const parsed = asRecord(JSON.parse(block));
			if (parsed && Array.isArray(parsed.results)) return records(parsed.results);
		} catch {
			// not JSON: the text format below
		}
	}
	const field = (section: string, label: string) => {
		const value = new RegExp(`(?:^|\\n)${label}:[ \\t]*([^\\n]*)`).exec(section)?.[1]?.trim();
		return value && value !== "N/A" ? value : undefined;
	};
	// Older payloads end each section with `Text:`, current ones with `Highlights:` (markdown excerpts split by `...`).
	const body = (section: string) =>
		/(?:^|\n)(?:Text|Highlights):\s*([\s\S]*)$/
			.exec(section)?.[1]
			?.replace(/\n\s*\.\.\.\s*\n/g, " … ")
			.replace(/^#+\s+|\*\*/gm, "")
			.trim();
	return blocks
		.join("\n\n")
		.split(/\n{2,}(?=Title:[^\n]*\n(?:URL|Author|Published|Published Date|Highlights|Text):)/)
		.map((s) => s.trim())
		.filter((s) => s.startsWith("Title:"))
		.map((s) => ({
			title: field(s, "Title"),
			url: field(s, "URL"),
			publishedDate: field(s, "Published Date") ?? field(s, "Published"),
			text: body(s),
		}));
}

async function exa(c: Call, endpointOverridden: boolean): Promise<SearchResponse> {
	let results: Record<string, unknown>[];
	if (c.key) {
		const body: Record<string, unknown> = { query: c.query, numResults: c.limit, type: "auto", contents: { summary: { query: c.query } } };
		if (c.recency) body.startPublishedDate = since(c.recency);
		const response = await fetch(c.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": c.key },
			body: JSON.stringify(body),
			signal: c.signal,
		});
		results = records(asRecord(await json("exa", response))?.results);
	} else {
		const id = Math.random().toString(36).slice(2);
		const endpoint = new URL(endpointOverridden ? c.endpoint : EXA_MCP_ENDPOINT);
		endpoint.searchParams.set("tools", "web_search_exa");
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-exa-source": "tobor" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: { query: c.recency ? `${c.query} after:${since(c.recency)}` : c.query, numResults: c.limit },
				},
			}),
			signal: c.signal,
		});
		if (!response.ok) throw await failure("exa", response);
		const result = asRecord(await mcpResult(response, id)) ?? {};
		if (result.isError === true) {
			const message = records(result.content).find((p) => typeof p.text === "string")?.text;
			throw new ProviderError(`exa: ${String(message ?? "MCP tool returned an error")}`);
		}
		const structured = asRecord(result.structuredContent);
		results = structured && Array.isArray(structured.results) ? records(structured.results) : exaTextResults(result);
	}
	const sources = results.flatMap((r) => source(r, r.summary ?? r.text, r.publishedDate) ?? []);
	const summaries = results
		.filter((r) => typeof r.summary === "string" && r.summary.trim())
		.slice(0, 3)
		.map((r) => `**${text(r.title, 300) ?? String(r.url)}**: ${String(r.summary).trim()}`);
	return { provider: "exa", ...(summaries.length ? { answer: summaries.join("\n\n") } : {}), sources: sources.slice(0, c.limit) };
}

/** A result row's target: DuckDuckGo wraps outbound links in `/l/?uddg=<encoded>`; ad redirects are dropped. */
function unwrapDuckDuckGo(href: string): string | undefined {
	const decoded = href.replace(/&amp;/gi, "&");
	if (/^(?:https?:)?\/\/(?:www\.)?duckduckgo\.com\/y\.js(?:[?#]|$)/i.test(decoded)) return undefined;
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	if (wrapped) {
		try {
			return decodeURIComponent(wrapped[1]!);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	return /^https?:\/\//.test(decoded) ? decoded : undefined;
}

/** Result rows of DuckDuckGo's HTML page, in document order. */
export function parseDuckDuckGo(html: string): SearchSource[] {
	const out: SearchSource[] = [];
	const blockRe =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockRe)) {
		const block = match[1]!;
		const title = titleRe.exec(block);
		if (!title) continue;
		const url = unwrapDuckDuckGo(title[1]!);
		const titleText = stripTags(title[2]!);
		if (!url || !titleText) continue;
		const snippet = snippetRe.exec(block);
		const snippetText = snippet ? stripTags(snippet[1]!) : "";
		out.push({ title: titleText, url, ...(snippetText ? { snippet: snippetText } : {}) });
	}
	return out;
}

/** Hidden fields of DuckDuckGo's next-page form, if any. */
function duckDuckGoNextPage(html: string): URLSearchParams | undefined {
	for (const form of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
		const params = new URLSearchParams();
		for (const input of form[1]!.matchAll(/<input\b[^>]*>/gi)) {
			const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input[0])?.[2];
			const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input[0])?.[2];
			if (name && value !== undefined) params.append(decodeEntities(name), decodeEntities(value));
		}
		if (params.has("s") && params.has("vqd")) return params;
	}
	return undefined;
}

async function duckduckgo(c: Call): Promise<SearchResponse> {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	let form: URLSearchParams | undefined = new URLSearchParams({ q: c.query, kl: "us-en", b: "" });
	if (c.recency) form.set("df", { day: "d", week: "w", month: "m", year: "y" }[c.recency]);
	while (form && sources.length < c.limit) {
		const response = await fetch(c.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				Referer: "https://html.duckduckgo.com/",
			},
			body: form.toString(),
			signal: c.signal,
		});
		if (!response.ok) throw await failure("duckduckgo", response);
		const html = await response.text();
		if (html.includes("anomaly-modal") || html.includes("anomaly.js")) {
			throw new ProviderError(
				"duckduckgo blocked the request with a bot-detection challenge; configure a keyed provider (brave, tavily, exa) for reliable search",
			);
		}
		const before = sources.length;
		for (const result of parseDuckDuckGo(html)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			sources.push(result);
			if (sources.length >= c.limit) break;
		}
		if (sources.length === before) break;
		form = duckDuckGoNextPage(html);
	}
	return { provider: "duckduckgo", sources };
}

/** Backends to try for a config: an explicit provider alone, or for `auto` the keyed ones that are set up, then the keyless ones. */
export function searchChain(config: Config["search"], key: (backend: SearchBackend) => string | undefined): SearchBackend[] {
	if (config.provider === "none") return [];
	if (config.provider !== "auto") return [config.provider];
	const chain: SearchBackend[] = [];
	if (key("brave")) chain.push("brave");
	if (key("tavily")) chain.push("tavily");
	if (config.url) chain.push("searxng");
	chain.push("exa", "duckduckgo");
	return chain;
}

function formatResponse(response: SearchResponse): string {
	const parts: string[] = [];
	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) parts.push("\n## Sources");
	}
	response.sources.forEach((s, i) => {
		parts.push(`[${i + 1}] ${s.title}${s.published ? ` (${s.published})` : ""}\n    ${s.url}`);
		if (s.snippet) parts.push(`    ${s.snippet.length > SNIPPET_CHARS ? `${s.snippet.slice(0, SNIPPET_CHARS - 1)}…` : s.snippet}`);
	});
	if (response.related?.length) {
		parts.push("\n## Related");
		for (const q of response.related) parts.push(`- ${q}`);
	}
	return parts.join("\n");
}

export type SearchResult = { text: string; isError: boolean; details: { provider: SearchBackend | "none"; response?: SearchResponse; errors?: string[] } };

/** Run `query` through the configured chain; the first backend with results wins. Never throws except on abort. */
export async function webSearch(
	request: { query: string; limit?: number; recency?: Recency },
	deps: SearchDeps,
): Promise<SearchResult> {
	const { config } = deps;
	const key = (backend: SearchBackend): string | undefined => {
		const name = config.provider === backend && config.api_key_env ? config.api_key_env : KEY_ENV[backend];
		const value = name ? (deps.env[name] ?? process.env[name]) : undefined;
		return value?.trim() || undefined;
	};
	const chain = searchChain(config, key);
	if (chain.length === 0) return { text: SEARCH_NOT_CONFIGURED, isError: false, details: { provider: "none" } };

	const query = request.query.trim();
	if (!query) return { text: "web_search needs a non-empty query", isError: true, details: { provider: "none" } };
	const limit = Math.min(Math.max(Math.floor(request.limit ?? config.max_results), 1), MAX_RESULTS);
	const errors: string[] = [];
	let last: SearchBackend = chain[0]!;
	for (const backend of chain) {
		deps.signal?.throwIfAborted();
		last = backend;
		const override = deps.endpoints?.[backend] ?? (config.provider === backend || backend === "searxng" ? config.url : undefined);
		const call: Call = {
			query,
			limit,
			...(request.recency ? { recency: request.recency } : {}),
			...(key(backend) ? { key: key(backend) } : {}),
			endpoint: override ?? SEARCH_ENDPOINTS[backend],
			signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs)]) : AbortSignal.timeout(deps.timeoutMs),
		};
		try {
			const response =
				backend === "brave"
					? await brave(call)
					: backend === "tavily"
						? await tavily(call)
						: backend === "searxng"
							? await searxng(call)
							: backend === "exa"
								? await exa(call, override !== undefined)
								: await duckduckgo(call);
			if (response.sources.length === 0 && !response.answer) {
				errors.push(`${backend}: no results`);
				continue;
			}
			return { text: formatResponse(response), isError: false, details: { provider: backend, response, ...(errors.length ? { errors } : {}) } };
		} catch (error) {
			deps.signal?.throwIfAborted();
			const message = error instanceof Error ? error.message : String(error);
			errors.push(call.signal.aborted ? `${backend}: timed out after ${deps.timeoutMs} ms` : message.startsWith(backend) ? message : `${backend}: ${message}`);
		}
	}
	const allEmpty = errors.every((e) => e.endsWith(": no results"));
	if (allEmpty) return { text: `No results for "${query}".`, isError: false, details: { provider: last, errors } };
	const text = errors.length === 1 ? `Error: ${errors[0]}` : `Error: all web search providers failed: ${errors.join("; ")}`;
	return { text, isError: true, details: { provider: last, errors } };
}
