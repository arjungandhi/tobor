import { isDeepStrictEqual } from "node:util";
import { type Document, isMap, isScalar, type Node, type Pair, parseDocument, stringify, type YAMLMap } from "yaml";
import type { ApprovalMode, SessionMode } from "../api/types.js";

// The node's `.tobor/config.yml` as the settings screen and the New-session flow see it. Edits splice the source text
// so comments, alignment, blank lines, flow style and keys the TUI does not know stay byte-identical; an edit the
// splice cannot express (flow collections, odd layouts) falls back to the `yaml` Document API, which keeps comments
// and unknown keys but normalizes spacing.

/** A dotted key path into config.yml, as an array. */
export type ConfigPath = readonly string[];

/** Parse config.yml text; a syntax error throws. */
export function parseNodeConfig(text: string): Document {
	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new Error(`config.yml: ${doc.errors[0]!.message}`);
	return doc;
}

/** A scalar at `path` as a string, or undefined when absent. */
export function getField(doc: Document, path: ConfigPath): string | undefined {
	const value: unknown = doc.getIn(path);
	if (value === undefined || value === null || typeof value === "object") return undefined;
	return String(value);
}

/** `agents.model_overrides`: agent name → `provider/modelId`. */
export function modelOverrides(doc: Document): Record<string, string> {
	const node = doc.getIn(["agents", "model_overrides"], true);
	if (!isMap(node)) return {};
	const out: Record<string, string> = {};
	for (const pair of node.items) {
		const agent = isScalar(pair.key) ? pair.key.value : pair.key;
		const model = isScalar(pair.value) ? pair.value.value : pair.value;
		if (typeof agent === "string" && typeof model === "string") out[agent] = model;
	}
	return out;
}

/** Defaults a new session starts with (missing keys fall back to the node's built-in defaults). */
export type SessionDefaults = { model?: string; approval_mode: ApprovalMode; mode: SessionMode };

/** `defaults.{model,approval_mode,mode}` of a parsed config.yml. */
export function sessionDefaults(doc: Document): SessionDefaults {
	const model = getField(doc, ["defaults", "model"]);
	return {
		...(model ? { model } : {}),
		approval_mode: getField(doc, ["defaults", "approval_mode"]) === "ask" ? "ask" : "auto",
		mode: getField(doc, ["defaults", "mode"]) === "solo" ? "solo" : "director",
	};
}

/** Set (or with `undefined`, delete) the scalar at `path` in config.yml text; a delete prunes maps it leaves empty. */
export function editConfig(text: string, path: ConfigPath, value: string | number | undefined): string {
	const doc = parseNodeConfig(text);
	const expected = parseNodeConfig(text);
	const prunedPath = value === undefined ? pruneTarget(expected, path) : path;
	if (value === undefined) {
		if (!expected.hasIn(path)) return text;
		expected.deleteIn(prunedPath);
	} else {
		expected.setIn(path, value);
	}
	const spliced = value === undefined ? spliceDelete(text, doc, prunedPath) : spliceSet(text, doc, path, value);
	if (spliced !== undefined && isDeepStrictEqual(parseDocument(spliced).toJS(), expected.toJS())) return spliced;
	return expected.toString();
}

/** The shortest prefix of `path` whose deletion removes `path` and every map that would be left empty. */
function pruneTarget(doc: Document, path: ConfigPath): ConfigPath {
	let target = path;
	while (target.length > 1) {
		const parent = doc.getIn(target.slice(0, -1), true);
		if (!isMap(parent) || parent.items.length !== 1) break;
		target = target.slice(0, -1);
	}
	return target;
}

/** YAML source of one scalar value, quoted only when needed. */
function scalarSource(value: string | number): string {
	return stringify(value).trimEnd();
}

/** Offset of the start of the line containing `offset`. */
function lineStart(text: string, offset: number): number {
	return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just past the newline ending the line containing `offset` (text end when there is none). */
function lineEnd(text: string, offset: number): number {
	const nl = text.indexOf("\n", offset);
	return nl < 0 ? text.length : nl + 1;
}

/** The pair at `path` when every map on the way is a block map. */
function blockPair(doc: Document, path: ConfigPath): Pair<Node, Node> | undefined {
	let map: unknown = doc.contents;
	for (const [i, key] of path.entries()) {
		if (!isMap(map) || map.flow) return undefined;
		const pair = (map as YAMLMap<Node, Node>).items.find((p) => isScalar(p.key) && String(p.key.value) === key);
		if (!pair) return undefined;
		if (i === path.length - 1) return pair;
		map = pair.value;
	}
	return undefined;
}

function spliceSet(text: string, doc: Document, path: ConfigPath, value: string | number): string | undefined {
	const found = blockPair(doc, path);
	if (found) {
		const node = found.value;
		if (!isScalar(node) || !node.range) return undefined;
		const [start, end] = node.range;
		const source = scalarSource(value);
		// Keep a trailing comment in its column.
		const after = text.slice(end);
		const gap = /^( +)#/.exec(after)?.[1]?.length;
		const pad = gap === undefined ? "" : " ".repeat(Math.max(1, gap + (end - start) - source.length));
		return text.slice(0, start) + source + (gap === undefined ? after : pad + after.slice(gap));
	}
	return spliceAdd(text, doc, path, value);
}

/** Append the missing tail of `path` as new block-map lines after the last item of its deepest existing map. */
function spliceAdd(text: string, doc: Document, path: ConfigPath, value: string | number): string | undefined {
	let map: unknown = doc.contents;
	let depth = 0;
	for (; depth < path.length; depth++) {
		if (!isMap(map) || map.flow) return undefined;
		const pair = (map as YAMLMap<Node, Node>).items.find((p) => isScalar(p.key) && String(p.key.value) === path[depth]);
		if (!pair) break;
		map = pair.value;
	}
	if (!isMap(map) || map.flow || map.items.length === 0) return undefined;
	const items = (map as YAMLMap<Node, Node>).items;
	const firstKey = items[0]!.key;
	const lastValue = items.at(-1)!.value ?? items.at(-1)!.key;
	if (!firstKey?.range || !lastValue?.range) return undefined;
	const indent = firstKey.range[0] - lineStart(text, firstKey.range[0]);
	if (text.slice(lineStart(text, firstKey.range[0]), firstKey.range[0]).trim() !== "") return undefined;
	const at = lineEnd(text, lastValue.range[2] - 1);
	const lines = path.slice(depth).map((key, i, rest) => `${" ".repeat(indent + 2 * i)}${key}:${i === rest.length - 1 ? ` ${scalarSource(value)}` : ""}\n`);
	const head = text.slice(0, at);
	return `${head}${head.endsWith("\n") || head === "" ? "" : "\n"}${lines.join("")}${text.slice(at)}`;
}

/** Remove the lines of the pair at `path` (a scalar or a block map of scalars). */
function spliceDelete(text: string, doc: Document, path: ConfigPath): string | undefined {
	const pair = blockPair(doc, path);
	if (!pair) return undefined;
	const key = pair.key;
	const end = pair.value?.range?.[2] ?? key?.range?.[2];
	if (!key?.range || end === undefined) return undefined;
	const start = lineStart(text, key.range[0]);
	if (text.slice(start, key.range[0]).trim() !== "") return undefined;
	return text.slice(0, start) + text.slice(lineEnd(text, end - 1));
}
