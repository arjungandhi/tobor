import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { c } from "../theme.js";

/** One status line: styled segments joined by a dim separator on the left, a hint on the right. */
export class StatusLine implements Component {
	private segments: string[] = [];
	private hint = "";
	private cache: { width: number; line: string } | undefined;

	/** Replace the segments (already styled) and the right-hand hint. */
	set(segments: string[], hint: string): void {
		if (hint === this.hint && segments.length === this.segments.length && segments.every((s, i) => s === this.segments[i])) return;
		this.segments = segments;
		this.hint = hint;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return [this.cache.line];
		const full = ` ${this.segments.join(c.dim(" │ "))}`;
		const hint = visibleWidth(full) + visibleWidth(this.hint) + 2 <= width ? c.dim(this.hint) : "";
		const left = truncateToWidth(full, Math.max(1, width - visibleWidth(hint) - 1));
		const line = `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(hint)))}${hint}`;
		this.cache = { width, line };
		return [line];
	}
}
