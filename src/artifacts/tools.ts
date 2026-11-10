import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, section, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { ToolModule } from "../tools/registry.js";
import { resolveDesign } from "./design.js";
import { exportHtml, renderPdf } from "./export.js";
import { projectInfo } from "./project.js";
import { createScaffold } from "./scaffold.js";
import type { ArtifactsService } from "./service.js";

/** What the artifact tools need from the node. */
export type ArtifactsDeps = {
	service: ArtifactsService;
	/** Node-level themes dir (`$TOBOR_HOME/.tobor/design-systems`). */
	nodeDesignsDir: string;
	/** Configured theme for a cwd (`config.artifacts.theme` with the project overlay). */
	theme(cwd: string): string | undefined;
};

/** Prompt fragment describing when and how to use the artifact tools. */
export const artifactsGuidance = [
	"Artifacts are self-contained HTML pages published to the artifacts viewer, which keeps every revision.",
	"Use one when a result is easier to see than to read: dashboards, charts, comparisons, walkthroughs, mockups, reports. Not for short answers or ordinary code changes.",
	"Flow: artifact_create({slug, title, layout?}) → read the returned design doc once per session → replace `<!-- content -->` in index.html, keeping the scaffold <head> → artifact_publish({slug}) → give the user the URL. Iterate by editing and publishing again under the same slug.",
	"The viewer is sandboxed with no network: inline all JS and data, no fetch/XHR/WebSocket, no CDN scripts, no local .js files (dropped on publish). Tailwind is already loaded; use only the theme's semantic classes.",
	"For PDFs/documents/one-pagers use layout \"document\", publish, then artifact_export({slug, format: \"pdf\"}).",
].join("\n");

/** `skills/artifacts/SKILL.md` shipped by `tobor init`. */
export const artifactsSkill = `---
name: artifacts
description: Publish viewable HTML artifacts (dashboards, reports, mockups, prototypes, comparisons, walkthroughs) to the tobor artifacts viewer; use when the user asks for an "artifact", a "preview", to "render" something, to "make it viewable", or says "show me".
---

# Artifacts

Artifacts are self-contained HTML documents published to tobor's artifacts viewer (a separate origin from the API, embedded by the web app). The viewer keeps every revision and reloads open viewers when you publish again.

## When to use

Use an artifact when the result is easier to see than to read:

- Dashboards and charts built from data you pulled (logs, metrics, query results, benchmarks).
- Annotated diffs, code walkthroughs, architecture explainers.
- Options side by side: designs, libraries, approaches, trade-off tables.
- UI mockups and clickable prototypes.
- Status boards and checklists kept current during long tasks.
- Reports and plans the user will skim, share, or revisit.

Do not use artifacts for ordinary code changes, short answers, or anything that fits in a few lines of chat.

## Workflow

1. \`artifact_create({ slug, title, design?, layout? })\`. \`slug\` is lowercase kebab-case (\`^[a-z0-9][a-z0-9-]*$\`). The bundle lives at \`<git root>/.tobor/artifacts/<slug>/\`. \`design\` picks a theme other than the configured one (default \`retro-log\`). The result gives the entry file path and the design doc path.
2. Read the returned design doc once per session before writing HTML. Skip it if you already read it this session.
3. Edit \`index.html\` in the bundle directory: replace the \`<!-- content -->\` marker inside \`<main>\`; keep the scaffold \`<head>\`.
4. \`artifact_publish({ slug, title?, tags? })\`.
5. Give the user the URL from the publish result.
6. Iterate: edit the file and call \`artifact_publish\` again with the same slug. Each publish with changed content is a new revision at the same URL; open viewers reload. Unchanged content is deduped.

Keep one slug per artifact; never create \`report-v2\` for a revision. Use \`artifact_list\` to find existing artifacts before creating a new one for the same topic.

## HTML rules

The viewer serves the artifact in a sandboxed iframe with a strict CSP and no network access. Follow these rules or the artifact breaks:

- One HTML document. Keep the scaffold \`<head>\`: the runtime shim, \`assets/tailwind.js\` (vendored Tailwind), the inline Tailwind config, and the inline token \`<style>\`.
- Inline all JavaScript in \`<script>\` tags. Local \`.js\` files other than \`assets/tailwind.js\` are dropped on publish.
- No CDN scripts, styles, or fonts: every \`https:\` source is blocked. Draw charts with inline SVG or a small inline script on \`<canvas>\`.
- No \`fetch\`, XHR, or WebSocket. Inline data as JSON in \`<script type="application/json" id="data">\` and read it with \`JSON.parse(document.getElementById("data").textContent)\`, or as a JS literal.
- Images: put files in the bundle's \`assets/\` and reference them with relative paths (\`assets/chart.png\`), or use \`data:\` URIs. Prefer SVG, HTML, and CSS over raster images.
- Fonts are already inlined in the token styles. Do not add font files or \`@font-face\` rules.
- No forms that submit, no \`<base>\`, no meta refresh. \`localStorage\`, \`sessionStorage\` and the clipboard are in-memory shims: nothing persists across reloads.
- \`layout: "document"\` gives a print/PDF-first A4 page (see PDF-first documents); the default \`screen\` layout is for the browser.

## Design rules

Every artifact uses the configured theme; the built-in default is retro-log, a dark 70s field manual. Read its design doc for the components (\`band\`, \`stamp\`, \`label\`).

- Use semantic token classes only: \`bg-bg\`, \`bg-surface\`, \`bg-sunken\`, \`text-fg\`, \`text-muted\`, \`border-border\`, \`border-border-strong\`, \`bg-primary\`, \`text-primary-fg\`, \`text-primary\`, \`text-accent\`, \`text-success\`, \`text-warning\`, \`text-error\`, \`rounded-sm\`, \`rounded-md\`, \`shadow-sm\`, \`font-display\`, \`font-sans\`, \`font-mono\`, \`font-type\`.
- Never use raw Tailwind palette colors (\`bg-gray-100\`, \`text-slate-600\`) or inline hex values. For charts, read colors from CSS variables: \`getComputedStyle(document.documentElement).getPropertyValue("--color-primary")\`.
- \`font-display\` (Righteous) for titles, big numbers and button labels only; never bold it. \`font-sans\`/\`font-mono\` (Courier Prime) for body, tables, code and IDs. \`font-type\` (Special Elite) for captions, labels and entry numbers only; never paragraphs or code.
- The four-stripe \`band\` once per page, at the top. One \`stamp\` per page. Number entries, figures and sections. One filled \`bg-primary\` button per page; the rest are ghost buttons.
- Status colors only for status: \`success\`, \`warning\`, \`error\`. \`accent\` (orange) only for one word in a title or one abort button.

Quality bar:

- Clear hierarchy: one title, a short summary line, then sections. The most important number or finding comes first.
- Consistent spacing rhythm (\`gap-4\`/\`gap-6\`, \`p-6\` cards, \`space-y-8\` between sections).
- Real data, never lorem ipsum or invented placeholder numbers. Label units and time ranges.
- Works at 1440px and 390px wide: responsive grids (\`grid-cols-1 md:grid-cols-2 xl:grid-cols-4\`), wide tables scroll (\`overflow-x-auto\`).
- Handle empty and error states explicitly ("No failures in the last 24h") instead of blank panels.

## PDF-first documents

Triggers: the user says PDF, document, doc, one-pager, report to share, handout, printable, brief, or memo.

1. \`artifact_create({ slug, title, layout: "document" })\`. The scaffold is a 186 mm wide A4 page with a compact header (fill the subtitle \`<p>\`), \`@page\` rules, and the helper classes \`page-break\`, \`avoid-break\`, \`running-footer\`, \`no-print\`.
2. Write for the page, not the screen:
   - Fixed grids only: \`grid grid-cols-2\` (or \`grid-cols-3\` for small KPIs). No \`md:\`/\`xl:\` prefixes.
   - Nothing wider than 186 mm; no horizontal scroll containers.
   - \`avoid-break\` on cards, tables, figures. \`page-break\` before each major section when the doc runs past one page.
   - Add \`<div class="running-footer"><span>Doc title</span><span>YYYY-MM-DD</span></div>\`; it repeats on every printed page.
   - No interactive-only affordances; put \`no-print\` on buttons, filters, toggles.
   - Charts: no animation, fixed-height wrappers (\`h-64\`).
   - Tables: a real \`<thead>\` so headers repeat across pages.
3. \`artifact_publish({ slug })\` so the user can review live, then \`artifact_export({ slug, format: "pdf" })\`. Hand back both the viewer URL and the PDF path.
4. On every iteration, publish and re-export the PDF.

## Export

\`artifact_export({ slug, format: "pdf" | "html", out? })\` exports the current bundle (published or not). The default output is \`<git root>/.tobor/exports/<slug>.<format>\` (overwritten); \`out\` sets a directory or file path relative to the project. Give the user the returned absolute path. Every published revision also has a PDF link in the viewer.

- HTML export is one self-contained file: images, stylesheets and \`assets/tailwind.js\` are inlined.
- PDF export prints that HTML with headless Chromium on A4 pages (\`TOBOR_CHROME\`, else \`chromium\`/\`google-chrome\` on PATH). Add \`break-inside-avoid\` to blocks that must not split. Layouts print at A4 width (about 700px), so responsive grids use their narrow layout.
`;

type Details = { [key: string]: JsonValue };
type Result = ToolExecutionResult<Details>;

const text = (body: string, details: Details = {}): Result => ({ output: [{ type: "text", text: body }], details });
const fail = (error: unknown): Result => ({
	output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
	isError: true,
});

async function cwdOf(api: ToolExecutionApi<Details>, context: Context): Promise<string> {
	const cwd = (await api.agent(context)).cwd;
	if (!cwd) throw new Error("This session has no working directory");
	return cwd;
}

const createParams = obj({
	slug: str({ description: "Stable artifact key: lowercase letters, digits, dashes (e.g. build-dashboard)" }),
	title: str({ description: "Human-readable title" }),
	design: opt(str({ description: "Theme name under .tobor/design-systems (default: config artifacts.theme, else retro-log)" })),
	layout: opt(
		oneOf(["screen", "document"], {
			description: "document = print/PDF-first A4 page; use when the user wants a PDF, doc, one-pager, report, handout. Default screen",
		}),
	),
});

const publishParams = obj({
	slug: str({ description: "Artifact slug used with artifact_create" }),
	title: opt(str({ description: "Feed title (defaults to the document title)" })),
	tags: opt(arr(str(), { description: "Tags for filtering in the feed" })),
});

const listParams = obj({ all: opt(bool({ description: "Include artifacts from every project" })) });

const exportParams = obj({
	slug: str({ description: "Artifact slug used with artifact_create" }),
	format: oneOf(["pdf", "html"], { description: "pdf or html" }),
	out: opt(str({ description: "Output directory or file path (relative to the project root); default <git root>/.tobor/exports/<slug>.<format>" })),
});


/** `artifact_create`, `artifact_publish`, `artifact_list`, `artifact_export` and the `artifacts` prompt section. */
export function artifactsModule(deps: ArtifactsDeps): ToolModule {
	const { service } = deps;

	const create = defineTool({
		name: "artifact_create",
		description:
			"Create a new artifact bundle at <git root>/.tobor/artifacts/<slug>/ with a themed HTML scaffold (index.html). Edit the returned entry file, then call artifact_publish.",
		parameters: createParams,
		async execute(args, api, context) {
			try {
				const cwd = await cwdOf(api, context);
				const { dir, root } = await service.bundleDir(cwd, args.slug);
				if (existsSync(dir)) {
					return fail(`Artifact "${args.slug}" already exists at ${dir}. Edit its entry file and call artifact_publish, or choose another slug.`);
				}
				const design = resolveDesign(args.design, deps.theme(cwd), {
					node: deps.nodeDesignsDir,
					project: join(root, ".tobor", "design-systems"),
				});
				const entry = await createScaffold(dir, design, args.title, args.layout ?? "screen");
				return text(
					[
						`Created ${entry}`,
						`Design: ${design.name}`,
						`Next: edit the file, then artifact_publish({ slug: "${args.slug}" }).`,
						`Design doc (read once per session): ${design.docPath}`,
					].join("\n"),
					{ slug: args.slug, dir, entry, design: design.name, layout: args.layout ?? "screen" },
				);
			} catch (error) {
				return fail(error);
			}
		},
	});

	const publish = defineTool({
		name: "artifact_publish",
		description:
			"Publish (or re-publish) the artifact bundle <git root>/.tobor/artifacts/<slug>/ to the artifacts viewer. Each publish with changed content creates a new revision at the same URL; open viewers reload.",
		parameters: publishParams,
		async execute(args, api, context) {
			try {
				const cwd = await cwdOf(api, context);
				const result = await service.publish({
					cwd,
					slug: args.slug,
					...(args.title === undefined ? {} : { title: args.title }),
					...(args.tags === undefined ? {} : { tags: args.tags }),
					conversationId: api.conversationId,
				});
				const { artifact } = result;
				const lines = [`URL: ${result.latestUrl}`, `Revision: ${artifact.revision} (${artifact.url})`];
				lines.push(result.deduped ? "Content unchanged; no new revision." : "Open viewers update in place.");
				if (result.dropped.length) lines.push(`Dropped: ${result.dropped.join(", ")} (local scripts and non-files are not published)`);
				return text(lines.join("\n"), {
					artifact: { ...artifact, tags: [...artifact.tags] },
					deduped: result.deduped,
					latestUrl: result.latestUrl,
					dropped: result.dropped,
				});
			} catch (error) {
				return fail(error);
			}
		},
	});

	const list = defineTool({
		name: "artifact_list",
		description: "List published artifacts (latest revision per slug) for this project, or across all projects with all: true.",
		parameters: listParams,
		replay: "safe",
		async execute(args, api, context) {
			try {
				const projectId = args.all ? undefined : (await projectInfo(await cwdOf(api, context))).projectId;
				const artifacts = await service.list(projectId);
				if (artifacts.length === 0) return text("No artifacts published.", { artifacts: [] });
				const rows = artifacts.map((a) => `${a.slug}  r${a.latest.revision}  ${a.title}  ${a.url}`);
				return text(["slug  rev  title  url", ...rows].join("\n"), {
					artifacts: artifacts.map((a) => ({ ...a, latest: { ...a.latest, tags: [...a.latest.tags] } })),
				});
			} catch (error) {
				return fail(error);
			}
		},
	});

	const exportTool = defineTool({
		name: "artifact_export",
		description:
			"Export an artifact bundle to a single self-contained HTML file (local assets inlined) or an A4 PDF rendered by headless Chromium. Default output: <git root>/.tobor/exports/<slug>.<format>, overwriting any existing file.",
		parameters: exportParams,
		async execute(args, api, context) {
			try {
				const cwd = await cwdOf(api, context);
				const { dir, root } = await service.bundleDir(cwd, args.slug);
				if (!existsSync(dir)) return fail(`No artifact bundle at ${dir}. Create it with artifact_create first.`);
				const fileName = `${args.slug}.${args.format}`;
				let path = join(root, ".tobor", "exports", fileName);
				if (args.out) {
					const target = resolve(root, args.out);
					const isDir = /[\\/]$/.test(args.out) || (existsSync(target) && statSync(target).isDirectory());
					path = isDir ? join(target, fileName) : target;
				}
				await mkdir(dirname(path), { recursive: true });
				const html = exportHtml(dir);
				let chrome: string | undefined;
				if (args.format === "html") await writeFile(path, html);
				else chrome = await renderPdf(html, path);
				const bytes = statSync(path).size;
				const lines = [`Exported ${path} (${bytes} bytes)`];
				if (chrome) lines.push(`Rendered with ${chrome}`);
				return text(lines.join("\n"), { path, bytes, format: args.format, ...(chrome ? { chrome } : {}) });
			} catch (error) {
				return fail(error);
			}
		},
	});

	return {
		tools: [create, publish, list, exportTool],
		sections: [section("artifacts", () => artifactsGuidance)],
	};
}
