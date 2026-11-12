import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLineStyled } from "../sanitize.js";
import { c } from "../theme.js";

/** A one-line rule, then a one-line header (left: where you are, right: context). */
export class Band implements Component {
	private left = "";
	private right = "";
	private cache: { width: number; lines: string[] } | undefined;

	/** Set the header text (already styled). */
	setHeader(left: string, right: string): void {
		const cleanLeft = oneLineStyled(left);
		const cleanRight = oneLineStyled(right);
		if (cleanLeft === this.left && cleanRight === this.right) return;
		this.left = cleanLeft;
		this.right = cleanRight;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const rule = c.accent("─".repeat(width));
		const right = truncateToWidth(this.right, Math.max(0, Math.floor(width / 2)));
		const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
		const left = truncateToWidth(` ${this.left}`, leftWidth, "…", true);
		const lines = [rule, `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`];
		this.cache = { width, lines };
		return lines;
	}
}
