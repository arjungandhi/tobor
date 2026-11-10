import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { c } from "../theme.js";

/** A user prompt: a blank line, then the text behind an accent bar. */
export class UserBlock implements Component {
	private text = "";
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string) {
		this.update(text);
	}

	/** Set the prompt text; a no-op when unchanged. */
	update(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const bar = c.accent("▌ ");
		const body = wrapTextWithAnsi(this.text.replace(/\t/g, "    "), Math.max(1, width - 2)).map((line) => bar + c.bold(c.cream(line)));
		const lines = ["", ...(body.length > 0 ? body : [bar])];
		this.cache = { width, lines };
		return lines;
	}
}
