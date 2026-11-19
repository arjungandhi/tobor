import { describe, expect, it } from "vitest";
import type { Picked } from "../../src/tui/app.js";
import { type NavHost, type NavView, cursorIndex, navigate } from "../../src/tui/nav.js";

type Row = { id: string };
const rows = (...ids: string[]) => ids.map((id) => ({ value: { id }, label: id }));
const key = (r: Row) => r.id;

/** A fake host: `script` answers each pick (it gets the items and `selected`); picks and flashes are recorded. */
function host(script: ((items: { value: Row }[], selected: number | undefined) => Picked<Row> | undefined)[]) {
	const shows: { ids: string[]; selected: number | undefined }[] = [];
	const flashes: string[] = [];
	const app: NavHost = {
		pick: (async (_title: string, items: { value: Row }[], options?: { selected?: number }) => {
			shows.push({ ids: items.map((i) => i.value.id), selected: options?.selected });
			const next = script.shift();
			if (!next) throw new Error("unexpected extra pick");
			return next(items, options?.selected);
		}) as NavHost["pick"],
		flash: (m) => flashes.push(m),
	};
	return { app, shows, flashes };
}
const choose = (index: number, k = "enter") => (items: { value: Row }[]): Picked<Row> => ({ key: k, value: items[index]?.value as Row });

describe("navigate", () => {
	it("Esc closes without calling the handler", async () => {
		const { app } = host([() => undefined]);
		const result = await navigate(app, { view: () => ({ title: "t", items: rows("a") }), key, onPick: () => { throw new Error("no"); } });
		expect(result).toBe("close");
	});

	it("refresh reloads the view and keeps the cursor on the same row by key", async () => {
		const views = [rows("a", "b", "c"), rows("z", "a", "b", "c")];
		const { app, shows } = host([choose(2), () => undefined]);
		await navigate(app, { view: () => ({ title: "t", items: views.shift() ?? [] }), key, onPick: () => "refresh" });
		expect(shows[1]).toEqual({ ids: ["z", "a", "b", "c"], selected: 3 });
	});

	it("stay re-shows the same rows at the same position without calling view again", async () => {
		let loads = 0;
		const { app, shows } = host([choose(1), () => undefined]);
		await navigate(app, { view: () => ({ title: "t", items: (loads++, rows("a", "b")) }), key, onPick: () => "stay" });
		expect(loads).toBe(1);
		expect(shows[1]).toEqual({ ids: ["a", "b"], selected: 1 });
	});

	it("a deleted row leaves the cursor at its position, clamped", async () => {
		const views = [rows("a", "b", "c"), rows("a", "b")];
		const { app, shows } = host([choose(2), () => undefined]);
		await navigate(app, { view: () => ({ title: "t", items: views.shift() ?? [] }), key, onPick: () => "refresh" });
		expect(shows[1]?.selected).toBe(1);
	});

	it("a handler error is flashed and the list re-shows in place", async () => {
		const { app, shows, flashes } = host([choose(1), () => undefined]);
		await navigate(app, {
			view: () => ({ title: "t", items: rows("a", "b") }),
			key,
			onPick: () => {
				throw new Error("boom");
			},
		});
		expect(flashes).toEqual(["✗ boom"]);
		expect(shows[1]).toEqual({ ids: ["a", "b"], selected: 1 });
	});

	it("a failing refresh is flashed and the previous rows stay", async () => {
		let calls = 0;
		const { app, shows, flashes } = host([choose(0), () => undefined]);
		await navigate(app, {
			view: async (): Promise<NavView<Row>> => {
				if (calls++ > 0) throw new Error("offline");
				return { title: "t", items: rows("a") };
			},
			key,
			onPick: () => "refresh",
		});
		expect(flashes).toEqual(["✗ offline"]);
		expect(shows[1]?.ids).toEqual(["a"]);
	});

	it("close and up end the loop with that outcome", async () => {
		for (const outcome of ["close", "up"] as const) {
			const { app, shows } = host([choose(0)]);
			expect(await navigate(app, { view: () => ({ title: "t", items: rows("a") }), key, onPick: () => outcome })).toBe(outcome);
			expect(shows).toHaveLength(1);
		}
	});

	it("an empty-list key press reaches the handler without a value and does not move the cursor", async () => {
		const seen: (string | undefined)[] = [];
		const { app } = host([() => ({ key: "n" }), () => undefined]);
		await navigate(app, {
			view: () => ({ title: "t", items: [], keys: ["n"] }),
			key,
			onPick: (p) => {
				seen.push(p.value?.id);
				return "refresh";
			},
		});
		expect(seen).toEqual([undefined]);
	});

	it("initial puts the cursor on that row for the first show only", async () => {
		const views = [rows("a", "b", "c"), rows("z", "a", "b", "c")];
		const { app, shows } = host([choose(2), () => undefined]);
		await navigate(app, { view: () => ({ title: "t", items: views.shift() ?? [], initial: "c" }), key, onPick: () => "refresh" });
		expect(shows[0]?.selected).toBe(2);
		// the cursor followed the row picked ("c", by key), not `initial`
		expect(shows[1]).toEqual({ ids: ["z", "a", "b", "c"], selected: 3 });
	});

	it("initial is not reapplied after an empty-list key press, and an unknown initial means the first row", async () => {
		const { app, shows } = host([() => ({ key: "n" }), () => undefined]);
		await navigate(app, { view: () => ({ title: "t", items: rows("a", "b"), initial: "b", keys: ["n"] }), key, onPick: () => "stay" });
		expect(shows[0]?.selected).toBe(1);
		expect(shows[1]?.selected).toBeUndefined();
		const gone = host([() => undefined]);
		await navigate(gone.app, { view: () => ({ title: "t", items: rows("a", "b"), initial: "nope" }), key, onPick: () => "stay" });
		expect(gone.shows[0]?.selected).toBe(0);
	});

	it("propagates an error of the first view()", async () => {
		const { app } = host([]);
		await expect(
			navigate(app, {
				view: () => {
					throw new Error("first");
				},
				key,
				onPick: () => "close",
			}),
		).rejects.toThrow("first");
	});
});

describe("cursorIndex", () => {
	it("prefers the key, then the clamped position", () => {
		expect(cursorIndex(rows("x", "y"), { key: "y", index: 0 }, key)).toBe(1);
		expect(cursorIndex(rows("x", "y"), { key: "gone", index: 5 }, key)).toBe(1);
		expect(cursorIndex([], { key: "gone", index: 5 }, key)).toBe(0);
	});
});
