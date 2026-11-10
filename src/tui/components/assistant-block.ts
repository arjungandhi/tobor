import { type Component, Markdown } from "@earendil-works/pi-tui";
import { sanitizeText } from "../sanitize.js";
import { c, markdownTheme, thinkingStyle } from "../theme.js";

/** Assistant prose or thinking rendered as Markdown; `update` calls `setText` only when the text changed. */
export class AssistantBlock implements Component {
	private readonly markdown: Markdown;
	private text: string;
	private cache: { source: string[]; lines: string[] } | undefined;

	constructor(
		text: string,
		readonly thinking: boolean,
	) {
		this.text = text;
		this.markdown = new Markdown(sanitizeText(text), thinking ? 2 : 0, 0, markdownTheme, thinking ? thinkingStyle : undefined);
	}

	/** Set the block's text (a streaming partial grows by appends). */
	update(text: string): void {
		if (text === this.text) return;
		this.text = text;
		// Escape sequences and control characters are stripped, newlines stay: Markdown needs them.
		this.markdown.setText(sanitizeText(text));
	}

	invalidate(): void {
		this.cache = undefined;
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const source = this.markdown.render(width);
		if (this.cache?.source === source) return this.cache.lines;
		const lines = this.thinking ? ["", c.thinking(c.italic("  thinking")), ...source] : ["", ...source];
		this.cache = { source, lines };
		return lines;
	}
}
