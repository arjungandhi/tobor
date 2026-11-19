import { describe, expect, it } from "vitest";
import { App } from "../../src/tui/app.js";
import type { SocketState } from "../../src/tui/client.js";

describe("connection status text", () => {
	const text = (eventsState: SocketState, eventsDetail: string | undefined, watch = "open"): string =>
		(App.prototype as unknown as { connectionText(this: object, watch: string): string }).connectionText.call({ eventsState, eventsDetail }, watch);

	it("shows the retry detail while waiting", () => {
		expect(text("waiting", "code 1006; retry in 2s")).toBe("reconnecting — code 1006; retry in 2s");
		expect(text("waiting", undefined)).toBe("reconnecting");
	});

	it("says connecting on the first attempt and reconnecting on later ones", () => {
		expect(text("connecting", undefined)).toBe("connecting…");
		expect(text("connecting", "code 1006; retry in 2s")).toBe("reconnecting…");
	});

	it("falls back to the session watch state when the events socket is open", () => {
		expect(text("open", undefined, "connecting")).toBe("connecting");
	});

	it("names the other states", () => {
		expect(text("closed", undefined)).toBe("closed");
	});
});
