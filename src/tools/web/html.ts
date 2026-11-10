// A small HTML → Markdown-ish text converter for `fetch_url`: a forgiving tokenizer builds a loose tree, then a
// renderer keeps headings (`#`), links (`[text](url)`), lists, code blocks and table rows, and drops page chrome
// (script, style, nav, footer, …). Not a spec-complete HTML parser; it aims for readable text from real pages.

type Element = { tag: string; attrs: Record<string, string>; children: Node[]; parent?: Element };
type Node = Element | string;

/** Elements whose content is dropped entirely. */
const SKIP = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"canvas",
	"iframe",
	"object",
	"embed",
	"nav",
	"footer",
	"head",
	"select",
	"button",
	"dialog",
]);
/** Elements with no content or end tag. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is raw text up to the matching end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "plaintext"]);
/** Block-level elements: they start a new paragraph. Anything else is treated as inline (transparent). */
const BLOCK = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"body",
	"center",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"html",
	"legend",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"ul",
]);
/** Opening the key closes an open element of these tags first (implied end tags), stopping at the scope tags. */
const IMPLIED_CLOSE: Record<string, { close: string[]; scope: string[] }> = {
	p: { close: ["p"], scope: ["div", "section", "article", "main", "body", "td", "th", "li", "blockquote"] },
	li: { close: ["li"], scope: ["ul", "ol"] },
	dt: { close: ["dt", "dd"], scope: ["dl"] },
	dd: { close: ["dt", "dd"], scope: ["dl"] },
	tr: { close: ["tr", "td", "th"], scope: ["table", "thead", "tbody", "tfoot"] },
	td: { close: ["td", "th"], scope: ["tr", "table"] },
	th: { close: ["td", "th"], scope: ["tr", "table"] },
	thead: { close: ["thead", "tbody", "tr", "td", "th"], scope: ["table"] },
	tbody: { close: ["thead", "tbody", "tr", "td", "th"], scope: ["table"] },
	tfoot: { close: ["thead", "tbody", "tr", "td", "th"], scope: ["table"] },
	option: { close: ["option"], scope: ["select"] },
};
/** Block openers that close an open `<p>` (a `<p>` cannot contain them). */
const CLOSES_P = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"div",
	"dl",
	"fieldset",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"main",
	"nav",
	"ol",
	"pre",
	"section",
	"table",
	"ul",
]);

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	shy: "",
	zwj: "",
	zwnj: "",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	sbquo: "‚",
	ldquo: "“",
	rdquo: "”",
	bdquo: "„",
	laquo: "«",
	raquo: "»",
	lsaquo: "‹",
	rsaquo: "›",
	bull: "•",
	middot: "·",
	times: "×",
	divide: "÷",
	deg: "°",
	plusmn: "±",
	micro: "µ",
	para: "¶",
	sect: "§",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	le: "≤",
	ge: "≥",
	ne: "≠",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	hearts: "♥",
	check: "✓",
};

/** Decode HTML character references (numeric and a common named subset; unknown names stay literal). */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, ref: string) => {
		if (ref[0] === "#") {
			const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
			return String.fromCodePoint(code);
		}
		const named = ENTITIES[ref] ?? ENTITIES[ref.toLowerCase()];
		return named ?? whole;
	});
}

/** Plain text of an HTML fragment (tags dropped, entities decoded, whitespace collapsed); for search snippets. */
export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of source.matchAll(ATTR_RE)) {
		const name = m[1]!.toLowerCase();
		if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
	}
	return attrs;
}

/** End of a tag starting at `start` (index of the closing `>`, quote-aware), or -1. */
function tagEnd(html: string, start: number): number {
	let quote = "";
	for (let i = start; i < html.length; i++) {
		const c = html[i]!;
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") {
			// Only quotes inside attribute values matter; one right after `=` (optionally spaced) opens a value.
			let j = i - 1;
			while (j > start && /\s/.test(html[j]!)) j--;
			if (html[j] === "=") quote = c;
		} else if (c === ">") return i;
	}
	return -1;
}

/** Parse HTML into a loose element tree rooted at a synthetic `#root`. */
function parse(html: string): Element {
	const root: Element = { tag: "#root", attrs: {}, children: [] };
	let current = root;
	const append = (node: Node) => {
		if (typeof node === "string") {
			const last = current.children.at(-1);
			if (typeof last === "string") current.children[current.children.length - 1] = last + node;
			else current.children.push(node);
		} else {
			node.parent = current;
			current.children.push(node);
		}
	};
	const open = (tag: string): Element | undefined => {
		for (let e: Element | undefined = current; e && e !== root; e = e.parent) if (e.tag === tag) return e;
		return undefined;
	};
	const closeTo = (el: Element) => {
		current = el.parent ?? root;
	};
	const impliedClose = (tag: string) => {
		const rule = IMPLIED_CLOSE[tag];
		if (rule) {
			for (let e: Element | undefined = current; e && e !== root; e = e.parent) {
				if (rule.scope.includes(e.tag)) break;
				if (rule.close.includes(e.tag)) {
					closeTo(e);
					break;
				}
			}
		}
		if (CLOSES_P.has(tag)) {
			const p = open("p");
			if (p) closeTo(p);
		}
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			append(decodeEntities(html.slice(i)));
			break;
		}
		if (lt > i) append(decodeEntities(html.slice(i, lt)));
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const next = html[lt + 1] ?? "";
		if (next === "!" || next === "?") {
			const end = html.indexOf(">", lt);
			i = end === -1 ? html.length : end + 1;
			continue;
		}
		const isEnd = next === "/";
		const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (isEnd ? 2 : 1), lt + (isEnd ? 2 : 1) + 64));
		if (!nameMatch) {
			append("<");
			i = lt + 1;
			continue;
		}
		const end = tagEnd(html, lt + 1);
		if (end === -1) {
			i = html.length;
			break;
		}
		const tag = nameMatch[0].toLowerCase();
		i = end + 1;
		if (isEnd) {
			if (tag === "br") append({ tag: "br", attrs: {}, children: [] });
			else if (tag === "p" && !open("p")) append({ tag: "p", attrs: {}, children: [] });
			else {
				const el = open(tag);
				if (el) closeTo(el);
			}
			continue;
		}
		const attrSource = html.slice(lt + 1 + tag.length, end).replace(/\/$/, "");
		impliedClose(tag);
		const el: Element = { tag, attrs: parseAttrs(attrSource), children: [] };
		append(el);
		if (VOID.has(tag)) continue;
		if (RAW_TEXT.has(tag)) {
			const close = new RegExp(`</${tag}\\s*>`, "i");
			const rest = html.slice(i);
			const m = close.exec(rest);
			const text = m ? rest.slice(0, m.index) : rest;
			if (tag === "title" || tag === "textarea" || tag === "xmp") el.children.push(decodeEntities(text));
			i = m ? i + m.index + m[0].length : html.length;
			continue;
		}
		if (html[end - 1] === "/" && tag.includes("-")) continue; // self-closed custom element
		current = el;
	}
	return root;
}

function find(node: Element, tag: string): Element | undefined {
	for (const child of node.children) {
		if (typeof child === "string") continue;
		if (child.tag === tag) return child;
		const found = find(child, tag);
		if (found) return found;
	}
	return undefined;
}

function textContent(node: Node): string {
	if (typeof node === "string") return node;
	return node.children.map(textContent).join("");
}

/** Hard line break marker inside inline text; survives whitespace collapsing. */
const BR = "\u0000";

function collapse(text: string): string {
	return text
		.replace(/[ \t\n\r\f\v]+/g, " ")
		.replace(/ ?\u0000 ?/g, BR)
		.trim()
		.replace(/\u0000/g, "\n");
}

type RenderContext = { base: URL | undefined };

/** ARIA landmark roles that mark page chrome rather than content. */
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "menu", "menubar", "dialog", "alertdialog"]);
/** Class tokens of page chrome and screen-reader-only text (exact token matches, so `post-header` survives). */
const CHROME_CLASSES = new Set([
	"navbox",
	"navbar",
	"sidebar",
	"breadcrumb",
	"breadcrumbs",
	"dropdown",
	"vector-dropdown",
	"mw-portlet",
	"noprint",
	"mw-editsection",
	"skip-link",
	"sr-only",
	"visually-hidden",
	"screen-reader-text",
	"cookie-banner",
]);

function hidden(el: Element): boolean {
	if ("hidden" in el.attrs || el.attrs["aria-hidden"] === "true" || CHROME_ROLES.has(el.attrs.role ?? "")) return true;
	if (/display\s*:\s*none/i.test(el.attrs.style ?? "")) return true;
	if (el.attrs.class && el.attrs.class.split(/\s+/).some((token) => CHROME_CLASSES.has(token.toLowerCase()))) return true;
	// A language switcher: a list whose every item links with `hreflang`.
	if (el.tag === "ul" || el.tag === "ol") {
		const items = el.children.filter((c): c is Element => typeof c !== "string" && c.tag === "li");
		return items.length >= 3 && items.every((li) => find(li, "a")?.attrs.hreflang !== undefined);
	}
	return false;
}

/** The page's main content: `<main>`/`role=main`, else a lone `<article>`, else undefined. */
function mainContent(root: Element): Element | undefined {
	const articles: Element[] = [];
	const walk = (el: Element): Element | undefined => {
		for (const child of el.children) {
			if (typeof child === "string" || SKIP.has(child.tag)) continue;
			if (child.tag === "main" || child.attrs.role === "main") return child;
			if (child.tag === "article") articles.push(child);
			const found = walk(child);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root) ?? (articles.length === 1 ? articles[0] : undefined);
}

function resolveHref(href: string, ctx: RenderContext): string | undefined {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#") || /^(javascript|data|vbscript):/i.test(trimmed)) return undefined;
	try {
		return ctx.base ? new URL(trimmed, ctx.base).href : new URL(trimmed).href;
	} catch {
		return trimmed;
	}
}

/** Render children as blocks separated by blank lines (`sep`), with consecutive inline content forming one block. */
function renderBlocks(children: readonly Node[], ctx: RenderContext, sep = "\n\n"): string {
	const blocks: string[] = [];
	let inline = "";
	const flush = () => {
		const text = collapse(inline);
		if (text) blocks.push(text);
		inline = "";
	};
	const walk = (nodes: readonly Node[]) => {
		for (const node of nodes) {
			if (typeof node === "string") {
				inline += node;
				continue;
			}
			if (SKIP.has(node.tag) || hidden(node)) continue;
			if (BLOCK.has(node.tag)) {
				flush();
				const block = renderBlock(node, ctx);
				if (block) blocks.push(block);
				continue;
			}
			switch (node.tag) {
				case "br":
					inline += BR;
					break;
				case "a": {
					const text = collapse(renderBlocks(node.children, ctx, " ").replace(/\n/g, " "));
					const href = resolveHref(node.attrs.href ?? "", ctx);
					if (!text) break;
					inline += href ? `[${text}](${href})` : text;
					break;
				}
				case "code":
				case "kbd":
				case "samp":
				case "tt": {
					const text = textContent(node).replace(/\s+/g, " ").trim();
					if (text) inline += text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
					break;
				}
				case "img": {
					const alt = (node.attrs.alt ?? "").trim();
					if (alt) inline += ` ${alt} `;
					break;
				}
				case "table":
				case "tr":
				case "thead":
				case "tbody":
				case "tfoot":
					flush();
					blocks.push(renderTable(node, ctx));
					break;
				case "td":
				case "th":
					inline += " ";
					walk(node.children);
					inline += " ";
					break;
				default:
					walk(node.children);
			}
		}
	};
	walk(children);
	flush();
	return blocks.filter((b) => b !== "").join(sep);
}

function prefixLines(text: string, first: string, rest: string): string {
	return text
		.split("\n")
		.map((line, i) => (i === 0 ? first : line === "" ? "" : rest) + line)
		.join("\n");
}

function renderBlock(el: Element, ctx: RenderContext): string {
	const tag = el.tag;
	if (/^h[1-6]$/.test(tag)) {
		const text = collapse(renderBlocks(el.children, ctx, " ").replace(/\n/g, " "));
		return text ? `${"#".repeat(Number(tag[1]))} ${text}` : "";
	}
	switch (tag) {
		case "hr":
			return "---";
		case "pre": {
			const code = find(el, "code");
			const cls = `${el.attrs.class ?? ""} ${code?.attrs.class ?? ""}`;
			const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
			const body = textContent(el).replace(/^\n/, "").replace(/\s+$/, "");
			if (!body) return "";
			const fence = body.includes("```") ? "````" : "```";
			return `${fence}${lang}\n${body}\n${fence}`;
		}
		case "ul":
		case "ol": {
			const start = Number.parseInt(el.attrs.start ?? "1", 10);
			let n = Number.isFinite(start) ? start : 1;
			const items: string[] = [];
			for (const child of el.children) {
				if (typeof child === "string") {
					const text = collapse(child);
					if (text) items.push(text);
					continue;
				}
				if (SKIP.has(child.tag) || hidden(child)) continue;
				if (child.tag !== "li") {
					const text = renderBlocks([child], ctx);
					if (text) items.push(text);
					continue;
				}
				const marker = tag === "ol" ? `${n++}. ` : "- ";
				const body = renderBlocks(child.children, ctx, "\n");
				items.push(prefixLines(body, marker, " ".repeat(marker.length)));
			}
			return items.join("\n");
		}
		case "li":
			return prefixLines(renderBlocks(el.children, ctx, "\n"), "- ", "  ");
		case "blockquote": {
			const body = renderBlocks(el.children, ctx);
			return body ? body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : "";
		}
		case "table":
			return renderTable(el, ctx);
		case "dd":
			return prefixLines(renderBlocks(el.children, ctx, "\n"), ": ", "  ");
		default:
			return renderBlocks(el.children, ctx);
	}
}

/** Rows of a table (not descending into nested tables), each as `| a | b |`; a header separator after a `th` row. */
function renderTable(table: Element, ctx: RenderContext): string {
	const rows: Element[] = [];
	const collect = (el: Element) => {
		for (const child of el.children) {
			if (typeof child === "string" || SKIP.has(child.tag)) continue;
			if (child.tag === "tr") rows.push(child);
			else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") collect(child);
		}
	};
	if (table.tag === "tr") rows.push(table);
	else collect(table);
	const lines: string[] = [];
	const caption = table.children.find((c): c is Element => typeof c !== "string" && c.tag === "caption");
	if (caption) {
		const text = collapse(renderBlocks(caption.children, ctx, " "));
		if (text) lines.push(text);
	}
	rows.forEach((row, index) => {
		const cells = row.children.filter((c): c is Element => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
		if (cells.length === 0) return;
		const texts = cells.map((c) => collapse(renderBlocks(c.children, ctx, " ").replace(/\n/g, " ")).replace(/\|/g, "\\|"));
		if (texts.every((t) => t === "")) return;
		lines.push(`| ${texts.join(" | ")} |`);
		if (index === 0 && cells.every((c) => c.tag === "th")) lines.push(`|${" --- |".repeat(cells.length)}`);
	});
	return lines.join("\n");
}

/** Convert an HTML document to readable text; `baseUrl` resolves relative links. */
export function htmlToText(html: string, baseUrl?: string): { title: string; text: string } {
	const root = parse(html);
	const titleEl = find(root, "title");
	const title = titleEl ? textContent(titleEl).replace(/\s+/g, " ").trim() : "";
	let base: URL | undefined;
	try {
		const baseHref = find(root, "base")?.attrs.href;
		base = baseUrl ? new URL(baseHref ?? "", baseUrl) : baseHref ? new URL(baseHref) : undefined;
	} catch {
		base = baseUrl ? new URL(baseUrl) : undefined;
	}
	const body = find(root, "body") ?? root;
	const content = mainContent(body);
	// A `<main>` with almost no text (an app shell) is no better than the body.
	const scope = content && textContent(content).trim().length >= 200 ? content : body;
	const text = renderBlocks(scope === body ? body.children : [scope], { base })
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text };
}
