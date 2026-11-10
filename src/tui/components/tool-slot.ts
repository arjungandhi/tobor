import { type Component, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolBlock, ToolStatus } from "../replica.js";
import { c } from "../theme.js";

const TAIL_LINES = 5;

const STATUS: Record<ToolStatus, string> = {
	streaming: c.dim("…"),
	pending: c.dim("○"),
	approval: c.warning("⚠"),
	running: c.accent("◐"),
	done: c.success("✓"),
	error: c.error("✗"),
};

/** One-line summary of a tool call's arguments. */
export function argsSummary(name: string, args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") return String(args);
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") return `$ ${record.command.split("\n")[0]}`;
	if (typeof record.path === "string") return record.path;
	if (name === "task" && Array.isArray(record.tasks)) return `${record.tasks.length} worker(s)`;
	return JSON.stringify(args);
}

function clean(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "    ").replace(/\r/g, "");
}

/** A tool call: status, name and argument summary, then the output tail; Enter (via the transcript) expands it. */
export class ToolSlotView implements Component {
	private block: ToolBlock;
	private expanded = false;
	private selected = false;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(block: ToolBlock) {
		this.block = block;
	}

	/** Take a newer derivation of the same call. */
	update(block: ToolBlock): void {
		const old = this.block;
		this.block = block;
		if (old.status !== block.status || old.output !== block.output || old.args !== block.args || old.droppedLines !== block.droppedLines) {
			this.cache = undefined;
		}
	}

	/** Toggle between the output tail and the full output and arguments. */
	toggle(): void {
		this.expanded = !this.expanded;
		this.cache = undefined;
	}

	/** Highlight as the transcript selection. */
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
		const { name, args, status, output, droppedLines } = this.block;
		const inner = Math.max(1, width - 2);
		const edge = this.selected ? c.gold("▎") : " ";
		const row = (text: string): string => c.panelBg(edge + truncateToWidth(text, width - 1, "…", true));
		const label = status === "approval" ? c.warning(" awaiting approval · Ctrl+A") : status === "streaming" ? c.dim(" preparing") : "";
		const lines = ["", row(`${STATUS[status]} ${c.bold(c.gold(name))} ${c.muted(clean(argsSummary(name, args)))}${label}`)];
		if (this.expanded && args !== undefined && !(typeof args === "object" && args !== null && "command" in args && Object.keys(args).length === 1)) {
			for (const line of clean(JSON.stringify(args, null, 2)).split("\n")) {
				for (const wrapped of wrapTextWithAnsi(c.dim(line), inner)) lines.push(row(` ${wrapped}`));
			}
		}
		const text = clean(output).replace(/\n+$/, "");
		if (text !== "") {
			const all = text.split("\n");
			const shown = this.expanded ? all : all.slice(-TAIL_LINES);
			const hidden = all.length - shown.length + (droppedLines ?? 0);
			if (hidden > 0) lines.push(row(c.dim(`  ⋮ ${hidden} earlier line${hidden === 1 ? "" : "s"}${this.expanded ? "" : " · Enter expands"}`)));
			const paint = status === "error" ? c.error : c.cream;
			for (const line of shown) {
				for (const wrapped of this.expanded ? wrapTextWithAnsi(line, inner) : [line]) lines.push(row(` ${paint(wrapped)}`));
			}
		}
		this.cache = { width, lines };
		return lines;
	}
}
