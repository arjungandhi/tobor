import type { Component } from "@earendil-works/pi-tui";
import type { ImagePart } from "../replica.js";
import { hardWrap, sanitizeText } from "../sanitize.js";
import { c } from "../theme.js";
import { ImageList } from "./image-parts.js";

/** A user prompt: a blank line, then the text behind an accent bar. A queued prompt (not yet placed in the transcript) is dimmed and labelled. */
export class UserBlock implements Component {
	private text = "";
	private queued: string | undefined;
	private readonly images = new ImageList();
	private cache: { width: number; lines: string[] } | undefined;

	/** `queued` is the marker label of a pending prompt (e.g. "queued"); omit for a placed prompt. */
	constructor(text: string, queued?: string, images?: readonly ImagePart[]) {
		this.update(text, queued, images);
	}

	/** Set the prompt text and queued label; a no-op when unchanged. */
	update(text: string, queued?: string, images?: readonly ImagePart[]): void {
		const imagesChanged = this.images.update(images);
		if (!imagesChanged && text === this.text && queued === this.queued) return;
		this.text = text;
		this.queued = queued;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
		this.images.invalidate();
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const queued = this.queued !== undefined;
		const bar = queued ? c.dim("▌ ") : c.user("▌ ");
		const style = queued ? c.dim : c.bold;
		const inner = Math.max(1, width - 2);
		const body = sanitizeText(this.text)
			.split("\n")
			.flatMap((line) => hardWrap(line, inner))
			.map((line) => bar + style(line));
		// A prompt that is only images shows no empty bar line.
		const lines = ["", ...(body.length > 0 ? body : this.images.length === 0 ? [bar] : [])];
		lines.push(...this.images.render(width));
		if (queued) lines.push(bar + c.dim(c.italic(this.queued as string)));
		this.cache = { width, lines };
		return lines;
	}
}
