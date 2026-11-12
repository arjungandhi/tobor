import { Editor, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatSize, type StagedImage } from "../attachments.js";
import { ComposerCompletion, type PathCompletionSource } from "../path-completion.js";
import { oneLineStyled } from "../sanitize.js";
import { c, editorTheme } from "../theme.js";

/** The prompt editor; its top border names what Enter will do. */
export class Composer extends Editor {
	private label = "";
	private staged: StagedImage[] = [];

	constructor(tui: TUI, source: PathCompletionSource) {
		super(tui, editorTheme, { paddingX: 1 });
		this.setAutocompleteProvider(new ComposerCompletion(source));
	}

	/** Set the label drawn into the top border. */
	setLabel(label: string): void {
		const clean = oneLineStyled(label);
		if (clean === this.label) return;
		this.label = clean;
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
