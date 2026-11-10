import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLineStyled } from "../sanitize.js";
import { c } from "../theme.js";

/** One status line: styled segments joined by a dim separator on the left, a hint on the right. */
export class StatusLine implements Component {
	private segments: string[] = [];
	private hint = "";
	private cache: { width: number; line: string } | undefined;

	/** Replace the segments (already styled) and the right-hand hint. */
	set(segments: string[], hint: string): void {
		const cleanSegments = segments.map(oneLineStyled);
		const cleanHint = oneLineStyled(hint);
		if (cleanHint === this.hint && cleanSegments.length === this.segments.length && cleanSegments.every((s, i) => s === this.segments[i])) return;
		this.segments = cleanSegments;
		this.hint = cleanHint;
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
