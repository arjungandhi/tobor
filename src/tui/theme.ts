import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

// Terminal theme only: the terminal's default foreground/background, SGR attributes and the 8 standard ANSI colours,
// so the TUI follows whatever palette the user's terminal has.

/** A string styler. */
export type Style = (text: string) => string;

function sgr(open: number, close: number): Style {
	return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

/** ANSI stylers by role. */
export const c = {
	/** Accents, titles, selection, running work. */
	accent: sgr(33, 39),
	/** Pending / needs attention. */
	warning: sgr(33, 39),
	success: sgr(32, 39),
	error: sgr(31, 39),
	/** Tool names. */
	tool: sgr(36, 39),
	link: sgr(36, 39),
	thinking: sgr(35, 39),
	user: sgr(34, 39),
	dim: sgr(2, 22),
	bold: sgr(1, 22),
	italic: sgr(3, 23),
	underline: sgr(4, 24),
	strike: sgr(9, 29),
};

/** pi-tui Markdown theme. */
export const markdownTheme: MarkdownTheme = {
	heading: (t) => c.bold(c.accent(t)),
	link: (t) => c.underline(c.link(t)),
	linkUrl: c.dim,
	code: c.tool,
	codeBlock: (t) => t,
	codeBlockBorder: c.dim,
	quote: (t) => c.italic(c.dim(t)),
	quoteBorder: c.accent,
	hr: c.dim,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: c.strike,
	underline: c.underline,
};

/** Default text style for thinking blocks. */
export const thinkingStyle = { color: c.thinking, italic: true };

/** pi-tui SelectList theme. */
export const selectListTheme: SelectListTheme = {
	selectedPrefix: c.accent,
	selectedText: (t) => c.bold(c.accent(t)),
	description: c.dim,
	scrollInfo: c.dim,
	noMatch: c.dim,
};

/** pi-tui Editor theme. */
export const editorTheme: EditorTheme = {
	borderColor: c.accent,
	selectList: selectListTheme,
};
