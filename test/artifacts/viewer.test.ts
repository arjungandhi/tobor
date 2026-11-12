import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDesigns, loadDesign, resolveDesign } from "../../src/artifacts/design.js";
import { exportHtml, probeChrome } from "../../src/artifacts/export.js";
import { sanitizeHtml } from "../../src/artifacts/sanitize.js";
import { createScaffold, htmlScaffold, RUNTIME_SHIM } from "../../src/artifacts/scaffold.js";
import { ArtifactsService } from "../../src/artifacts/service.js";
import { ARTIFACT_CSP, containedFile, createArtifactHandler, WRAPPER_CSP } from "../../src/artifacts/viewer.js";
import type { NodeEvent } from "../../src/api/types.js";
import { EventBus } from "../../src/events.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tobor-viewer-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("design", () => {
	it("resolves the built-in retro-log with fonts inlined", () => {
		const design = resolveDesign(undefined, undefined, { node: join(root, "none") });
		expect(design.name).toBe("retro-log");
		expect(design.tokensCss).toContain("--color-bg: #2A2420");
		expect(design.tokensCss).toContain("--color-primary: #E0A23B");
		expect(design.tokensCss.match(/url\("data:font\/woff2;base64,/g)).toHaveLength(5);
		expect(design.tailwindConfig).toContain('"var(--color-surface)"');
		expect(design.doc).toContain("four-stripe");
	});

	it("lets project themes shadow node themes and falls back from an unknown configured theme", () => {
		const node = join(root, "node-themes");
		const project = join(root, "project-themes");
		for (const [dir, color] of [[node, "#111"], [project, "#222"]] as const) {
			mkdirSync(join(dir, "mine", "assets", "images"), { recursive: true });
			writeFileSync(join(dir, "mine", "tokens.css"), `:root{--color-bg:${color}}`);
		}
		writeFileSync(join(project, "mine", "assets", "images", "logo.svg"), "<svg/>");
		const dirs = { node, project };
		expect(loadDesign("mine", dirs)?.tokensCss).toContain("#222");
		expect(loadDesign("mine", dirs)?.logo?.dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
		expect(loadDesign("mine", { node })?.tokensCss).toContain("#111");
		expect(listDesigns(dirs)).toEqual(["mine", "retro-log"]);
		expect(resolveDesign(undefined, "mine", dirs).name).toBe("mine");
		expect(resolveDesign(undefined, "gone", dirs).name).toBe("retro-log");
		expect(() => resolveDesign("gone", undefined, dirs)).toThrow(/Unknown design system "gone"/);
		expect(loadDesign("../x", dirs)).toBeUndefined();
	});
});

describe("scaffold", () => {
	const design = resolveDesign(undefined, undefined, { node: join(root, "none") });

	it("inlines tokens, config and the runtime shim, and loads only the vendored tailwind", () => {
		const html = htmlScaffold(design, "A <b> title", "screen");
		expect(html).toContain("<title>A &lt;b&gt; title</title>");
		expect(html).toContain(RUNTIME_SHIM);
		expect(html).toContain('<script src="assets/tailwind.js"></script>');
		expect(html).toContain("tailwind.config = {");
		expect(html).toContain("--color-fg: #EADFC6");
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).toContain("<!-- content -->");
		expect(html).not.toContain("@page");
		expect(htmlScaffold(design, "Doc", "document")).toContain("@page { size: A4");
	});

	it("writes index.html and copies the vendored tailwind", async () => {
		const dir = join(root, "bundle-scaffold");
		const entry = await createScaffold(dir, design, "T");
		expect(readFileSync(entry, "utf8")).toContain("<title>T</title>");
		expect(readFileSync(join(dir, "assets", "tailwind.js"), "utf8").length).toBeGreaterThan(100_000);
	});

	it("exports a self-contained html with tailwind inlined", async () => {
		const html = exportHtml(join(root, "bundle-scaffold"));
		expect(html).toContain('<script src="data:text/javascript;base64,');
		expect(html).toContain("print-color-adjust");
	});
});

describe("sanitizeHtml", () => {
	it.each([
		['<meta http-equiv="refresh" content="0;url=https://x">', ""],
		["<meta content='0' HTTP-EQUIV=Refresh>", ""],
		['<base href="https://evil/">', ""],
		['<link rel="preload" href="x.css" as="style">', ""],
		["<link rel=prefetch href=x>", ""],
		['<link rel="dns-prefetch preconnect" href="https://x">', ""],
		['<link rel="modulepreload" href="x.js">', ""],
		['<link rel="stylesheet" href="assets/a.css">', '<link rel="stylesheet" href="assets/a.css">'],
		['<meta charset="utf-8">', '<meta charset="utf-8">'],
		["<basefont>", "<basefont>"],
	])("%s", (input, output) => {
		expect(sanitizeHtml(`<head>${input}</head>`)).toBe(`<head>${output}</head>`);
	});
});

describe("viewer", () => {
	const home = join(root, "home");
	const project = join(root, "proj");
	const events: NodeEvent[] = [];
	let server: Server;
	let base: string;
	let service: ArtifactsService;
	let rev: string;
	let projectId: string;

	beforeAll(async () => {
		const bus = new EventBus();
		bus.onAny((e) => events.push(e));
		service = new ArtifactsService({
			paths: { artifactsFeed: join(home, "feed.jsonl"), artifactsStore: join(home, "store"), artifactsPdf: join(home, "pdf") },
			events: bus,
			artifactsUrl: () => base,
		});
		await service.init();
		const handler = createArtifactHandler(service);
		server = createServer((req, res) => {
			void handler(req, res).then((handled) => {
				if (!handled) {
					res.writeHead(418);
					res.end();
				}
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const bundle = join(project, ".tobor", "artifacts", "demo");
		mkdirSync(join(bundle, "assets"), { recursive: true });
		writeFileSync(
			join(bundle, "index.html"),
			'<html><head><title>Demo</title><base href="https://x/"><meta http-equiv="refresh" content="0"></head><body class="bg-bg">hi<img src="assets/p.svg"></body></html>',
		);
		writeFileSync(join(bundle, "assets", "p.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "secret.txt"), "secret");
		const published = await service.publish({ cwd: project, slug: "demo", tags: ["t"] });
		rev = published.artifact.rev;
		projectId = published.artifact.projectId;
		symlinkSync(join(home, "secret.txt"), join(service.store.dirOf({ projectId, slug: "demo", rev }), "assets", "leak.txt"));
	});
	afterAll(() => new Promise<void>((done) => server.close(() => done())));

	it("publishes, emits and dedupes", async () => {
		expect(events.filter((e) => e.type === "artifact.published")).toHaveLength(1);
		const again = await service.publish({ cwd: project, slug: "demo", tags: ["t"] });
		expect(again.deduped).toBe(true);
		expect(events).toHaveLength(1);
		const [summary] = await service.list({ projectId });
		expect(summary?.url).toBe(`${base}/art/${projectId}/demo`);
		expect(summary?.latest.url).toBe(`${base}/art/r/${rev}`);
	});

	it("serves the sanitized revision with the CSP header", async () => {
		const res = await fetch(`${base}/art/r/${rev}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
		expect(ARTIFACT_CSP).toContain("connect-src 'none'");
		expect(ARTIFACT_CSP).toContain("form-action 'none'");
		expect(ARTIFACT_CSP).toMatch(/^sandbox allow-scripts allow-popups;/);
		expect(ARTIFACT_CSP).not.toContain("https:");
		const body = await res.text();
		expect(body).toContain("hi");
		expect(body).not.toContain("<base");
		expect(body).not.toContain("refresh");
		const asset = await fetch(`${base}/art/r/${rev}/assets/p.svg`);
		expect(asset.headers.get("content-type")).toBe("image/svg+xml");
		expect(asset.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
	});

	it("redirects bare rev URLs and wraps the latest URL in a live frame", async () => {
		const bare = await fetch(`${base}/art/r/${rev}`, { redirect: "manual" });
		expect(bare.status).toBe(301);
		expect(bare.headers.get("location")).toBe(`/art/r/${rev}/`);
		for (const path of [`/art/${projectId}/demo`, `/art/${projectId}/demo/`]) {
			const latest = await fetch(base + path, { redirect: "manual" });
			expect(latest.status, path).toBe(200);
			expect(latest.headers.get("content-type")).toContain("text/html");
			expect(latest.headers.get("cache-control")).toBe("no-store");
			const body = await latest.text();
			expect(body).toContain("<title>Demo</title>");
			expect(body).toContain(`src="/art/r/${rev}/"`);
			expect(body).toContain('sandbox="allow-scripts allow-popups"');
			expect(body).toContain(`/art/${projectId}/demo/rev`);
			expect(body).toContain("visibilitychange");
		}
		const headRes = await fetch(`${base}/art/${projectId}/demo`, { method: "HEAD" });
		expect(headRes.status).toBe(200);
		expect(await headRes.text()).toBe("");
		expect((await fetch(`${base}/art/${projectId}/nope`)).status).toBe(404);
	});

	it("serves the wrapper and /rev with the wrapper CSP, revisions keep the artifact CSP", async () => {
		expect(WRAPPER_CSP).toContain("connect-src 'self'");
		expect(WRAPPER_CSP).toContain("frame-src 'self'");
		expect(WRAPPER_CSP).not.toContain("sandbox");
		for (const path of [`/art/${projectId}/demo`, `/art/${projectId}/demo/rev`]) {
			const res = await fetch(base + path);
			expect(res.headers.get("content-security-policy"), path).toBe(WRAPPER_CSP);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		}
		for (const path of [`/art/r/${rev}/`, `/art/r/${rev}/assets/p.svg`]) {
			expect((await fetch(base + path)).headers.get("content-security-policy"), path).toBe(ARTIFACT_CSP);
		}
	});

	it("reports the latest rev as JSON and 404s unknown artifacts", async () => {
		const res = await fetch(`${base}/art/${projectId}/demo/rev`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ rev });
		expect((await fetch(`${base}/art/${projectId}/nope/rev`)).status).toBe(404);
		expect((await fetch(`${base}/art/${projectId}/rev`)).status).toBe(404);
	});

	it("keeps paths inside the revision dir", async () => {
		for (const path of [
			`/art/r/${rev}/assets/..%5c..%5c..%5csecret.txt`,
			`/art/r/${rev}/assets/..%2f..%2f..%2fsecret.txt`,
			`/art/r/${rev}/assets/leak.txt`,
			`/art/r/${rev}/assets/%00`,
			`/art/r/${rev}/assets/%E0%A4%A`,
			`/art/r/rev_000000000000/`,
		]) {
			expect((await fetch(base + path)).status, path).toBe(404);
		}
		const dir = service.store.dirOf({ projectId, slug: "demo", rev });
		expect(await containedFile(dir, "assets/../../../../secret.txt")).toBeUndefined();
		expect(await containedFile(dir, "assets/p.svg")).toBe(join(dir, "assets", "p.svg"));
		expect((await fetch(`${base}/elsewhere`)).status).toBe(418);
		expect((await fetch(`${base}/art/r/${rev}/`, { method: "POST" })).status).toBe(405);
	});

	it("renders, caches and streams the PDF (skipped without Chromium)", async (ctx) => {
		if (!(await probeChrome()).found) ctx.skip();
		const first = await fetch(`${base}/art/r/${rev}.pdf`);
		expect(first.status).toBe(503);
		expect(first.headers.get("retry-after")).toBe("5");
		expect((await fetch(`${base}/art/${projectId}/demo.pdf`)).status).toBe(503);
		await service.waitPdf(rev);
		expect(existsSync(join(home, "pdf", `${rev}.pdf`))).toBe(true);
		const ready = await fetch(`${base}/art/${projectId}/demo.pdf`);
		expect(ready.status).toBe(200);
		expect(ready.headers.get("content-type")).toBe("application/pdf");
		expect(ready.headers.get("content-disposition")).toBe('attachment; filename="demo-r1.pdf"');
		expect(Buffer.from(await ready.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
	}, 150_000);

	it("moves the durable URL to a new revision while old revisions stay reachable", async () => {
		const bundle = join(project, ".tobor", "artifacts", "demo");
		writeFileSync(join(bundle, "index.html"), "<html><head><title>Demo v2</title></head><body>second</body></html>");
		const next = await service.publish({ cwd: project, slug: "demo", tags: ["t"] });
		const newRev = next.artifact.rev;
		expect(newRev).not.toBe(rev);
		expect(await (await fetch(`${base}/art/${projectId}/demo/rev`)).json()).toEqual({ rev: newRev });
		const wrapper = await (await fetch(`${base}/art/${projectId}/demo`)).text();
		expect(wrapper).toContain("<title>Demo v2</title>");
		expect(wrapper).toContain(`src="/art/r/${newRev}/"`);
		expect(wrapper).not.toContain(`src="/art/r/${rev}/"`);
		expect(await (await fetch(`${base}/art/r/${newRev}/`)).text()).toContain("second");
		const old = await fetch(`${base}/art/r/${rev}/`);
		expect(old.status).toBe(200);
		expect(await old.text()).toContain("hi");
	});
});
