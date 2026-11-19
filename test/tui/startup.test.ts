import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/tui/app.js";

afterEach(() => {
	vi.useRealTimers();
});

type Fake = {
	initialOpened: number;
	generation: number;
	stopped: boolean;
	flowActive: boolean;
	modals: unknown[];
	session: { target: unknown; composer: unknown };
	client: object | undefined;
	whoami: object | undefined;
	workspace: object | undefined;
	guard: (flow: () => Promise<unknown>) => void;
	openInitial: () => void;
	retryInitial: () => void;
};
const proto = App.prototype as unknown as { openInitial(this: Fake): void; retryInitial(this: Fake): void };

function fake(): Fake & { opened: number } {
	const self = {
		initialOpened: 0,
		generation: 1,
		stopped: false,
		flowActive: false,
		modals: [] as unknown[],
		session: { target: undefined, composer: undefined },
		client: {},
		whoami: {},
		workspace: {},
		opened: 0,
		guard: () => void self.opened++,
		openInitial: () => proto.openInitial.call(self as unknown as Fake),
		retryInitial: () => proto.retryInitial.call(self as unknown as Fake),
	};
	return self as unknown as Fake & { opened: number };
}

describe("openInitial", () => {
	it("does not give up when a modal blocks it: closing the modal retries", () => {
		vi.useFakeTimers();
		const app = fake();
		app.modals = [{}];
		app.openInitial();
		expect(app.opened).toBe(0);
		expect(app.initialOpened).toBe(0); // not consumed
		app.modals = [];
		app.retryInitial();
		vi.runAllTimers();
		expect(app.opened).toBe(1);
	});

	it("opens once per connection", () => {
		vi.useFakeTimers();
		const app = fake();
		app.openInitial();
		app.retryInitial();
		vi.runAllTimers();
		expect(app.opened).toBe(1);
	});

	it("does not retry over a modal, during a flow, or after stop", () => {
		vi.useFakeTimers();
		for (const patch of [{ modals: [{}] }, { flowActive: true }, { stopped: true }] as Partial<Fake>[]) {
			const app = Object.assign(fake(), patch);
			app.retryInitial();
			vi.runAllTimers();
			expect(app.opened).toBe(0);
		}
	});
});
