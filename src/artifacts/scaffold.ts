import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASSET_ROOT, type Design } from "./design.js";

/** Tailwind Play CDN build vendored at `vendor/tailwind.js` (from `https://cdn.tailwindcss.com/3.4.17`). */
export const TAILWIND_VERSION = "3.4.17";
/** Vendored Tailwind runtime copied into every scaffold. */
export const TAILWIND_SOURCE = join(ASSET_ROOT, "vendor", "tailwind.js");
/** Bundle-relative path of the vendored Tailwind runtime. */
export const TAILWIND_BUNDLE_PATH = "assets/tailwind.js";

/** Scaffold layouts: `screen` for the browser, `document` for A4 print/PDF. */
export type Layout = "screen" | "document";

/** In-memory `localStorage`/`sessionStorage` and a clipboard fallback, since the sandboxed viewer has neither. */
export const RUNTIME_SHIM = [
	"(function () {",
	"  function memoryStorage() {",
	"    var m = new Map();",
	"    return {",
	"      get length() { return m.size; },",
	"      key: function (i) { var k = Array.from(m.keys())[i]; return k === undefined ? null : k; },",
	"      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },",
	"      setItem: function (k, v) { m.set(String(k), String(v)); },",
	"      removeItem: function (k) { m.delete(String(k)); },",
	"      clear: function () { m.clear(); }",
	"    };",
	"  }",
	'  ["localStorage", "sessionStorage"].forEach(function (name) {',
	"    var ok = false;",
	"    try { ok = !!window[name]; window[name].getItem('x'); } catch (e) { ok = false; }",
	"    if (!ok) Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });",
	"  });",
	"  function copyFallback(text) {",
	"    var ta = document.createElement('textarea');",
	"    ta.value = String(text); ta.style.position = 'fixed'; ta.style.opacity = '0';",
	"    document.body.appendChild(ta); ta.select();",
	"    try { document.execCommand('copy'); } catch (e) {}",
	"    ta.remove();",
	"    return Promise.resolve();",
	"  }",
	"  var native = navigator.clipboard;",
	"  var clipboard = {",
	"    writeText: function (text) { return native && native.writeText ? native.writeText(text).catch(function () { return copyFallback(text); }) : copyFallback(text); },",
	"    readText: function () { return Promise.resolve(''); }",
	"  };",
	"  try { Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true }); } catch (e) {}",
	"})();",
].join("\n");

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DOCUMENT_CSS = `<style>
@page { size: A4; margin: 12mm; background: var(--color-bg); }
.page-break { break-before: page; }
.avoid-break { break-inside: avoid; }
.running-footer { display: none; position: fixed; bottom: 0; left: 0; right: 0; font-size: 8pt; color: var(--color-muted); }
@media print {
  .running-footer { display: flex; justify-content: space-between; }
  .no-print { display: none; }
  body { background: var(--color-bg); }
}
</style>`;

/** `index.html` for a new bundle: vendored Tailwind, theme config and tokens inline, runtime shim, layout skeleton. */
export function htmlScaffold(design: Design, title: string, layout: Layout = "screen", today = new Date()): string {
	const safeTitle = escapeHtml(title);
	const head = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${safeTitle}</title>`,
		`<script>\n${RUNTIME_SHIM}\n</script>`,
		`<script src="${TAILWIND_BUNDLE_PATH}"></script>`,
	];
	if (design.tailwindConfig) head.push(`<script>\n${design.tailwindConfig.trim()}\n</script>`);
	if (design.tokensCss) head.push(`<style>\n${design.tokensCss.trim()}\n</style>`);
	if (layout === "document") head.push(DOCUMENT_CSS);
	head.push("</head>");
	const logo = design.logo ? `<img src="${design.logo.dataUri}" alt="${escapeHtml(design.name)}" class="h-8 w-auto">` : "";
	const body =
		layout === "document"
			? [
					'<body class="bg-bg text-fg font-sans antialiased">',
					'<main class="mx-auto max-w-[186mm] px-0 py-8 print:py-0">',
					'<header class="mb-6 flex items-start gap-4 border-b border-border pb-4">',
					logo,
					"<div>",
					`<h1 class="font-display text-[30px] leading-tight tracking-tight">${safeTitle}</h1>`,
					'<p class="text-muted text-sm"><!-- subtitle --></p>',
					`<p class="text-muted text-xs">${today.toISOString().slice(0, 10)}</p>`,
					"</div>",
					"</header>",
					"<!-- content -->",
					"</main>",
					"</body>",
					"</html>",
					"",
				]
			: [
					'<body class="min-h-screen bg-bg text-fg font-sans antialiased">',
					'<header class="border-b border-border">',
					'<div class="mx-auto flex max-w-6xl items-center gap-4 px-6 py-5">',
					logo,
					`<h1 class="font-display text-3xl tracking-tight">${safeTitle}</h1>`,
					"</div>",
					"</header>",
					'<main class="mx-auto max-w-6xl px-6 py-8">',
					"<!-- content -->",
					"</main>",
					"</body>",
					"</html>",
					"",
				];
	return [...head, ...body.filter(Boolean)].join("\n");
}

/** Write a new bundle at `dir` (must not exist): `index.html` plus `assets/tailwind.js`. Returns the entry path. */
export async function createScaffold(dir: string, design: Design, title: string, layout: Layout = "screen"): Promise<string> {
	await mkdir(join(dir, "assets"), { recursive: true });
	await copyFile(TAILWIND_SOURCE, join(dir, TAILWIND_BUNDLE_PATH));
	const entry = join(dir, "index.html");
	await writeFile(entry, htmlScaffold(design, title, layout));
	return entry;
}
