import {
	backgroundAnsi,
	type EditorTheme,
	foregroundAnsi,
	getTerminalColorMode,
	type MarkdownTheme,
	parseColor,
	type SelectListTheme,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";

/** Retro-log dark palette (design: "Artifacts and themes", "TUI"). */
export const PALETTE = {
	bg: "#1C1611",
	panel: "#2A211A",
	gold: "#E0A23B",
	cream: "#EADFC6",
	muted: "#C2B59C",
	dim: "#8A7E68",
	accent: "#E8865A",
	success: "#A3BE8C",
	warning: "#EBCB8B",
	error: "#D8858B",
	band: ["#8C4A2F", "#D0773F", "#DFA73B", "#5B8C8A"],
} as const;

/** A string styler. */
export type Style = (text: string) => string;

const mode: TerminalColorMode = getTerminalColorMode();

function fgOf(hex: string): Style {
	const open = foregroundAnsi(parseColor(hex), mode);
	return (text) => `${open}${text}\x1b[39m`;
}

function bgOf(hex: string): Style {
	const open = backgroundAnsi(parseColor(hex), mode);
	return (text) => `${open}${text}\x1b[49m`;
}

const bold: Style = (text) => `\x1b[1m${text}\x1b[22m`;
const italic: Style = (text) => `\x1b[3m${text}\x1b[23m`;
const underline: Style = (text) => `\x1b[4m${text}\x1b[24m`;
const strike: Style = (text) => `\x1b[9m${text}\x1b[29m`;

/** Palette stylers. */
export const c = {
	gold: fgOf(PALETTE.gold),
	cream: fgOf(PALETTE.cream),
	muted: fgOf(PALETTE.muted),
	dim: fgOf(PALETTE.dim),
	accent: fgOf(PALETTE.accent),
	success: fgOf(PALETTE.success),
	warning: fgOf(PALETTE.warning),
	error: fgOf(PALETTE.error),
	band: PALETTE.band.map(fgOf),
	panelBg: bgOf(PALETTE.panel),
	bold,
	italic,
	underline,
	strike,
};

/** pi-tui Markdown theme in retro-log colours. */
export const markdownTheme: MarkdownTheme = {
	heading: (t) => bold(c.gold(t)),
	link: (t) => underline(c.accent(t)),
	linkUrl: c.dim,
	code: c.warning,
	codeBlock: c.cream,
	codeBlockBorder: c.dim,
	quote: (t) => italic(c.muted(t)),
	quoteBorder: c.gold,
	hr: c.dim,
	listBullet: c.gold,
	bold: (t) => bold(c.cream(t)),
	italic,
	strikethrough: strike,
	underline,
};

/** Default text style for assistant prose. */
export const proseStyle = { color: c.cream };

/** Default text style for thinking blocks. */
export const thinkingStyle = { color: c.dim, italic: true };

/** pi-tui SelectList theme. */
export const selectListTheme: SelectListTheme = {
	selectedPrefix: c.gold,
	selectedText: (t) => bold(c.gold(t)),
	description: c.muted,
	scrollInfo: c.dim,
	noMatch: c.dim,
};

/** pi-tui Editor theme. */
export const editorTheme: EditorTheme = {
	borderColor: c.gold,
	selectList: selectListTheme,
};

/** OSC sequences that set the terminal's default colours to the palette, and the ones that restore them. */
export const TERMINAL_COLORS = {
	set: `\x1b]11;${PALETTE.bg}\x07\x1b]10;${PALETTE.cream}\x07`,
	reset: "\x1b]111\x07\x1b]110\x07",
};
