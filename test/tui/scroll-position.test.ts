import { describe, expect, it } from "vitest";
import { TranscriptScroll } from "../../src/tui/screens/session.js";

const content = { render: () => [], invalidate() {} };
const layout = (scroll: TranscriptScroll, height: number): void => scroll.updateLayout(height, 10, () => {});

describe("TranscriptScroll", () => {
	it("keeps the viewed lines in place after rows are prepended", () => {
		const scroll = new TranscriptScroll(content, () => {});
		layout(scroll, 50);
		scroll.scrollTo(0, { disableFollow: true });
		scroll.keepPosition(30);
		layout(scroll, 80);
		expect(scroll.scrollTop).toBe(30);
		expect(scroll.isFollowingEnd).toBe(false);
		layout(scroll, 80);
		expect(scroll.scrollTop).toBe(30);
	});

	it("does not shift a view that follows the end", () => {
		const scroll = new TranscriptScroll(content, () => {});
		layout(scroll, 5);
		scroll.keepPosition(30);
		layout(scroll, 35);
		expect(scroll.isFollowingEnd).toBe(true);
		expect(scroll.scrollTop).toBe(25);
	});

	it("reports the top when scrolling up into it and away when scrolled off it", () => {
		const events: string[] = [];
		const scroll = new TranscriptScroll(content, () => events.push("top"), () => events.push("away"));
		layout(scroll, 50);
		scroll.scrollBy(-100);
		expect(events).toEqual(["top"]);
		scroll.scrollBy(3);
		expect(events).toEqual(["top", "away"]);
	});
});
