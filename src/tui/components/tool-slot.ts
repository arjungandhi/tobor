import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolBlock, ToolStatus } from "../replica.js";
import { hardWrap, oneLine, sanitizeText } from "../sanitize.js";
import { c } from "../theme.js";
import { ImageList } from "./image-parts.js";

const TAIL_LINES = 5;
/** Most wrapped rows the expanded view draws per section (arguments, output); the rest collapses into a count. */
const MAX_EXPANDED_ROWS = 300;

const STATUS: Record<ToolStatus, string> = {
	streaming: c.dim("…"),
	pending: c.dim("○"),
	approval: c.warning("⚠"),
	question: c.warning("?"),
	running: c.accent("◐"),
	done: c.success("✓"),
	error: c.error("✗"),
};

/** One-line summary of a tool call's arguments; always safe for a single terminal row. */
export function argsSummary(name: string, args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") return oneLine(String(args));
	const record = args as Record<string, unknown>;
	if (typeof record.command === "string") return oneLine(`$ ${record.command.split("\n")[0]}`);
	if (typeof record.path === "string") return oneLine(record.path);
	if (name === "task" && Array.isArray(record.tasks)) return `${record.tasks.length} worker(s)`;
	return oneLine(JSON.stringify(args) ?? "");
}

/** Hard-wrap preformatted lines into rows (indentation kept), stopping at the row budget; returns how many source lines were cut. */
function wrapRows(source: string[], inner: number, limit: number, out: string[], paint: (piece: string) => string): number {
	let rows = 0;
	for (const [i, line] of source.entries()) {
		for (const piece of hardWrap(line, inner)) {
			if (rows >= limit) return source.length - i;
			out.push(paint(piece));
			rows++;
		}
	}
	return 0;
}

/** A tool call: status, name and argument summary, then the output tail; Enter (via the transcript) expands it. */
export class ToolSlotView implements Component {
	private block: ToolBlock;
	private expanded = false;
	private selected = false;
	private readonly images = new ImageList();
	private cache: { width: number; lines: string[] } | undefined;

	constructor(block: ToolBlock) {
		this.block = block;
		this.images.update(block.images);
	}

	/** Take a newer derivation of the same call. */
	update(block: ToolBlock): void {
		const old = this.block;
		this.block = block;
		if (this.images.update(block.images)) this.cache = undefined;
		if (old.name !== block.name || old.status !== block.status || old.output !== block.output || old.args !== block.args || old.droppedLines !== block.droppedLines) {
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
		this.images.invalidate();
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { name, args, status, output, droppedLines } = this.block;
		const inner = Math.max(1, width - 2);
		const edge = this.selected ? c.accent("▎") : " ";
		const row = (text: string): string => edge + truncateToWidth(text, width - 1, "…", true);
		const label =
			status === "approval"
				? c.warning(" awaiting approval · Alt+Shift+A")
				: status === "question"
					? c.warning(" awaiting answer · answer below or Alt+Shift+U")
					: status === "streaming"
						? c.dim(" preparing")
						: "";
		const lines = ["", row(`${STATUS[status]} ${c.bold(c.tool(oneLine(name)))} ${c.dim(argsSummary(name, args))}${label}`)];
		const more = (count: number): string => row(c.dim(`  ⋮ ${count} more line${count === 1 ? "" : "s"}`));
		if (this.expanded && args !== undefined && !(typeof args === "object" && args !== null && "command" in args && Object.keys(args).length === 1)) {
			const cut = wrapRows(sanitizeText(JSON.stringify(args, null, 2) ?? "").split("\n"), inner, MAX_EXPANDED_ROWS, lines, (piece) => row(` ${c.dim(piece)}`));
			if (cut > 0) lines.push(more(cut));
		}
		const text = sanitizeText(output).replace(/\n+$/, "");
		if (text !== "") {
			const all = text.split("\n");
			const shown = this.expanded ? all : all.slice(-TAIL_LINES);
			const hidden = all.length - shown.length + (droppedLines ?? 0);
			if (hidden > 0) lines.push(row(c.dim(`  ⋮ ${hidden} earlier line${hidden === 1 ? "" : "s"}${this.expanded ? "" : " · Enter expands"}`)));
			const paint = (piece: string): string => row(` ${status === "error" ? c.error(piece) : piece}`);
			if (this.expanded) {
				const cut = wrapRows(shown, inner, MAX_EXPANDED_ROWS, lines, paint);
				if (cut > 0) lines.push(more(cut));
			} else {
				for (const line of shown) lines.push(paint(line));
			}
		}
		lines.push(...this.images.render(width));
		this.cache = { width, lines };
		return lines;
	}
}
