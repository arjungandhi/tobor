import { describe, expect, it } from "vitest";
import { App } from "../../src/tui/app.js";
import { BUSY_MESSAGE, busyMessage, flowLabel, HOTKEY_TABLE, isModalHotkey } from "../../src/tui/keys.js";

describe("busy message", () => {
	it("names the running flow", () => {
		expect(busyMessage("approvals")).toBe("busy — finish or cancel approvals first");
		expect(busyMessage("/settings")).toBe("busy — finish or cancel /settings first");
	});

	it("falls back to the generic text when the flow is unknown", () => {
		expect(busyMessage()).toBe(BUSY_MESSAGE);
		expect(busyMessage("")).toBe(BUSY_MESSAGE);
	});

	it("labels flows by their hint, else their name", () => {
		expect(flowLabel("approvals")).toBe("approvals");
		expect(flowLabel("newSession")).toBe("new session");
		expect(flowLabel("exit")).toBe("exit");
	});
});

describe("lock-free hotkeys", () => {
	it("only follow-up, next model and paste skip the flow lock", () => {
		const free = HOTKEY_TABLE.filter((e) => "flow" in e && !isModalHotkey(e.name)).map((e) => e.name);
		expect(free).toEqual(["followUp", "modelCycle", "pasteImage"]);
		expect(isModalHotkey("approvals")).toBe(true);
		expect(isModalHotkey("help")).toBe(true);
	});
});

describe("flow lock", () => {
	type Lock = { flowActive: boolean; flowName: string | undefined; flowEpoch: number; retryInitial(): void };
	const proto = App.prototype as unknown as {
		exclusive(this: Lock, label: string, flow: () => Promise<unknown>): Promise<unknown>;
		detachFlow(this: Lock): void;
	};
	const lock = (): Lock => ({ flowActive: false, flowName: undefined, flowEpoch: 0, retryInitial: () => {} });

	it("holds the lock under the flow's label and releases it when the flow settles", async () => {
		const self = lock();
		let seen: string | undefined;
		await proto.exclusive.call(self, "approvals", async () => {
			seen = self.flowName;
		});
		expect(seen).toBe("approvals");
		expect(self.flowActive).toBe(false);
		expect(self.flowName).toBeUndefined();
	});

	it("refuses a second flow with a message naming the first", async () => {
		const self = lock();
		const gate = Promise.withResolvers<void>();
		const first = proto.exclusive.call(self, "/settings", () => gate.promise);
		await expect(proto.exclusive.call(self, "approvals", async () => {})).rejects.toThrow("busy — finish or cancel /settings first");
		gate.resolve();
		await first;
		expect(self.flowActive).toBe(false);
	});

	it("detachFlow releases the lock early, and the detached flow's end does not clobber a later flow", async () => {
		const self = lock();
		const gate = Promise.withResolvers<void>();
		const detached = proto.exclusive.call(self, "/upgrade", async () => {
			proto.detachFlow.call(self);
			await gate.promise;
		});
		await Promise.resolve();
		expect(self.flowActive).toBe(false);
		const later = Promise.withResolvers<void>();
		const next = proto.exclusive.call(self, "approvals", () => later.promise);
		gate.resolve();
		await detached;
		expect(self.flowActive).toBe(true);
		expect(self.flowName).toBe("approvals");
		later.resolve();
		await next;
		expect(self.flowActive).toBe(false);
	});

	it("releases the lock when the flow throws", async () => {
		const self = lock();
		await expect(
			proto.exclusive.call(self, "x", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(self.flowActive).toBe(false);
	});
});
