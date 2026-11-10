import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THEME } from "../config/schema.js";

/** A resolved theme: docs, tokens with fonts inlined, Tailwind config, optional logo. */
export interface Design {
	name: string;
	dir: string;
	doc: string;
	docPath: string;
	tokensCss: string;
	tailwindConfig: string;
	logo?: { dataUri: string };
}

/** Directories searched for themes: project shadows node by name. */
export type DesignDirs = { node: string; project?: string };

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

const here = dirname(fileURLToPath(import.meta.url));
/** Root of the non-TS artifact assets (`themes/`, `vendor/`); falls back to `src/artifacts` when running from `dist/`. */
export const ASSET_ROOT = isDir(join(here, "themes")) ? here : resolve(here, "../../src/artifacts");
/** Built-in themes shipped with tobor. */
export const BUILTIN_THEMES_DIR = join(ASSET_ROOT, "themes");

const SUBSETS = [
	"latin",
	"latin-ext",
	"cyrillic",
	"cyrillic-ext",
	"greek",
	"greek-ext",
	"vietnamese",
	"math",
	"symbols",
	"hebrew",
	"arabic",
	"armenian",
	"devanagari",
	"bengali",
	"georgian",
	"khmer",
	"thai",
	"tamil",
	"telugu",
	"japanese",
	"korean",
	"chinese-simplified",
	"chinese-traditional",
	"emoji",
];
const SUBSET_SUFFIX = new RegExp(`-(${SUBSETS.join("|")})\\.[a-z0-9]+$`, "i");
const KEEP_SUFFIX = /-latin(-ext)?\.[a-z0-9]+$/i;

const FONT_MIME: Record<string, string> = {
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".svg": "image/svg+xml",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

function readOptional(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function fontFile(dir: string, ref: string): string {
	const clean = ref.split(/[?#]/)[0] ?? "";
	return clean.startsWith("/") ? join(dir, clean) : resolve(dir, clean);
}

/** Replace local `url()` font refs with `data:` URIs; drop `@font-face` rules for non-latin subsets or missing files. */
export function inlineFonts(dir: string, css: string): string {
	const kept = css.replace(/@font-face\s*\{[^}]*\}\s*/g, (rule) => {
		const refs = [...rule.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2] ?? "");
		const skipped = refs
			.filter((ref) => !/^(data:|https?:)/.test(ref))
			.some((ref) => {
				const file = basename(ref);
				return (SUBSET_SUFFIX.test(file) && !KEEP_SUFFIX.test(file)) || !existsSync(fontFile(dir, ref));
			});
		return skipped ? "" : rule;
	});
	return kept.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote: string, ref: string) => {
		if (/^(data:|https?:)/.test(ref)) return match;
		const file = fontFile(dir, ref);
		const mime = FONT_MIME[extname(file).toLowerCase()];
		if (!mime || !existsSync(file)) return match;
		return `url("data:${mime};base64,${readFileSync(file).toString("base64")}")`;
	});
}

function findLogo(dir: string): Design["logo"] {
	const images = join(dir, "assets", "images");
	if (!isDir(images)) return undefined;
	const pick = readdirSync(images)
		.filter((file) => /\.(svg|png|webp|jpe?g)$/i.test(file))
		.find((file) => /(logo|mark)/i.test(file));
	if (!pick) return undefined;
	const mime = IMAGE_MIME[extname(pick).toLowerCase()];
	return { dataUri: `data:${mime};base64,${readFileSync(join(images, pick)).toString("base64")}` };
}

function themeDirs(dirs: DesignDirs): string[] {
	return [dirs.project, dirs.node, BUILTIN_THEMES_DIR].filter((d): d is string => !!d);
}

/** Theme names available: project, node and built-in, deduplicated and sorted. */
export function listDesigns(dirs: DesignDirs): string[] {
	const names = new Set<string>();
	for (const root of themeDirs(dirs)) {
		if (!isDir(root)) continue;
		for (const entry of readdirSync(root)) if (existsSync(join(root, entry, "tokens.css"))) names.add(entry);
	}
	return [...names].sort();
}

/** Load the theme `name` (project dir shadows node dir shadows built-in), or `undefined` if none has `tokens.css`. */
export function loadDesign(name: string, dirs: DesignDirs): Design | undefined {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
	const found = themeDirs(dirs)
		.map((root) => join(root, name))
		.find((dir) => existsSync(join(dir, "tokens.css")));
	if (!found) return undefined;
	const dir = realpathSync(found);
	const docPath = join(dir, "design-system.md");
	return {
		name,
		dir,
		doc: readOptional(docPath),
		docPath,
		tokensCss: inlineFonts(dir, readOptional(join(dir, "tokens.css"))),
		tailwindConfig: readOptional(join(dir, "tailwind.config.js")),
		logo: findLogo(dir),
	};
}

/** Resolve the theme for a scaffold: `requested`, then `configured` (`config.artifacts.theme`), then the built-in default. Throws for an unknown `requested`. */
export function resolveDesign(requested: string | undefined, configured: string | undefined, dirs: DesignDirs): Design {
	if (requested) {
		const design = loadDesign(requested, dirs);
		if (!design) throw new Error(`Unknown design system "${requested}". Available: ${listDesigns(dirs).join(", ")}`);
		return design;
	}
	const design = (configured && loadDesign(configured, dirs)) || loadDesign(DEFAULT_THEME, dirs);
	if (!design) throw new Error(`Built-in theme ${DEFAULT_THEME} is missing from ${BUILTIN_THEMES_DIR}`);
	return design;
}
