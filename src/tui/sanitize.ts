import { visibleWidth } from "@earendil-works/pi-tui";

// pi-tui's stripTerminalSequences only knows CSI ending in m/G/K/H/J, so cursor moves (\x1b[1A), mode switches
// (\x1b[?25l) and friends would reach the terminal; externally sourced text goes through these instead.

/** OSC, DCS, SOS, PM and APC strings: ESC + one of ] P X ^ _, terminated by BEL or ST (ESC \), or by the end of the text. */
const STRING_SEQUENCE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g;
/** A complete CSI sequence, or one cut off at the end of the text. */
const CSI = /\x1b\[[0-?]*[ -/]*(?:[@-~]|$)/g;
/** Two-byte (and nF) ESC sequences such as ESC ( B or ESC =. */
const ESCAPE = /\x1b[ -/]*[0-~]/g;
/** C0 controls except \n (tabs and \r are handled before this runs), DEL and C1. */
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

/** Spaces per tab; a fixed width keeps the row layout predictable. */
const TAB = "    ";

/**
 * Make multi-line preformatted text safe to lay out: no escape sequences, no control characters, no tabs, and
 * carriage returns resolved as overwrites (progress bars show their final state). Newlines are kept.
 */
export function sanitizeText(s: string): string {
	return s
		.replace(STRING_SEQUENCE, "")
		.replace(CSI, "")
		.replace(ESCAPE, "")
		.split("\n")
		.map((line) => {
			const text = line.replace(/\r+$/, "");
			return text.slice(text.lastIndexOf("\r") + 1).replace(/\t/g, TAB);
		})
		.join("\n")
		.replace(CONTROL, "");
}

/** `sanitizeText` collapsed to a single trimmed line: safe for exactly one terminal row. */
export function oneLine(s: string): string {
	return sanitizeText(s).replace(/\s+/g, " ").trim();
}

/** SGR (colour/style) sequences: the only escapes `oneLineStyled` lets through. */
const SGR = /(\x1b\[[0-9;:]*m)/;

/**
 * Like `oneLine` for text that is already styled: SGR sequences survive, everything else is sanitized and whitespace
 * (including newlines) becomes single spaces, so the result is exactly one row. Not trimmed, to keep the caller's spacing.
 */
export function oneLineStyled(s: string): string {
	return s
		.split(SGR)
		.map((part, i) => (i % 2 === 1 ? part : sanitizeText(part).replace(/\s+/g, " ")))
		.join("");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Hard-wrap one line by columns, keeping leading whitespace (unlike word wrapping). Every piece is at most `width`
 * columns (a wide character in a one-column slot gets a piece of its own); an empty line gives one empty piece.
 * Meant for sanitized text: wrap before styling, since the line is cut between graphemes, not around escapes.
 */
export function hardWrap(line: string, width: number): string[] {
	const max = Math.max(1, width);
	if (visibleWidth(line) <= max) return [line];
	const pieces: string[] = [];
	let piece = "";
	let pieceWidth = 0;
	for (const { segment } of graphemes.segment(line)) {
		const w = visibleWidth(segment);
		if (pieceWidth > 0 && pieceWidth + w > max) {
			pieces.push(piece);
			piece = "";
			pieceWidth = 0;
		}
		piece += segment;
		pieceWidth += w;
	}
	if (piece !== "") pieces.push(piece);
	return pieces;
}
