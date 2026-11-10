import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { selectTools } from "../../src/server/harness/workers/agents.js";
import { DIRECTOR_TOOLS as WORKER_EXCLUDED } from "../../src/server/harness/workers/tools.js";
import { DIRECTOR_TOOLS } from "../../src/server/harness/sessions.js";
import { SEARCH_NOT_CONFIGURED, type SearchDeps, searchChain, webSearch } from "../../src/tools/web/search.js";

type Seen = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: string };

describe("web_search providers against a mock server", () => {
	let server: Server;
	let base: string;
	let seen: Seen[] = [];
	let replies: Record<string, { status?: number; type?: string; body: string }> = {};

	beforeAll(async () => {
		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString()));
			req.on("end", () => {
				seen.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body });
				const reply = replies[url.pathname] ?? { status: 404, body: "no route" };
				res.writeHead(reply.status ?? 200, { "Content-Type": reply.type ?? "application/json" });
				res.end(reply.body);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		server.close();
	});
	beforeEach(() => {
		seen = [];
		replies = {};
	});

	const search = (config: Partial<Config["search"]>, env: Record<string, string> = {}, endpoints: SearchDeps["endpoints"] = {}) =>
		webSearch(
			{ query: "tobor agent", limit: 3, recency: "week" },
			{ config: { provider: "auto", max_results: 10, ...config }, env, timeoutMs: 5000, endpoints },
		);

	it("brave: GET with X-Subscription-Token, count and freshness; numbered output", async () => {
		replies["/brave"] = {
			body: JSON.stringify({
				web: {
					results: [
						{ title: "Tobor <strong>repo</strong>", url: "https://github.com/x/tobor", description: "An agent", age: "2 days ago", extra_snippets: ["more"] },
						{ title: "No url" },
						{ title: "Docs", url: "https://tobor.dev", description: "Docs site" },
					],
				},
			}),
		};
		const result = await search({ provider: "brave" }, { BRAVE_API_KEY: "bk" }, { brave: `${base}/brave` });
		expect(seen[0]!.headers["x-subscription-token"]).toBe("bk");
		expect(seen[0]!.query.get("q")).toBe("tobor agent");
		expect(seen[0]!.query.get("count")).toBe("3");
		expect(seen[0]!.query.get("freshness")).toBe("pw");
		expect(result.isError).toBe(false);
		expect(result.text).toBe(
			"[1] Tobor repo (2 days ago)\n    https://github.com/x/tobor\n    An agent … more\n[2] Docs\n    https://tobor.dev\n    Docs site",
		);
		expect(result.details.response?.sources).toHaveLength(2);
	});

	it("brave: missing key is an error naming the env var; api_key_env renames it", async () => {
		const missing = await search({ provider: "brave" }, {}, { brave: `${base}/brave` });
		expect(missing.isError).toBe(true);
		expect(missing.text).toMatch(/BRAVE_API_KEY/);
		replies["/brave"] = { body: JSON.stringify({ web: { results: [{ title: "t", url: "https://a.b" }] } }) };
		await search({ provider: "brave", api_key_env: "MY_KEY" }, { MY_KEY: "k2" }, { brave: `${base}/brave` });
		expect(seen[0]!.headers["x-subscription-token"]).toBe("k2");
	});

	it("tavily: POST with bearer key; answer precedes sources", async () => {
		replies["/tavily"] = {
			body: JSON.stringify({ answer: "Tobor is an agent.", results: [{ title: "T", url: "https://t.dev", content: "snippet" }] }),
		};
		const result = await search({ provider: "tavily" }, { TAVILY_API_KEY: "tk" }, { tavily: `${base}/tavily` });
		expect(seen[0]!.method).toBe("POST");
		expect(seen[0]!.headers.authorization).toBe("Bearer tk");
		expect(JSON.parse(seen[0]!.body)).toMatchObject({ query: "tobor agent", max_results: 3, time_range: "week" });
		expect(result.text).toBe("Tobor is an agent.\n\n## Sources\n[1] T\n    https://t.dev\n    snippet");
	});

	it("tavily: HTTP 401 becomes an authorization error", async () => {
		replies["/tavily"] = { status: 401, body: '{"detail":"bad key"}' };
		const result = await search({ provider: "tavily" }, { TAVILY_API_KEY: "tk" }, { tavily: `${base}/tavily` });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/^Error: tavily authorization failed \(401\)/);
	});

	it("searxng: <url>/search?q=&format=json with week mapped to month, suggestions as related", async () => {
		replies["/sx/search"] = {
			body: JSON.stringify({
				results: [{ title: "S", url: "https://s.org", content: "c", publishedDate: "2026-01-02" }],
				suggestions: ["tobor robot"],
			}),
		};
		const result = await search({ provider: "searxng", url: `${base}/sx` });
		expect(seen[0]!.query.get("q")).toBe("tobor agent");
		expect(seen[0]!.query.get("format")).toBe("json");
		expect(seen[0]!.query.get("time_range")).toBe("month");
		expect(result.text).toBe("[1] S (2026-01-02)\n    https://s.org\n    c\n\n## Related\n- tobor robot");
	});

	it("exa without a key: JSON-RPC tools/call over SSE, text payload parsed", async () => {
		const payload = {
			jsonrpc: "2.0",
			id: "",
			result: {
				content: [
					{
						type: "text",
						text: "Title: Exa One\nURL: https://exa.one\nPublished Date: 2026-03-01\nText: First result text\n\nTitle: Exa Two\nURL: https://exa.two\nPublished: N/A\nAuthor: N/A\nHighlights:\n# Head\n\nPart one\n\n...\n\n**Part** two",
					},
				],
			},
		};
		replies["/mcp"] = { type: "text/event-stream", body: "" };
		// The id is random: answer with whatever the request carried.
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString()));
			req.on("end", () => {
				const url = new URL(req.url ?? "/", "http://x");
				seen.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body });
				const id = JSON.parse(body).id as string;
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(`event: message\ndata: ${JSON.stringify({ ...payload, id })}\n\n`);
			});
		});
		const result = await search({ provider: "exa" }, {}, { exa: `${base}/mcp` });
		const request = JSON.parse(seen[0]!.body);
		expect(seen[0]!.query.get("tools")).toBe("web_search_exa");
		expect(request).toMatchObject({ method: "tools/call", params: { name: "web_search_exa", arguments: { numResults: 3 } } });
		expect(request.params.arguments.query).toMatch(/^tobor agent after:\d{4}-\d{2}-\d{2}$/);
		expect(result.text).toBe(
			"[1] Exa One (2026-03-01)\n    https://exa.one\n    First result text\n[2] Exa Two\n    https://exa.two\n    Head Part one … Part two",
		);
	});
});

describe("web_search: DuckDuckGo and the auto chain", () => {
	let server: Server;
	let base: string;
	let ddgBody = "";
	let ddgForm = new URLSearchParams();

	beforeAll(async () => {
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString()));
			req.on("end", () => {
				if (req.url?.startsWith("/exa")) {
					res.writeHead(429, { "Content-Type": "text/plain" });
					res.end("slow down");
					return;
				}
				ddgForm = new URLSearchParams(body);
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(ddgBody);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		server.close();
	});

	const ddgPage = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b></a><a class="result__snippet" href="#">Snippet &amp; more</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
<div class="result"><a class="result__a" href="https://example.org/b">B</a></div>`;

	it("auto with no keys falls back from a failing Exa to DuckDuckGo and unwraps result links", async () => {
		ddgBody = ddgPage;
		const result = await webSearch(
			{ query: "q one", limit: 5, recency: "day" },
			{ config: { provider: "auto", max_results: 10 }, env: {}, timeoutMs: 5000, endpoints: { exa: `${base}/exa`, duckduckgo: `${base}/ddg` } },
		);
		expect(ddgForm.get("q")).toBe("q one");
		expect(ddgForm.get("df")).toBe("d");
		expect(result.isError).toBe(false);
		expect(result.details.provider).toBe("duckduckgo");
		expect(result.details.errors).toEqual(["exa rate limit reached (429)"]);
		expect(result.text).toBe("[1] Example A\n    https://example.com/a\n    Snippet & more\n[2] B\n    https://example.org/b");
	});

	it("reports a DuckDuckGo bot challenge as an error", async () => {
		ddgBody = '<div class="anomaly-modal">are you a robot</div>';
		const result = await webSearch(
			{ query: "q" },
			{ config: { provider: "duckduckgo", max_results: 10 }, env: {}, timeoutMs: 5000, endpoints: { duckduckgo: `${base}/ddg` } },
		);
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/bot-detection challenge/);
	});

	it("none returns the not-configured message as a non-error", async () => {
		const result = await webSearch({ query: "q" }, { config: { provider: "none", max_results: 10 }, env: {}, timeoutMs: 1000 });
		expect(result).toEqual({ text: SEARCH_NOT_CONFIGURED, isError: false, details: { provider: "none" } });
		expect(SEARCH_NOT_CONFIGURED).toBe(
			"web_search is not configured: set search.provider in .tobor/config.yml and the key in .tobor/state/agent.env",
		);
	});

	it("auto puts keyed and configured providers first", () => {
		const keys: Record<string, string> = { brave: "k" };
		expect(searchChain({ provider: "auto", max_results: 10, url: "https://sx" }, (b) => keys[b])).toEqual(["brave", "searxng", "exa", "duckduckgo"]);
		expect(searchChain({ provider: "tavily", max_results: 10 }, () => undefined)).toEqual(["tavily"]);
	});
});

describe("web tools config and tool lists", () => {
	it("defaults search to auto and fetch to the guarded limits; validates values", () => {
		const { config, errors } = parseConfigText("", "/h");
		expect(errors).toEqual([]);
		expect(config.search).toEqual({ provider: "auto", max_results: 10 });
		expect(config.fetch).toEqual({ allow_private: false, max_chars: 20_000, timeout_ms: 20_000, remote_reader: true });
		const bad = parseConfigText("search: { provider: bing, extra: 1 }\nfetch: { allow_private: yes please }\n", "/h");
		expect(bad.errors.map((e) => e.path).sort()).toEqual(["fetch.allow_private", "search.extra", "search.provider"]);
		const sx = parseConfigText("search: { provider: searxng }\n", "/h");
		expect(sx.errors.map((e) => e.path)).toEqual(["search.url"]);
	});

	it("directors and default workers get fetch_url and web_search", () => {
		expect(DIRECTOR_TOOLS).toEqual(expect.arrayContaining(["fetch_url", "web_search"]));
		expect(selectTools(["read", "bash", "fetch_url", "web_search", "task"], undefined, WORKER_EXCLUDED)).toEqual(["read", "bash", "fetch_url", "web_search"]);
	});
});
