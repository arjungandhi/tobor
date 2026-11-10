import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { c } from "../theme.js";

/** A user prompt: a blank line, then the text behind an accent bar. A queued prompt (not yet placed in the transcript) is dimmed and labelled. */
export class UserBlock implements Component {
	private text = "";
	private queued: string | undefined;
	private cache: { width: number; lines: string[] } | undefined;

	/** `queued` is the marker label of a pending prompt (e.g. "queued"); omit for a placed prompt. */
	constructor(text: string, queued?: string) {
		this.update(text, queued);
	}

	/** Set the prompt text and queued label; a no-op when unchanged. */
	update(text: string, queued?: string): void {
		if (text === this.text && queued === this.queued) return;
		this.text = text;
		this.queued = queued;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const queued = this.queued !== undefined;
		const bar = queued ? c.dim("▌ ") : c.user("▌ ");
		const style = queued ? c.dim : c.bold;
		const body = wrapTextWithAnsi(this.text.replace(/\t/g, "    "), Math.max(1, width - 2)).map((line) => bar + style(line));
		const lines = ["", ...(body.length > 0 ? body : [bar])];
		if (queued) lines.push(bar + c.dim(c.italic(this.queued as string)));
		this.cache = { width, lines };
		return lines;
	}
}
