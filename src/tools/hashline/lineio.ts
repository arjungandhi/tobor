import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { basename, dirname, join } from "node:path";

/** A line terminator: none (last line only), LF, or CRLF. */
export type Term = "" | "\n" | "\r\n";

/** A text file split into lines, each keeping its own terminator; the BOM is held separately. */
export interface TextFile {
	bom: boolean;
	lines: string[];
	terms: Term[];
}

const BOM_BYTES = [0xef, 0xbb, 0xbf];
const BINARY_SNIFF = 8192;

/** Split text into lines; only CRLF counts as one terminator, a lone CR stays in the line. */
export function splitText(text: string, bom = false): TextFile {
	const lines: string[] = [];
	const terms: Term[] = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		if (nl < 0) {
			lines.push(text.slice(start));
			terms.push("");
			break;
		}
		const cr = nl > start && text.charCodeAt(nl - 1) === 13;
		lines.push(text.slice(start, cr ? nl - 1 : nl));
		terms.push(cr ? "\r\n" : "\n");
		start = nl + 1;
	}
	return { bom, lines, terms };
}

/** The file's text with CRLF normalised to LF and no BOM: what tags hash. */
export function normalizedText(file: TextFile): string {
	let out = "";
	for (let i = 0; i < file.lines.length; i++) out += file.lines[i] + (file.terms[i] === "" ? "" : "\n");
	return out;
}

/** The exact file text, BOM and terminators restored. */
export function encodeText(file: TextFile): string {
	let out = file.bom ? "\uFEFF" : "";
	for (let i = 0; i < file.lines.length; i++) out += file.lines[i]! + file.terms[i]!;
	return out;
}

/** The most common terminator; LF on a tie or when there is none. */
export function dominantTerm(file: TextFile): "\n" | "\r\n" {
	let crlf = 0;
	let lf = 0;
	for (const t of file.terms) {
		if (t === "\r\n") crlf++;
		else if (t === "\n") lf++;
	}
	return crlf > lf ? "\r\n" : "\n";
}

/** Whether the file starts with a UTF-8 BOM. */
export function hasBom(bytes: Uint8Array): boolean {
	return bytes.length >= 3 && BOM_BYTES.every((b, i) => bytes[i] === b);
}

/** A NUL byte in the first 8 KiB. */
export function isBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, BINARY_SNIFF);
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
	return false;
}

/** Strict UTF-8 decode into lines; `undefined` when the bytes are not valid UTF-8. */
export function decodeText(bytes: Uint8Array): TextFile | undefined {
	const bom = hasBom(bytes);
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
		return splitText(text, bom);
	} catch {
		return undefined;
	}
}

/** Lossy decode keeping a BOM character, for `:raw` reads. */
export function decodeLossy(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** A filesystem failure classified by the edit/read error kinds. */
export interface IoFailure {
	kind: "file_not_found" | "io" | "invalid_utf8";
	message: string;
}

/** Map a pi-durable `FileError` to `file_not_found` or `io`. */
export function ioFailure(error: FileError): IoFailure {
	return { kind: error.code === "not_found" ? "file_not_found" : "io", message: error.message };
}

/** Read a file's bytes; directories and other failures are `io`, a missing file `file_not_found`. */
export async function readBytes(
	env: ExecutionEnv,
	abs: string,
	ctx: Context,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: IoFailure }> {
	const read = await env.readBinaryFile(abs, ctx);
	if (!read.ok) return { ok: false, error: ioFailure(read.error) };
	return { ok: true, bytes: read.value };
}

/** Read and strictly decode a text file. */
export async function readText(
	env: ExecutionEnv,
	abs: string,
	ctx: Context,
): Promise<{ ok: true; file: TextFile } | { ok: false; error: IoFailure }> {
	const read = await readBytes(env, abs, ctx);
	if (!read.ok) return read;
	const file = decodeText(read.bytes);
	if (!file) return { ok: false, error: { kind: "invalid_utf8", message: `${abs} is not valid UTF-8` } };
	return { ok: true, file };
}

const MODE_SCRIPT = 'chmod "$(stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1")" "$2"';

/**
 * Write `content` to `target` through a temp file in the target's directory and a rename (copy then unlink when the
 * rename crosses devices). `modeFrom` names an existing file whose permission bits the result keeps.
 * Returns a warning string when permissions could not be carried over.
 */
export async function atomicWrite(
	env: ExecutionEnv,
	target: string,
	content: string,
	modeFrom: string | undefined,
	ctx: Context,
): Promise<{ ok: true; warning?: string } | { ok: false; message: string }> {
	const temp = join(dirname(target), `.${basename(target)}.tobor-${Math.random().toString(36).slice(2, 10)}.tmp`);
	const wrote = await env.writeFile(temp, content, ctx);
	if (!wrote.ok) return { ok: false, message: wrote.error.message };
	let warning: string | undefined;
	if (modeFrom !== undefined) {
		const chmod = await env.exec(["sh", "-c", MODE_SCRIPT, "sh", modeFrom, temp], undefined, ctx);
		if (!chmod.ok || chmod.value.exitCode !== 0) warning = `could not preserve the file mode of ${modeFrom}`;
	}
	const renamed = await env.renameFile(temp, target, ctx);
	if (renamed.ok) return warning === undefined ? { ok: true } : { ok: true, warning };
	if (!/EXDEV/.test(renamed.error.message)) {
		await env.remove(temp, { force: true }, ctx);
		return { ok: false, message: renamed.error.message };
	}
	const copied = await env.writeFile(target, content, ctx);
	await env.remove(temp, { force: true }, ctx);
	if (!copied.ok) return { ok: false, message: copied.error.message };
	return warning === undefined ? { ok: true } : { ok: true, warning };
}
