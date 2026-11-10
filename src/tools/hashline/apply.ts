import { dominantTerm, type Term, type TextFile } from "./lineio.js";
import type { EditError, Op, Target } from "./parse.js";
import { mergeRanges } from "./render.js";
import type { Seen } from "./snapshots.js";

/** A `PUT` op. */
export type Put = Extract<Op, { kind: "put" }>;

/** The edited file, how old lines moved, and what changed. */
export interface ApplyResult {
	file: TextFile;
	/** `map[k]` = the new 1-based number of old line `k + 1`, or undefined when it was replaced. */
	map: (number | undefined)[];
	/** New-file line ranges each `PUT` produced, 1-based inclusive, in file order. */
	changed: [number, number][];
	/** Unified-diff hunks (no file headers). */
	hunks: string;
	firstChangedLine: number;
}

/** Gap (insert point: before old line `gap + 1`) and last removed old line (`= gap` when nothing is removed). */
function span(target: Target, lineCount: number): { gap: number; end: number } {
	switch (target.kind) {
		case "replace":
			return { gap: target.start - 1, end: target.end };
		case "before":
			return { gap: target.line - 1, end: target.line - 1 };
		case "after":
			return { gap: target.line, end: target.line };
		case "append":
			return { gap: lineCount, end: lineCount };
	}
}

function describe(target: Target): string {
	switch (target.kind) {
		case "replace":
			return `PUT ${target.start}.=${target.end}`;
		case "before":
			return `PUT <${target.line}`;
		case "after":
			return `PUT >${target.line}`;
		case "append":
			return "PUT >$";
	}
}

/** Lines a `PUT` anchors on (replaced lines, or the insert anchor); none for `>$` and for `<1` on an empty file. */
export function anchoredLines(target: Target, lineCount: number): [number, number] | undefined {
	switch (target.kind) {
		case "replace":
			return [target.start, target.end];
		case "before":
		case "after":
			return target.line <= lineCount ? [target.line, target.line] : undefined;
		case "append":
			return undefined;
	}
}

/** Range check (`out_of_range`) then overlap check (`parse`) of a file's puts against its line count. */
export function checkPuts(puts: readonly Put[], lineCount: number): EditError | undefined {
	const inFile = (n: number) => n >= 1 && n <= lineCount;
	for (const p of puts) {
		const t = p.target;
		const ok =
			t.kind === "replace"
				? inFile(t.start) && inFile(t.end) && t.end >= t.start
				: t.kind === "before"
					? inFile(t.line) || (t.line === 1 && lineCount === 0)
					: t.kind === "after"
						? inFile(t.line)
						: true;
		if (!ok) {
			return { kind: "out_of_range", message: `line ${p.line}: ${describe(t)} is out of range; the file has ${lineCount} lines` };
		}
	}
	const replaces = puts.filter((p) => p.target.kind === "replace").sort((a, b) => span(a.target, lineCount).gap - span(b.target, lineCount).gap);
	for (let i = 1; i < replaces.length; i++) {
		const prev = replaces[i - 1]!;
		const cur = replaces[i]!;
		if (span(cur.target, lineCount).gap < span(prev.target, lineCount).end) {
			return { kind: "parse", message: `line ${cur.line}: ${describe(cur.target)} overlaps ${describe(prev.target)} (line ${prev.line})` };
		}
	}
	for (const ins of puts) {
		if (ins.target.kind === "replace") continue;
		const g = span(ins.target, lineCount).gap;
		for (const r of replaces) {
			const { gap, end } = span(r.target, lineCount);
			if (g > gap && g < end) {
				return { kind: "parse", message: `line ${ins.line}: ${describe(ins.target)} falls inside ${describe(r.target)} (line ${r.line})` };
			}
		}
	}
	return undefined;
}

/** Apply checked puts; every number refers to `file` as given. New lines take the dominant terminator. */
export function applyPuts(file: TextFile, puts: readonly Put[]): ApplyResult {
	const lineCount = file.lines.length;
	const dom = dominantTerm(file);
	const finalNewline = lineCount === 0 || file.terms[lineCount - 1] !== "";
	const placed = puts
		.map((put, order) => ({ put, order, ...span(put.target, lineCount), replace: put.target.kind === "replace" }))
		.sort((a, b) => a.gap - b.gap || Number(a.replace) - Number(b.replace) || a.order - b.order);

	const lines: string[] = [];
	const terms: Term[] = [];
	const map: (number | undefined)[] = new Array(lineCount).fill(undefined);
	const changed: [number, number][] = [];
	const hunks: string[] = [];
	let cursor = 0;
	const copy = (upto: number) => {
		while (cursor < upto) {
			lines.push(file.lines[cursor]!);
			terms.push(file.terms[cursor]!);
			map[cursor] = lines.length;
			cursor++;
		}
	};
	for (const p of placed) {
		copy(p.gap);
		const removed = p.replace ? file.lines.slice(p.gap, p.end) : [];
		if (p.replace) cursor = p.end;
		const newStart = lines.length + 1;
		for (const row of p.put.body) {
			lines.push(row);
			terms.push(dom);
		}
		changed.push([newStart, lines.length]);
		const oldStart = removed.length > 0 ? p.gap + 1 : p.gap;
		hunks.push(
			`@@ -${oldStart},${removed.length} +${newStart},${p.put.body.length} @@\n` +
				removed.map((r) => `-${r}\n`).join("") +
				p.put.body.map((r) => `+${r}\n`).join(""),
		);
	}
	copy(lineCount);
	for (let i = 0; i < terms.length - 1; i++) if (terms[i] === "") terms[i] = dom;
	const last = terms.length - 1;
	if (last >= 0) terms[last] = finalNewline ? terms[last] || dom : "";
	return {
		file: { bom: file.bom, lines, terms },
		map,
		changed,
		hunks: hunks.join(""),
		firstChangedLine: changed[0]?.[0] ?? 1,
	};
}

/** Changed ranges widened by `context` lines, merged and clamped to the file. */
export function previewRanges(changed: readonly [number, number][], lineCount: number, context = 2): [number, number][] {
	return mergeRanges(changed.map(([a, b]) => [Math.max(1, a - context), Math.min(lineCount, b + context)] as const));
}

/** Carry seen lines through an edit's line map; replaced lines drop out. */
export function remapSeen(seen: Seen, map: readonly (number | undefined)[]): Seen {
	if (seen === "all") return "all";
	const out = new Set<number>();
	for (const n of seen) {
		const moved = map[n - 1];
		if (moved !== undefined) out.add(moved);
	}
	return out;
}
