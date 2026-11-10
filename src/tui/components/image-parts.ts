import { type Component, getCapabilities, Image, truncateToWidth } from "@earendil-works/pi-tui";
import type { ImagePart } from "../replica.js";
import { c } from "../theme.js";

const MAX_WIDTH_CELLS = 60;
const MAX_HEIGHT_CELLS = 20;

/** Approximate decoded size of base64 data, in bytes. */
function byteLength(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text stand-in for an image: `[image image/png, 42 KB]`. */
export function imagePlaceholder(part: ImagePart): string {
	return `[image ${part.mimeType}, ${formatSize(byteLength(part.data))}]`;
}

/**
 * Whether the terminal can show this image inline. Kitty accepts PNG only (no transcoder is registered, so other
 * formats would fall back anyway); iTerm2 decodes png/jpeg/gif/webp itself. Capabilities are detected once by pi-tui
 * (`getCapabilities` memoizes the `detectCapabilities` result).
 */
export function canRenderImage(mimeType: string): boolean {
	const protocol = getCapabilities().images;
	if (protocol === "kitty") return mimeType === "image/png";
	if (protocol === "iterm2") return mimeType.startsWith("image/");
	return false;
}

/** The image parts of one message, as real images where the terminal supports them and placeholder lines elsewhere. */
export class ImageList implements Component {
	private parts: readonly ImagePart[] = [];
	private views: Array<Image | undefined> = [];

	get length(): number {
		return this.parts.length;
	}

	/** Set the parts; returns whether anything changed. */
	update(parts: readonly ImagePart[] | undefined): boolean {
		const next = parts ?? [];
		if (next.length === this.parts.length && next.every((p, i) => p.data === this.parts[i]?.data && p.mimeType === this.parts[i]?.mimeType)) {
			return false;
		}
		this.parts = next;
		this.views = [];
		return true;
	}

	invalidate(): void {
		for (const view of this.views) view?.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const [i, part] of this.parts.entries()) {
			if (canRenderImage(part.mimeType)) {
				const view = (this.views[i] ??= new Image(part.data, part.mimeType, { fallbackColor: c.dim }, { maxWidthCells: MAX_WIDTH_CELLS, maxHeightCells: MAX_HEIGHT_CELLS }));
				lines.push(...view.render(width));
			} else {
				lines.push(truncateToWidth(` ${c.dim(imagePlaceholder(part))}`, width));
			}
		}
		return lines;
	}
}
