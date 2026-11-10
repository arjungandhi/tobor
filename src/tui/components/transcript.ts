import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Block } from "../replica.js";
import { c } from "../theme.js";
import { AssistantBlock } from "./assistant-block.js";
import { ToolSlotView } from "./tool-slot.js";
import { UserBlock } from "./user-block.js";

/** A marker or notice line (earlier history, gaps, failures). */
class NoticeLine implements Component {
	private text = "";
	private level: "info" | "warning" | "error" | "marker" = "info";
	private selected = false;
	private cache: { width: number; lines: string[] } | undefined;

	update(text: string, level: NoticeLine["level"]): void {
		if (text === this.text && level === this.level) return;
		this.text = text;
		this.level = level;
		this.cache = undefined;
	}

	setSelected(selected: boolean): void {
		if (selected === this.selected) return;
		this.selected = selected;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const paint = { info: c.muted, warning: c.warning, error: c.error, marker: c.dim }[this.level];
		const glyph = { info: "·", warning: "!", error: "✗", marker: "↑" }[this.level];
		const edge = this.selected ? c.gold("▎") : " ";
		const body = wrapTextWithAnsi(paint(`${glyph} ${this.text}`), Math.max(1, width - 1)).map((line) => truncateToWidth(edge + line, width));
		const lines = ["", ...body];
		this.cache = { width, lines };
		return lines;
	}
}

type View = UserBlock | AssistantBlock | ToolSlotView | NoticeLine;

/** What Enter on the selected block does. */
export type TranscriptAction = { kind: "earlier" } | { kind: "gap"; after: number; upTo: number } | { kind: "toggled" };

/**
 * The session transcript: one retained component per block key, so a frame re-renders only blocks whose content
 * changed (in practice the streaming tail). Tool slots, earlier-history and gap markers are selectable.
 */
export class Transcript implements Component {
	private views = new Map<string, View>();
	private order: Block[] = [];
	private selectedKey: string | undefined;
	private empty = "";
	private lastWidth = 80;

	/** Text shown while the transcript has no blocks. */
	setEmptyText(text: string): void {
		this.empty = text;
	}

	/** Reconcile with freshly derived blocks. */
	update(blocks: Block[]): void {
		const next = new Map<string, View>();
		for (const block of blocks) {
			const prev = this.views.get(block.key);
			next.set(block.key, this.reconcile(prev, block));
		}
		this.views = next;
		this.order = blocks;
		if (this.selectedKey !== undefined && !next.has(this.selectedKey)) this.selectedKey = undefined;
	}

	private reconcile(prev: View | undefined, block: Block): View {
		switch (block.kind) {
			case "user": {
				const view = prev instanceof UserBlock ? prev : new UserBlock(block.text);
				view.update(block.text);
				return view;
			}
			case "assistant":
			case "thinking": {
				const view = prev instanceof AssistantBlock ? prev : new AssistantBlock(block.text, block.kind === "thinking");
				view.update(block.text);
				return view;
			}
			case "tool": {
				const view = prev instanceof ToolSlotView ? prev : new ToolSlotView(block);
				view.update(block);
				return view;
			}
			case "notice": {
				const view = prev instanceof NoticeLine ? prev : new NoticeLine();
				view.update(block.text, block.level);
				return view;
			}
			case "earlier": {
				const view = prev instanceof NoticeLine ? prev : new NoticeLine();
				view.update("earlier messages · ↑ then Enter to load", "marker");
				return view;
			}
			case "gap": {
				const view = prev instanceof NoticeLine ? prev : new NoticeLine();
				view.update("missing messages · select and Enter to load", "marker");
				return view;
			}
		}
	}

	private selectable(): Block[] {
		return this.order.filter((b) => b.kind === "tool" || b.kind === "earlier" || b.kind === "gap");
	}

	private paintSelection(): void {
		for (const [key, view] of this.views) {
			if (view instanceof ToolSlotView || view instanceof NoticeLine) view.setSelected(key === this.selectedKey);
		}
	}

	/** Whether a block is selected (navigation mode). */
	get selecting(): boolean {
		return this.selectedKey !== undefined;
	}

	/** Move the selection by `delta` selectable blocks; starts at the newest. Returns false when nothing is selectable. */
	moveSelection(delta: number): boolean {
		const list = this.selectable();
		if (list.length === 0) return false;
		const at = list.findIndex((b) => b.key === this.selectedKey);
		const index = at === -1 ? list.length - 1 : Math.max(0, Math.min(list.length - 1, at + delta));
		this.selectedKey = list[index]?.key;
		this.paintSelection();
		return true;
	}

	/** Leave navigation mode. */
	clearSelection(): void {
		this.selectedKey = undefined;
		this.paintSelection();
	}

	/** Activate the selected block: expand/collapse a tool, or ask the caller to load history. */
	activate(): TranscriptAction | undefined {
		const block = this.order.find((b) => b.key === this.selectedKey);
		if (!block) return undefined;
		if (block.kind === "earlier") return { kind: "earlier" };
		if (block.kind === "gap") return { kind: "gap", after: block.after, upTo: block.upTo };
		const view = this.views.get(block.key);
		if (view instanceof ToolSlotView) {
			view.toggle();
			return { kind: "toggled" };
		}
		return undefined;
	}

	/** First line of the selected block at the last rendered width (each view caches its lines, so this is cheap). */
	selectedLine(): number | undefined {
		let line = 0;
		for (const block of this.order) {
			if (block.key === this.selectedKey) return line;
			line += this.views.get(block.key)?.render(this.lastWidth).length ?? 0;
		}
		return undefined;
	}

	invalidate(): void {
		for (const view of this.views.values()) view.invalidate();
	}

	render(width: number): string[] {
		this.lastWidth = width;
		if (this.order.length === 0) return this.empty ? ["", c.dim(truncateToWidth(`  ${this.empty}`, width))] : [];
		const lines: string[] = [];
		for (const block of this.order) {
			const view = this.views.get(block.key);
			if (view) for (const line of view.render(width)) lines.push(line);
		}
		return lines;
	}
}
