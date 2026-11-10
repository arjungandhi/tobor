import type { Context } from "@earendil-works/chord/context";
import { defineTool, type JsonObject, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { obj, str } from "@earendil-works/pi-schema";
import type { FileToolDeps } from "./filetools.js";
import { anchoredLines, type ApplyResult, applyPuts, checkPuts, previewRanges, type Put, remapSeen } from "./hashline/apply.js";
import { atomicWrite, encodeText, readText, type TextFile } from "./hashline/lineio.js";
import { type EditError, type ErrorKind, parsePatch, type Section } from "./hashline/parse.js";
import { displayPath, formatRange, header, mergeRanges, renderRows } from "./hashline/render.js";
import type { ConversationSnapshots, Seen } from "./hashline/snapshots.js";
import { type FileHash, hashFile, isTag } from "./hashline/tag.js";

const DESCRIPTION = `Edit files by line number, anchored to a tag from \`read\`. Input is one or more sections:

[PATH#TAG]
PUT N.=M:      replace original lines N..M with the + rows below
PUT <N:        insert before line N (PUT <1: = file head)
PUT >N:        insert after line N
PUT >$:        append at end of file
REM            delete the file
MV dest        write the result to dest (quote paths with spaces), delete PATH

Body rows start with "+" ("+" alone = blank line, "++x" = "+x"). Numbers always refer to the tagged version, never to earlier hunks. You may only anchor on lines you have read under that tag. On success the reply gives the new tag; use it for the next edit.`;

const editSchema = obj({
	input: str({ description: "The patch: [PATH#TAG] sections with PUT/REM/MV ops" }),
});

type EditResult = ToolExecutionResult<JsonObject>;

/** A file's merged sections, validated and computed. */
interface Plan {
	given: string;
	abs: string;
	display: string;
	tag: string | undefined;
	line: number;
	puts: Put[];
	rem: boolean;
	mv?: { given: string; abs: string; display: string };
	file?: TextFile;
	hash?: FileHash;
	seen?: Seen;
	result?: ApplyResult;
	noop?: boolean;
}

const errorResult = (kind: ErrorKind, text: string): EditResult => ({
	output: [{ type: "text", text }],
	isError: true,
	details: { errorKind: kind },
});

const copiedPrefixes = (body: readonly string[]) => body.length > 0 && body.every((r) => /^\d+:/.test(r));

/** Group sections by resolved path, merging same-path ops; `parse` on conflicting tags or ops. */
async function plan(
	env: ExecutionEnv,
	sections: readonly Section[],
	ctx: Context,
): Promise<{ ok: true; plans: Plan[] } | { ok: false; error: EditError }> {
	const byPath = new Map<string, Plan>();
	for (const s of sections) {
		const abs = await env.absolutePath(s.path, ctx);
		if (!abs.ok) return { ok: false, error: { kind: "io", message: abs.error.message } };
		let p = byPath.get(abs.value);
		if (!p) {
			p = { given: s.path, abs: abs.value, display: displayPath(s.path, abs.value, env.cwd), tag: s.tag, line: s.line, puts: [], rem: false };
			byPath.set(abs.value, p);
		} else if (p.tag !== s.tag) {
			return { ok: false, error: { kind: "parse", message: `line ${s.line}: ${s.path} appears with tags #${p.tag} and #${s.tag}; use one tag per file` } };
		}
		for (const op of s.ops) {
			if (op.kind === "put") p.puts.push(op);
			else if (p.rem || p.mv) {
				return { ok: false, error: { kind: "parse", message: `line ${op.line}: at most one REM or MV per file` } };
			} else if (op.kind === "rem") p.rem = true;
			else {
				const dest = await env.absolutePath(op.dest, ctx);
				if (!dest.ok) return { ok: false, error: { kind: "parse", message: `line ${op.line}: bad MV destination: ${dest.error.message}` } };
				p.mv = { given: op.dest, abs: dest.value, display: displayPath(op.dest, dest.value, env.cwd) };
			}
		}
		if (p.rem && p.puts.length > 0) {
			return { ok: false, error: { kind: "parse", message: `line ${s.line}: REM cannot be combined with PUT for ${s.path}` } };
		}
	}
	const plans = [...byPath.values()];
	for (const p of plans) {
		if (!p.mv) continue;
		if (p.mv.abs === p.abs || byPath.has(p.mv.abs) || plans.some((o) => o !== p && o.mv?.abs === p.mv!.abs)) {
			return { ok: false, error: { kind: "parse", message: `bad MV destination ${p.mv.given}: it is also a source or destination in this edit` } };
		}
		const exists = await env.exists(p.mv.abs, ctx);
		if (!exists.ok || exists.value) {
			return { ok: false, error: { kind: "parse", message: `bad MV destination ${p.mv.given}: it already exists` } };
		}
	}
	return { ok: true, plans };
}

/** Validate one file's plan against the current file and snapshots; fills `file`, `hash`, `seen`, `result`, `noop`. */
async function validate(env: ExecutionEnv, conv: ConversationSnapshots, p: Plan, ctx: Context): Promise<EditError | undefined> {
	const read = await readText(env, p.abs, ctx);
	if (!read.ok) return { kind: read.error.kind, message: `${p.display}: ${read.error.message}` };
	const file = read.file;
	const hash = hashFile(file);
	const current = header(p.display, hash.tag);
	if (p.tag === undefined || !isTag(p.tag)) {
		const what = p.tag === undefined ? "has no #TAG" : `has placeholder tag #${p.tag}`;
		return { kind: "missing_tag", message: `${p.display} ${what}. Current ${current}` };
	}
	const tag = p.tag.toUpperCase();
	const check = conv.check(p.abs, tag, hash);
	if (!check.ok) {
		if (check.kind === "unknown_tag") return { kind: "unknown_tag", message: `Unknown tag #${tag} for ${p.display}. Current ${current}` };
		if (check.kind === "other_file_tag") {
			return { kind: "other_file_tag", message: `Tag #${tag} belongs to ${displayPath(check.otherPath, check.otherPath, env.cwd)}, not ${p.display}. Current ${current}` };
		}
		const L = file.lines.length;
		const ranges = mergeRanges(
			p.puts.flatMap((put) => {
				const a = anchoredLines(put.target, Number.POSITIVE_INFINITY);
				if (!a) return [];
				const lo = Math.max(1, a[0] - 3);
				const hi = Math.min(L, a[1] + 3);
				return lo <= hi ? [[lo, hi] as const] : [];
			}),
		);
		const { rows, seen } = renderRows(file.lines, ranges);
		conv.record(p.abs, hash, seen);
		const body = rows.length > 0 ? `\n${rows.join("\n")}` : "";
		return { kind: "stale_tag", message: `${p.display} changed since #${tag}; re-anchor on the current version:\n${current}${body}` };
	}
	const bad = checkPuts(p.puts, file.lines.length);
	if (bad) return { kind: bad.kind, message: `${p.display}: ${bad.message}` };
	if (check.seen !== "all") {
		const seen = check.seen;
		const missing: number[] = [];
		for (const put of p.puts) {
			const a = anchoredLines(put.target, file.lines.length);
			if (a) for (let n = a[0]; n <= a[1]; n++) if (!seen.has(n)) missing.push(n);
		}
		if (missing.length > 0) {
			const ranges = mergeRanges(missing.map((n) => [n, n] as const)).map(formatRange);
			return {
				kind: "unseen_lines",
				message: `${p.display}: lines ${ranges.join(", ")} have not been read under #${tag}; read ${p.display}:${ranges.join(",")} first`,
			};
		}
	}
	p.file = file;
	p.hash = hash;
	p.seen = check.seen;
	p.result = applyPuts(file, p.puts);
	p.noop = !p.rem && !p.mv && encodeText(p.result.file) === encodeText(file);
	return undefined;
}

/** The hashline `edit` tool. */
export function createHashlineEditTool(deps: FileToolDeps) {
	return defineTool({
		name: "edit",
		description: DESCRIPTION,
		parameters: editSchema,
		replay: "unsafe",
		async execute({ input }, api, ctx): Promise<EditResult> {
			const env = api.env;
			if (!env) throw new Error("No execution environment is configured");
			const conv = deps.store.conversation(api.conversationId);
			const parsed = parsePatch(input);
			if (!parsed.ok) return errorResult(parsed.error.kind, parsed.error.message);
			const planned = await plan(env, parsed.sections, ctx);
			if (!planned.ok) return errorResult(planned.error.kind, planned.error.message);
			const plans = planned.plans;

			const errors: EditError[] = [];
			for (const p of plans) {
				const error = await validate(env, conv, p, ctx);
				if (error) errors.push(error);
			}
			if (errors.length > 0) return errorResult(errors[0]!.kind, errors.map((e) => e.message).join("\n\n"));

			const noops = plans.filter((p) => p.noop);
			if (noops.length > 0) {
				const count = conv.noteNoop(input.trim());
				const names = noops.map((p) => header(p.display, p.hash!.tag)).join(", ");
				if (plans.length > 1) {
					return errorResult("no_change", `No change: ${names} would be byte-identical; the whole edit was rejected and nothing was written.`);
				}
				if (count >= 3) {
					return errorResult("no_change", `No change, for the third time in a row with the same edit: ${names}. Re-read the file and rethink the edit.`);
				}
				const message = `No change: the result is identical to ${names}; nothing was written.`;
				return {
					output: [{ type: "text", text: message }],
					diagnostics: [{ severity: "warn", code: "no_change", message }],
					details: { noChange: true },
				};
			}
			conv.resetNoop();

			const warnings: string[] = [];
			for (const p of plans) {
				for (const put of p.puts) {
					if (copiedPrefixes(put.body)) warnings.push(`${p.display} line ${put.line}: body rows start with N: prefixes; + rows are written verbatim`);
				}
			}
			const written: string[] = [];
			const writeFailed = (what: string, message: string) => {
				for (const p of plans) {
					conv.invalidate(p.abs);
					if (p.mv) conv.invalidate(p.mv.abs);
				}
				const done = written.length > 0 ? ` Already written: ${written.join(", ")}.` : " Nothing was written.";
				return errorResult("write_failed", `Failed to write ${what}: ${message}.${done}`);
			};
			for (const p of plans) {
				if (p.rem) continue;
				const target = p.mv?.abs ?? p.abs;
				const wrote = await atomicWrite(env, target, encodeText(p.result!.file), p.abs, ctx);
				if (!wrote.ok) return writeFailed(p.mv?.display ?? p.display, wrote.message);
				if (wrote.warning) warnings.push(wrote.warning);
				written.push(p.mv?.display ?? p.display);
			}
			for (const p of plans) {
				if (!p.rem && !p.mv) continue;
				const removed = await env.remove(p.abs, undefined, ctx);
				if (!removed.ok) return writeFailed(`(delete) ${p.display}`, removed.error.message);
				written.push(`(deleted) ${p.display}`);
			}

			const blocks: string[] = [];
			const diffs: string[] = [];
			let firstChangedLine: number | undefined;
			for (const p of plans) {
				conv.invalidate(p.abs);
				if (p.rem) {
					blocks.push(`Deleted ${p.display}`);
					continue;
				}
				const result = p.result!;
				const target = p.mv ?? p;
				conv.invalidate(target.abs);
				const newHash = hashFile(result.file);
				const { rows, seen } = renderRows(result.file.lines, previewRanges(result.changed, result.file.lines.length));
				const carried = remapSeen(p.seen!, result.map);
				conv.record(target.abs, newHash, carried === "all" ? "all" : [...carried, ...seen]);
				const lines = [...(p.mv ? [`Moved ${p.display} to ${p.mv.display}`] : []), header(target.display, newHash.tag), ...rows];
				blocks.push(lines.join("\n"));
				if (p.puts.length > 0) {
					diffs.push(`--- ${p.display}\n+++ ${target.display}\n${result.hunks}`);
					firstChangedLine ??= result.firstChangedLine;
				}
			}
			const warn = warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
			const details: JsonObject = { diff: diffs.join("") };
			if (firstChangedLine !== undefined) details.firstChangedLine = firstChangedLine;
			return { output: [{ type: "text", text: blocks.join("\n\n") + warn }], details };
		},
	});
}
