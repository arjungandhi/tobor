import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { c } from "../theme.js";

/** The retro-log stripe: a 4-colour top rule, then a one-line header (left: where you are, right: context). */
export class Band implements Component {
	private left = "";
	private right = "";
	private cache: { width: number; lines: string[] } | undefined;

	/** Set the header text (already styled). */
	setHeader(left: string, right: string): void {
		if (left === this.left && right === this.right) return;
		this.left = left;
		this.right = right;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const quarter = Math.floor(width / 4);
		const stripe = c.band
			.map((paint, i) => paint("▀".repeat(i === 3 ? width - quarter * 3 : quarter)))
			.join("");
		const right = truncateToWidth(this.right, Math.max(0, Math.floor(width / 2)));
		const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
		const left = truncateToWidth(` ${this.left}`, leftWidth, "…", true);
		const lines = [stripe, `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`];
		this.cache = { width, lines };
		return lines;
	}
}
