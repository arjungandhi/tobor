import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkUrlTarget, type FetchOptions, fetchUrl, isPrivateAddress } from "../../src/tools/web/fetch.js";

describe("SSRF guard", () => {
	it("classifies private, loopback and link-local addresses", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe"]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		for (const ip of ["93.184.215.14", "8.8.8.8", "2606:4700::6810:85e5", "::ffff:8.8.8.8"]) {
			expect(isPrivateAddress(ip), ip).toBe(false);
		}
	});

	it("refuses literal private hosts without resolving", async () => {
		const never = async () => {
			throw new Error("resolver must not be called");
		};
		for (const url of ["http://127.0.0.1/", "http://10.0.0.5:8080/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://2130706433/"]) {
			expect(await checkUrlTarget(new URL(url), never), url).toMatch(/private\/loopback\/link-local/);
		}
	});

	it("resolves names: refuses when any address is private, allows public ones", async () => {
		const resolver = async (host: string) => (host === "internal.test" ? ["93.184.215.14", "10.0.0.1"] : ["93.184.215.14"]);
		expect(await checkUrlTarget(new URL("https://internal.test/"), resolver)).toMatch(/10\.0\.0\.1/);
		expect(await checkUrlTarget(new URL("https://public.test/"), resolver)).toBeUndefined();
	});

	it("fetchUrl refuses a private target unless allow_private", async () => {
		const result = await fetchUrl("http://127.0.0.1:1/", { maxChars: 1000, timeoutMs: 2000, allowPrivate: false, remoteReader: false });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/^refused to fetch/);
	});
});

describe("fetchUrl against a local server", () => {
	let server: Server;
	let base: string;
	const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
		"/page": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				`<html><head><title>Local Page</title></head><body><nav>menu</nav><h1>Hello</h1><p>${"Body text that is long enough to count as content. ".repeat(4)}<a href="/other">other</a></p></body></html>`,
			);
		},
		"/long": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("x".repeat(5000));
		},
		"/json": (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"a":1,"b":[true]}');
		},
		"/md": (req, res) => {
			res.writeHead(200, { "Content-Type": "text/markdown" });
			res.end(`# Markdown\n\naccept=${req.headers.accept}\nua=${req.headers["user-agent"]}`);
		},
		"/redirect": (_req, res) => {
			res.writeHead(302, { Location: "/page" });
			res.end();
		},
		"/loop": (_req, res) => {
			res.writeHead(301, { Location: "/loop" });
			res.end();
		},
		"/pdf": (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/pdf" });
			res.end("%PDF-1.4 not really");
		},
		"/png": (_req, res) => {
			res.writeHead(200, { "Content-Type": "image/png" });
			res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		},
		"/missing": (_req, res) => {
			res.writeHead(404, { "Content-Type": "text/html" });
			res.end("<html><head><title>Not Found</title></head><body><p>nope</p></body></html>");
		},
		"/blocked": (req, res) => {
			if (req.headers["user-agent"] === "tobor") {
				res.writeHead(403, { "Content-Type": "text/plain" });
				res.end("bots go away");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("welcome, browser");
		},
		"/feed": (_req, res) => {
			res.writeHead(200, { "Content-Type": "application/rss+xml" });
			res.end(
				"<rss><channel><title>News</title><item><title>First &amp; best</title><link>https://e.org/1</link><description><![CDATA[<b>Big</b> news]]></description></item></channel></rss>",
			);
		},
		"/spa": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end('<html><head><title>App</title><link rel="alternate" type="text/markdown" href="/spa.md"></head><body><div id="root">Please enable JavaScript</div></body></html>');
		},
		"/spa.md": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/markdown" });
			res.end(`# App docs\n\n${"Real markdown content for agents. ".repeat(6)}`);
		},
		"/docs/gated": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<html><head><title>Gated</title></head><body><noscript>Please enable JavaScript</noscript><p>Please enable JavaScript to continue.</p></body></html>");
		},
		"/docs/llms.txt": (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`# Docs index\n\n${"- [Guide](https://e.org/guide): how to use it\n".repeat(4)}`);
		},
	};

	beforeAll(async () => {
		server = createServer((req, res) => {
			const route = routes[new URL(req.url ?? "/", "http://x").pathname];
			if (route) route(req, res);
			else {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("no route");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		server.close();
	});

	const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({ maxChars: 20_000, timeoutMs: 5000, allowPrivate: true, remoteReader: false, ...over });

	it("renders HTML with a Title/URL header and details", async () => {
		const result = await fetchUrl(`${base}/page`, opts());
		expect(result.isError).toBe(false);
		expect(result.text).toMatch(new RegExp(`^Title: Local Page\\nURL: ${base}/page\\n\\n# Hello\\n\\nBody text`));
		expect(result.text).toContain(`[other](${base}/other)`);
		expect(result.text).not.toContain("menu");
		expect(result.details).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8", truncated: false, method: "html" });
		expect(result.details?.bytes).toBeGreaterThan(100);
	});

	it("follows redirects and reports the final URL", async () => {
		const result = await fetchUrl(`${base}/redirect`, opts());
		expect(result.text).toContain(`URL: ${base}/page`);
		expect(result.details?.url).toBe(`${base}/page`);
	});

	it("gives up on redirect loops", async () => {
		const result = await fetchUrl(`${base}/loop`, opts());
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/too many redirects/);
	});

	it("re-checks the SSRF guard on every redirect hop", async () => {
		// The first hop is allowed by a resolver pretending the host is public; the redirect target is not.
		const result = await fetchUrl(`${base}/redirect`, opts({ allowPrivate: false, resolve: async () => ["93.184.215.14"] }));
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/refused to fetch/);
	});

	it("truncates to max_chars with a note", async () => {
		const result = await fetchUrl(`${base}/long`, opts({ maxChars: 100 }));
		expect(result.text).toContain(`${"x".repeat(100)}\n\n[truncated: showing 100 of 5000 characters`);
		expect(result.details?.truncated).toBe(true);
	});

	it("pretty-prints JSON and passes markdown through, sending User-Agent tobor and preferring markdown", async () => {
		const json = await fetchUrl(`${base}/json`, opts());
		expect(json.text).toContain('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
		const md = await fetchUrl(`${base}/md`, opts());
		expect(md.text).toContain("# Markdown");
		expect(md.text).toMatch(/accept=text\/markdown/);
		expect(md.text).toContain("ua=tobor");
	});

	it("renders RSS feeds as markdown", async () => {
		const result = await fetchUrl(`${base}/feed`, opts());
		expect(result.text).toContain("# News\n\n## First & best\nBig news\n\n[Read more](https://e.org/1)");
	});

	it("retries a bot-blocked request with a browser identity", async () => {
		const result = await fetchUrl(`${base}/blocked`, opts());
		expect(result.isError).toBe(false);
		expect(result.text).toContain("welcome, browser");
	});

	it("uses a page-specific markdown alternate", async () => {
		const result = await fetchUrl(`${base}/spa`, opts());
		expect(result.details?.method).toBe("markdown-alternate");
		expect(result.text).toContain("Title: App\nURL: " + `${base}/spa.md`);
		expect(result.text).toContain("# App docs");
	});

	it("falls back to a scoped llms.txt for JavaScript-gated pages", async () => {
		const result = await fetchUrl(`${base}/docs/gated`, opts());
		expect(result.details?.method).toBe("llms.txt");
		expect(result.text).toContain("# Docs index");
	});

	it("reports PDFs and binary content types as errors", async () => {
		const pdf = await fetchUrl(`${base}/pdf`, opts());
		expect(pdf.isError).toBe(true);
		expect(pdf.text).toMatch(/is a PDF and pdftotext/);
		const png = await fetchUrl(`${base}/png`, opts());
		expect(png.isError).toBe(true);
		expect(png.text).toMatch(/unsupported content type image\/png/);
	});

	it("marks non-2xx responses as errors but keeps the body", async () => {
		const result = await fetchUrl(`${base}/missing`, opts());
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/^HTTP 404 Not Found\nTitle: Not Found\n/);
		expect(result.details?.status).toBe(404);
	});

	it("rejects non-http schemes", async () => {
		const result = await fetchUrl("file:///etc/passwd", opts());
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/unsupported URL scheme file:/);
	});
});
