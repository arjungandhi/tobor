/** `details.errorKind` values of `read` and `edit`. */
export type ErrorKind =
	| "missing_tag"
	| "unknown_tag"
	| "stale_tag"
	| "other_file_tag"
	| "unseen_lines"
	| "header_only"
	| "out_of_range"
	| "parse"
	| "no_change"
	| "file_not_found"
	| "io"
	| "write_failed"
	| "invalid_utf8";

/** A failed edit or read: its kind and the model-facing reply. */
export interface EditError {
	kind: ErrorKind;
	message: string;
}

/** Where a `PUT` lands, in the tagged snapshot's line numbers. */
export type Target =
	| { kind: "replace"; start: number; end: number }
	| { kind: "before"; line: number }
	| { kind: "after"; line: number }
	| { kind: "append" };

/** One parsed op; `line` is its 1-based line in the input. */
export type Op =
	| { kind: "put"; target: Target; body: string[]; line: number }
	| { kind: "rem"; line: number }
	| { kind: "mv"; dest: string; line: number };

/** One `[PATH#TAG]` section; `tag` is undefined when the header has no `#`. */
export interface Section {
	path: string;
	tag: string | undefined;
	line: number;
	ops: Op[];
}

export const BLOCK_ANCHOR_MESSAGE = "block anchors (*) are not supported; use an explicit range N.=M after reading the block";
const DEFERRED_MESSAGE =
	"CUT, pastes and registers are not supported; use PUT N.=M: with + rows (to drop lines, replace a range that includes a neighbouring line with that line), REM, or MV";

const fail = (line: number, reason: string): { ok: false; error: EditError } => ({
	ok: false,
	error: { kind: "parse", message: `line ${line}: ${reason}` },
});

function parseTarget(spec: string): Target | undefined {
	let m = /^(\d+)\.=(\d+)$/.exec(spec);
	if (m) return { kind: "replace", start: Number(m[1]), end: Number(m[2]) };
	if (spec === ">$") return { kind: "append" };
	m = /^([<>])(\d+)$/.exec(spec);
	if (m) return m[1] === "<" ? { kind: "before", line: Number(m[2]) } : { kind: "after", line: Number(m[2]) };
	return undefined;
}

const DIFF_MESSAGE = "unified-diff rows (@@, -old, context) are not supported; replace lines with PUT N.=M: and + rows";

/** Parse an `edit` patch into sections; any grammar violation is a `parse` (or `header_only`) error. */
export function parsePatch(input: string): { ok: true; sections: Section[] } | { ok: false; error: EditError } {
	const lines = input.replace(/\r\n/g, "\n").split("\n");
	let first = lines.findIndex((l) => l.trim() !== "");
	let last = lines.findLastIndex((l) => l.trim() !== "");
	if (first >= 0 && lines[first]!.trim() === "*** Begin Patch") first++;
	if (last >= first && lines[last]!.trim() === "*** End Patch") last--;
	if (first < 0 || last < first) return { ok: false, error: { kind: "parse", message: "empty patch; expected a [PATH#TAG] header" } };

	const sections: Section[] = [];
	let section: Section | undefined;
	let put: Extract<Op, { kind: "put" }> | undefined;
	let blankAfterBody = false;

	const closeOp = (): { ok: false; error: EditError } | undefined => {
		if (put && put.body.length === 0) return fail(put.line, "PUT … : needs at least one + row");
		put = undefined;
		blankAfterBody = false;
		return undefined;
	};
	const closeSection = (): { ok: false; error: EditError } | undefined => {
		const bad = closeOp();
		if (bad) return bad;
		if (section && section.ops.length === 0) {
			return { ok: false, error: { kind: "header_only", message: `line ${section.line}: section [${section.path}] has no ops` } };
		}
		return undefined;
	};

	for (let i = first; i <= last; i++) {
		const raw = lines[i]!;
		const n = i + 1;
		if (raw.startsWith("+")) {
			if (!section) return fail(n, "body row outside a section; start with a [PATH#TAG] header");
			if (!put) {
				const prev = section.ops[section.ops.length - 1];
				return fail(n, prev ? `body row under ${prev.kind.toUpperCase()}, which takes no body` : "body row before any op");
			}
			if (blankAfterBody) return fail(n, "empty line inside a PUT body; write a blank line as a lone +");
			put.body.push(raw.slice(1));
			continue;
		}
		if (raw.trim() === "") {
			if (put && put.body.length > 0) blankAfterBody = true;
			continue;
		}
		if (raw.startsWith("@@") || raw.startsWith("-")) return fail(n, DIFF_MESSAGE);
		const line = raw.trim();
		if (line.startsWith("[")) {
			const bad = closeSection();
			if (bad) return bad;
			if (!line.endsWith("]")) return fail(n, "bad header; expected [PATH#TAG]");
			const inner = line.slice(1, -1);
			const hash = inner.lastIndexOf("#");
			const path = hash < 0 ? inner : inner.slice(0, hash);
			if (path.trim() === "") return fail(n, "bad header; the path is empty");
			section = { path, tag: hash < 0 ? undefined : inner.slice(hash + 1), line: n, ops: [] };
			sections.push(section);
			continue;
		}
		if (!section) return fail(n, "expected a [PATH#TAG] header");
		const bad = closeOp();
		if (bad) return bad;
		const word = /^(\S+)/.exec(line)![1]!;
		if (word === "PUT") {
			if (line.includes("*")) return fail(n, BLOCK_ANCHOR_MESSAGE);
			const m = /^PUT (\S+):$/.exec(line);
			if (!m) {
				if (/^PUT \S+( @\S*)?$/.test(line)) return fail(n, DEFERRED_MESSAGE);
				return fail(n, "bad PUT; expected PUT N.=M:, PUT <N:, PUT >N: or PUT >$: followed by + rows");
			}
			const target = parseTarget(m[1]!);
			if (!target) return fail(n, `bad PUT target ${JSON.stringify(m[1])}; expected N.=M, <N, >N or >$`);
			put = { kind: "put", target, body: [], line: n };
			section.ops.push(put);
		} else if (word === "CUT") {
			return fail(n, DEFERRED_MESSAGE);
		} else if (line === "REM") {
			section.ops.push({ kind: "rem", line: n });
		} else if (word === "MV") {
			const arg = line.slice(2).trim();
			let dest: string;
			if (arg.startsWith('"')) {
				if (arg.length < 3 || !arg.endsWith('"')) return fail(n, "bad MV destination; close the quoted path");
				dest = arg.slice(1, -1);
			} else if (arg === "" || /\s/.test(arg)) {
				return fail(n, 'bad MV destination; give one path, quoted ("…") if it has spaces');
			} else dest = arg;
			section.ops.push({ kind: "mv", dest, line: n });
		} else if (raw.startsWith(" ") || raw.startsWith("\t")) {
			return fail(n, DIFF_MESSAGE);
		} else {
			return fail(n, `unknown op ${JSON.stringify(line)}; expected PUT, REM or MV`);
		}
	}
	const bad = closeSection();
	if (bad) return bad;
	return { ok: true, sections };
}
