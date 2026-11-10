import {
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	Editor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatSize, type StagedImage } from "../attachments.js";
import { COMMANDS } from "../keys.js";
import { c, editorTheme } from "../theme.js";

/** Slash-command completion only; the composer edits prompts for a remote host, so local file paths never complete. */
class SlashCommands extends CombinedAutocompleteProvider {
	constructor() {
		super([...COMMANDS], "/", null);
	}

	override async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (cursorLine !== 0 || !(lines[0] ?? "").trimStart().startsWith("/")) return null;
		return super.getSuggestions(lines, cursorLine, cursorCol, { signal: options.signal });
	}

	override shouldTriggerFileCompletion(): boolean {
		return false;
	}
}

/** The prompt editor; its top border names what Enter will do. */
export class Composer extends Editor {
	private label = "";
	private staged: StagedImage[] = [];

	constructor(tui: TUI) {
		super(tui, editorTheme, { paddingX: 1 });
		this.setAutocompleteProvider(new SlashCommands());
	}

	/** Set the label drawn into the top border. */
	setLabel(label: string): void {
		if (label === this.label) return;
		this.label = label;
		this.invalidate();
	}

	/** Images waiting to be sent with the next message. */
	stagedImages(): readonly StagedImage[] {
		return this.staged;
	}

	/** Add an image to the pending attachments. */
	stage(image: StagedImage): void {
		this.staged = [...this.staged, image];
		this.invalidate();
	}

	/** Drop `images` (those just sent), or every pending attachment when omitted. */
	unstage(images?: readonly StagedImage[]): void {
		this.staged = images ? this.staged.filter((s) => !images.includes(s)) : [];
		this.invalidate();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.staged.length === 0) return lines;
		const list = this.staged.map((s) => `${s.name} (${formatSize(s.bytes)})`).join(", ");
		return [truncateToWidth(`${c.accent("attachments:")} ${c.dim(list)}`, width), ...lines];
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0 || this.label === "") return super.renderTopBorder(width, hiddenLineCount);
		const label = truncateToWidth(` ${this.label} `, Math.max(0, width - 4));
		return `${this.borderColor("──")}${c.dim(label)}${this.borderColor("─".repeat(Math.max(0, width - 2 - visibleWidth(label))))}`;
	}
}
