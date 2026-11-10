import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { join } from "node:path";
import type { FileToolDeps } from "./filetools.js";
import { decodeLossy, decodeText, ioFailure, isBinary, splitText } from "./hashline/lineio.js";
import type { ErrorKind } from "./hashline/parse.js";
import { displayPath, header, isUnder, mergeRanges, renderRows } from "./hashline/render.js";
import { hashFile } from "./hashline/tag.js";

/** Open-ended reads stop after this many lines. */
export const READ_LIMIT = 300;

/** One parsed selector range. */
export type Range = { kind: "from"; start: number } | { kind: "span"; start: number; end: number } | { kind: "tail"; count: number };

/** A `read` path split from its selector. */
export interface Selector {
	path: string;
	raw: boolean;
	ranges: Range[];
}

const ZERO = "Line selector 0 is invalid; lines are 1-indexed. Use :1.";
const TOKEN = String.raw`\d+(?:-\d*|\+\d+)?|-\d+`;
const SELECTOR = new RegExp(`^(.*?):(raw|(?:${TOKEN})(?:,(?:${TOKEN}))*)(:raw)?$`, "s");

/** Split `path[:selector][:raw]`; a suffix that is not a valid selector stays part of the path. */
export function parseSelector(arg: string): { ok: true; selector: Selector } | { ok: false; message: string } {
	const m = SELECTOR.exec(arg);
	if (!m || m[1] === "") return { ok: true, selector: { path: arg, raw: false, ranges: [] } };
	const spec = m[2]!;
	if (spec === "raw") return { ok: true, selector: { path: m[1]!, raw: true, ranges: [] } };
	const ranges: Range[] = [];
	for (const token of spec.split(",")) {
		let r: RegExpExecArray | null;
		if ((r = /^(\d+)-?$/.exec(token))) {
			const start = Number(r[1]);
			if (start === 0) return { ok: false, message: ZERO };
			ranges.push({ kind: "from", start });
		} else if ((r = /^(\d+)-(\d+)$/.exec(token))) {
			const start = Number(r[1]);
			const end = Number(r[2]);
			if (start === 0) return { ok: false, message: ZERO };
			if (end < start) return { ok: false, message: `Invalid range :${token}; the end must not be before the start.` };
			ranges.push({ kind: "span", start, end });
		} else if ((r = /^(\d+)\+(\d+)$/.exec(token))) {
			const start = Number(r[1]);
			const count = Number(r[2]);
			if (start === 0) return { ok: false, message: ZERO };
			if (count < 1) return { ok: false, message: `Invalid range :${token}; the count must be at least 1.` };
			ranges.push({ kind: "span", start, end: start + count - 1 });
		} else {
			const count = Number(token.slice(1));
			if (count < 1) return { ok: false, message: `Invalid range :${token}; the count must be at least 1.` };
			ranges.push({ kind: "tail", count });
		}
	}
	return { ok: true, selector: { path: m[1]!, raw: m[3] !== undefined, ranges } };
}

/** Which lines a selector shows: display ranges (context included), and the next line when an open range was capped. */
export type Plan = { kind: "lines"; ranges: [number, number][]; next?: number } | { kind: "out_of_bounds" };

/** Resolve ranges against a file of `L` lines; context applies only to a single bounded range unless `raw`. */
export function planRanges(ranges: readonly Range[], L: number, raw: boolean): Plan {
	const list: readonly Range[] = ranges.length > 0 ? ranges : [{ kind: "from", start: 1 }];
	const single = list.length === 1 ? list[0]! : undefined;
	if (single?.kind === "span" && !raw) {
		if (single.start > L) return { kind: "out_of_bounds" };
		return { kind: "lines", ranges: [[Math.max(1, single.start - 1), Math.min(L, single.end + 3)]] };
	}
	const out: [number, number][] = [];
	let next: number | undefined;
	for (const r of list) {
		if (r.kind === "tail") {
			if (L > 0) out.push([Math.max(1, L - r.count + 1), L]);
		} else if (r.start <= L) {
			const end = r.kind === "span" ? Math.min(L, r.end) : Math.min(L, r.start + READ_LIMIT - 1);
			if (r.kind === "from" && end < L) next = Math.max(next ?? 0, end + 1);
			out.push([r.start, end]);
		}
	}
	if (out.length === 0) return { kind: "out_of_bounds" };
	const merged = mergeRanges(out);
	const last = merged[merged.length - 1]![1];
	return next !== undefined && next > last ? { kind: "lines", ranges: merged, next } : { kind: "lines", ranges: merged };
}

const outOfBounds = (L: number) => (L === 0 ? "File has 0 lines" : `File has ${L} lines; try :1 or :${L}`);

function isImage(bytes: Uint8Array): boolean {
	const at = (i: number, s: string) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
	return (
		(bytes[0] === 0x89 && at(1, "PNG")) ||
		(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
		at(0, "GIF8") ||
		(at(0, "RIFF") && at(8, "WEBP"))
	);
}

type ReadResult = ToolExecutionResult;

const errorResult = (kind: ErrorKind, text: string): ReadResult => ({
	output: [{ type: "text", text }],
	isError: true,
	details: { errorKind: kind },
});
const textResult = (text: string): ReadResult => ({ output: [{ type: "text", text }] });

async function denied(env: ExecutionEnv, home: string, abs: string, ctx: Context): Promise<boolean> {
	const canonHome = await env.canonicalPath(home, ctx);
	const homes = canonHome.ok && canonHome.value !== home ? [home, canonHome.value] : [home];
	const canon = await env.canonicalPath(abs, ctx);
	const targets = canon.ok && canon.value !== abs ? [abs, canon.value] : [abs];
	return targets.some((t) => homes.some((h) => isUnder(t, h) && !isUnder(t, join(h, ".tobor"))));
}

/** The hashline `read` tool. */
export function createHashlineReadTool(deps: FileToolDeps) {
	const imageReader = createReadTool();
	return defineTool({
		name: "read",
		description: `Read a file or list a directory. Output starts with [path#TAG], then one N:TEXT row per line; use the tag and line numbers with \`edit\`. Selectors are a path suffix: :N or :N- (from N), :A-B, :A+C (C lines from A), :-N (last N), comma lists (:1-5,40-50), and :raw (verbatim text, no header or numbers; combine as :A-B:raw). Open-ended reads stop after ${READ_LIMIT} lines. Images are returned as attachments.`,
		parameters: obj({ path: str({ description: "File or directory path, with an optional :selector suffix" }) }),
		replay: "unsafe",
		async execute({ path: arg }, api, ctx): Promise<ReadResult> {
			const env = api.env;
			if (!env) throw new Error("No execution environment is configured");
			const parsed = parseSelector(arg);
			if (!parsed.ok) return errorResult("parse", parsed.message);
			const { path, raw, ranges } = parsed.selector;
			const resolved = await env.absolutePath(path, ctx);
			if (!resolved.ok) return errorResult("io", resolved.error.message);
			const abs = resolved.value;
			const display = displayPath(path, abs, env.cwd);
			if (await denied(env, deps.home, abs, ctx)) {
				return errorResult("io", `Access denied: ${display} is inside $TOBOR_HOME; only $TOBOR_HOME/.tobor/ is readable.`);
			}

			let info = await env.fileInfo(abs, ctx);
			if (info.ok && info.value.kind === "symlink") {
				const target = await env.canonicalPath(abs, ctx);
				info = target.ok ? await env.fileInfo(target.value, ctx) : target;
			}
			if (!info.ok) {
				const failure = ioFailure(info.error);
				return errorResult(failure.kind, failure.kind === "file_not_found" ? `File not found: ${display}` : `${display}: ${failure.message}`);
			}
			if (info.value.kind === "directory") {
				const listed = await env.listDir(abs, ctx);
				if (!listed.ok) return errorResult("io", `${display}: ${listed.error.message}`);
				const names = listed.value.map((e) => (e.kind === "directory" ? `${e.name}/` : e.name)).sort();
				return textResult(names.length > 0 ? names.join("\n") : "(empty directory)");
			}

			const bytes = await env.readBinaryFile(abs, ctx);
			if (!bytes.ok) {
				const failure = ioFailure(bytes.error);
				return errorResult(failure.kind, `${display}: ${failure.message}`);
			}
			if (isImage(bytes.value)) return imageReader.execute({ path: abs }, api, ctx) as Promise<ReadResult>;

			if (raw) {
				const text = decodeLossy(bytes.value);
				if (ranges.length === 0) return textResult(text);
				const file = splitText(text);
				const plan = planRanges(ranges, file.lines.length, true);
				if (plan.kind === "out_of_bounds") return textResult(outOfBounds(file.lines.length));
				let out = "";
				for (const [a, b] of plan.ranges) for (let n = a; n <= b; n++) out += file.lines[n - 1]! + file.terms[n - 1]!;
				return textResult(out);
			}
			if (isBinary(bytes.value)) {
				return textResult(`${display} is a binary file (${bytes.value.length} bytes); not shown. Use ${display}:raw to read it as text.`);
			}
			const file = decodeText(bytes.value);
			if (!file) return errorResult("invalid_utf8", `${display} is not valid UTF-8; use ${display}:raw to read it lossily.`);

			const L = file.lines.length;
			const hash = hashFile(file);
			const conv = deps.store.conversation(api.conversationId);
			const head = header(display, hash.tag);
			if (L === 0 && ranges.length === 0) {
				conv.record(abs, hash, []);
				return textResult(`${head}\n(empty file)`);
			}
			const plan = planRanges(ranges, L, false);
			if (plan.kind === "out_of_bounds") {
				conv.record(abs, hash, []);
				return textResult(`${head}\n${outOfBounds(L)}`);
			}
			const { rows, seen } = renderRows(file.lines, plan.ranges);
			conv.record(abs, hash, seen);
			const more = plan.next !== undefined ? `\n[… more lines; continue with ${display}:${plan.next}]` : "";
			return textResult(`${head}\n${rows.join("\n")}${more}`);
		},
	});
}
