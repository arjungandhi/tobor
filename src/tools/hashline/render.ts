import { isAbsolute, relative } from "node:path";

/** Lines longer than this are cut with `…` and not marked seen. */
export const MAX_LINE_CHARS = 2000;

/** One `N:TEXT` row and whether its text was cut. */
export function renderRow(n: number, text: string): { text: string; cut: boolean } {
	if (text.length <= MAX_LINE_CHARS) return { text: `${n}:${text}`, cut: false };
	return { text: `${n}:${text.slice(0, MAX_LINE_CHARS)}…`, cut: true };
}

/** Render rows `from..to` (1-based, inclusive) of `lines`; returns the text rows and the uncut line numbers. */
export function renderRows(lines: readonly string[], ranges: readonly (readonly [number, number])[]): { rows: string[]; seen: number[] } {
	const rows: string[] = [];
	const seen: number[] = [];
	for (const [a, b] of ranges) {
		for (let n = a; n <= b; n++) {
			const row = renderRow(n, lines[n - 1] ?? "");
			rows.push(row.text);
			if (!row.cut) seen.push(n);
		}
	}
	return { rows, seen };
}

/** `[path#TAG]`. */
export function header(display: string, tag: string): string {
	return `[${display}#${tag}]`;
}

/** Whether `child` is `parent` or below it. */
export function isUnder(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The path as given, or cwd-relative when it lies under `cwd`. */
export function displayPath(given: string, abs: string, cwd: string): string {
	if (!isUnder(abs, cwd)) return given;
	return relative(cwd, abs) || ".";
}

/** Sort, dedupe and merge numbers or ranges (overlapping or adjacent) into inclusive ranges. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
	const sorted = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: [number, number][] = [];
	for (const [a, b] of sorted) {
		const last = out[out.length - 1];
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** `A-B`, or `A` for a one-line range. */
export function formatRange([a, b]: readonly [number, number]): string {
	return a === b ? `${a}` : `${a}-${b}`;
}
