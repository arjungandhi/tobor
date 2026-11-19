import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLineStyled } from "../sanitize.js";
import { c } from "../theme.js";

/** How a status message is styled: errors are the `✗ `-prefixed ones. */
export type Severity = "info" | "error";

/** A status message ready to paint. */
export type Notice = { text: string; severity: Severity };

/** What the status slot shows right now: the newest live progress, then the transient message. */
export type SlotView = { progress?: string; message?: Notice };

/** Handle of a sticky progress entry; see `StatusSlot.progress`. */
export type Progress = {
	/** Replace the label. No-op after `done`. */
	update(label: string): void;
	/** End the progress (idempotent); with `message`, show it as the slot's transient message. */
	done(message?: string | Notice): void;
};

/** Severity of `text`: `error` for the `✗ `-prefixed messages guards produce, else `info`. */
export function severityOf(text: string): Severity {
	return text.startsWith("✗") ? "error" : "info";
}

/** Default lifetime of a transient message. */
export const FLASH_MS = 4000;

/**
 * The app's single status slot (pure state, clock injectable for tests):
 * - one transient message at a time; a new one replaces the current one, whatever its severity;
 * - sticky progress entries that live until their `done()` and are never replaced by messages (the newest one is shown).
 */
export class StatusSlot {
	private transient: (Notice & { until: number }) | undefined;
	private readonly active: { label: string }[] = [];

	constructor(private readonly now: () => number = Date.now) {}

	/** Show `text` for `durationMs`, replacing the current transient message. */
	flash(text: string, severity: Severity = severityOf(text), durationMs: number = FLASH_MS): void {
		this.transient = { text, severity, until: this.now() + durationMs };
	}

	/** Start a sticky progress entry showing `label` until `done()`. */
	progress(label: string): Progress {
		const entry = { label };
		this.active.push(entry);
		return {
			update: (next) => {
				if (this.active.includes(entry)) entry.label = next;
			},
			done: (message) => {
				const at = this.active.indexOf(entry);
				if (at < 0) return;
				this.active.splice(at, 1);
				if (typeof message === "string") this.flash(message);
				else if (message) this.flash(message.text, message.severity);
			},
		};
	}

	/** What is showing now (expired messages are dropped). */
	view(): SlotView {
		if (this.transient && this.now() >= this.transient.until) this.transient = undefined;
		const view: SlotView = {};
		const progress = this.active.at(-1);
		if (progress) view.progress = progress.label;
		if (this.transient) view.message = { text: this.transient.text, severity: this.transient.severity };
		return view;
	}

	/** Milliseconds until the transient message expires (to schedule a repaint); undefined when there is none. */
	expiresIn(): number | undefined {
		return this.transient ? Math.max(0, this.transient.until - this.now()) : undefined;
	}
}

/** A status segment (already styled). `pinned` ones (connection, pending counts) are never dropped for a message. */
export type Segment = string | { text: string; pinned: true };

/** Least width worth giving the message/progress text; below it the unpinned segments go first, then the text. */
const MIN_NOTICE_WIDTH = 8;

/**
 * One status line, painted in the layout's bottom row (modals leave that row free, see `App.openModal`): the status slot
 * (progress, message) first, then styled segments joined by a dim separator, and a hint on the right when there is room.
 * When space runs out the message/progress text is truncated (ellipsis) first, then the unpinned segments are dropped;
 * pinned segments (connection dot, approval/question counts) always render.
 */
export class StatusLine implements Component {
	private notices: string[] = [];
	private segments: { text: string; pinned: boolean }[] = [];
	private hint = "";
	private cache: { width: number; line: string } | undefined;

	/** Replace the slot view, the segments (already styled) and the right-hand hint. */
	set(segments: Segment[], hint: string, slot: SlotView = {}): void {
		const notices: string[] = [];
		if (slot.progress !== undefined) notices.push(c.accent(`⟳ ${slot.progress}`));
		if (slot.message) notices.push(slot.message.severity === "error" ? c.error(slot.message.text) : slot.message.text);
		const cleanNotices = notices.map(oneLineStyled);
		const cleanSegments = segments.map((s) => (typeof s === "string" ? { text: oneLineStyled(s), pinned: false } : { text: oneLineStyled(s.text), pinned: true }));
		const cleanHint = oneLineStyled(hint);
		if (
			cleanHint === this.hint &&
			cleanSegments.length === this.segments.length &&
			cleanSegments.every((s, i) => s.text === this.segments[i]?.text && s.pinned === this.segments[i]?.pinned) &&
			cleanNotices.length === this.notices.length &&
			cleanNotices.every((s, i) => s === this.notices[i])
		)
			return;
		this.notices = cleanNotices;
		this.segments = cleanSegments;
		this.hint = cleanHint;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return [this.cache.line];
		const sep = c.dim(" │ ");
		const notice = this.notices.join(sep);
		const avail = Math.max(1, width - 1); // the leading space
		// Candidates, most to least informative: every segment, then the pinned ones only.
		let tail = "";
		let head = "";
		for (const keep of [this.segments, this.segments.filter((s) => s.pinned)]) {
			tail = keep.map((s) => s.text).join(sep);
			const room = avail - (tail ? visibleWidth(sep) + visibleWidth(tail) : 0);
			if (!notice) {
				head = "";
				if (visibleWidth(tail) <= avail) break;
			} else if (room >= Math.min(MIN_NOTICE_WIDTH, visibleWidth(notice))) {
				head = truncateToWidth(notice, room);
				break;
			} else head = "";
		}
		let full = ` ${head ? `${head}${tail ? sep : ""}` : ""}${tail}`;
		// Last resort (pinned segments alone are wider than the row): truncate them.
		full = truncateToWidth(full, width);
		const hint = visibleWidth(full) + visibleWidth(this.hint) + 2 <= width ? c.dim(this.hint) : "";
		const line = `${full}${" ".repeat(Math.max(0, width - visibleWidth(full) - visibleWidth(hint)))}${hint}`;
		this.cache = { width, line };
		return [line];
	}
}
