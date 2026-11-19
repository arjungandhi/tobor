import type { PickItem, Picked } from "./app.js";

/**
 * What a `navigate` action handler wants next:
 * - `stay`: show the same rows again, cursor unchanged (the action only opened/closed another modal);
 * - `refresh`: call `view()` again (data changed), cursor on the same row;
 * - `close`: leave the list; `navigate` resolves `"close"` (the caller usually just returns);
 * - `up`: leave the list because the user asked for the tier above (←, sessions → workspaces, ...); `navigate` resolves `"up"` so the caller can open the parent.
 */
export type NavOutcome = "stay" | "refresh" | "close" | "up";

/** One rendering of a list: everything `App.pick` takes, rebuilt by `view()` on every refresh (so titles, banner lines and hints can change). */
export type NavView<T> = {
	title: string;
	items: PickItem<T>[];
	lines?: string[];
	hint?: string;
	/** Footer of an empty list (default "Esc back"); list the `keys` that still work there. */
	emptyHint?: string;
	keys?: string[];
	commands?: boolean;
};

/** The two `App` members `navigate` needs (so it can be tested with a fake). */
export type NavHost = {
	pick<T>(title: string, items: PickItem<T>[], options?: Omit<NavView<T>, "title" | "items"> & { selected?: number }): Promise<Picked<T> | undefined>;
	flash(message: string): void;
};

/**
 * A list screen as a loop around `app.pick()`, replacing the recursive one-shot modal pattern.
 *
 * Contract:
 * - `view()` builds the rows. It runs once before the first show and again after a handler returns `"refresh"`.
 *   An error from the first call propagates (there is nothing to show); an error from a later call is flashed and the
 *   previous rows are shown again.
 * - `key(value)` gives each row a stable identity (an id, never an index). The cursor follows it across refreshes; when
 *   the row is gone (deleted, archived away) the cursor stays at the same position, clamped to the new length.
 * - `onPick(picked)` runs for Enter and every key in `view().keys` (and for a slash row: `picked.command`). `picked.value`
 *   is the row under the cursor; it is undefined only for a `keys` press on an empty list. It MUST return a `NavOutcome`
 *   (not void, so a forgotten refresh is a compile error). Esc on the list resolves `"close"` without calling it.
 * - A handler that throws (or rejects) never leaves the list: the error is flashed as `✗ message` and the list re-shows at
 *   the same row, as `"stay"` (rows are not reloaded, since the failed action may not have changed anything).
 * - The filter text is not retained across re-shows; only the cursor is.
 * - Resolves `"close"` or `"up"`; it never rejects unless the first `view()` throws.
 *
 * Handlers open nested flows (`app.ask`, `app.confirm`, another `navigate`) themselves and return `"stay"` / `"refresh"`
 * when those come back, instead of recursing into the parent screen.
 */
export async function navigate<T>(
	app: NavHost,
	screen: {
		view: () => NavView<T> | Promise<NavView<T>>;
		key: (value: T) => string;
		onPick: (picked: Picked<T>) => NavOutcome | Promise<NavOutcome>;
	},
): Promise<"close" | "up"> {
	let view = await screen.view();
	/** Row identity and position of the cursor at the last pick (undefined before the first one). */
	let cursor: { key: string; index: number } | undefined;
	let reload = false;
	for (;;) {
		if (reload) {
			reload = false;
			try {
				view = await screen.view();
			} catch (err) {
				app.flash(errorText(err)); // keep showing the previous rows
			}
		}
		const { title, items, ...options } = view;
		const picked = await app.pick(title, items, { ...options, ...(cursor ? { selected: cursorIndex(items, cursor, screen.key) } : {}) });
		if (!picked) return "close";
		if (picked.value !== undefined) {
			const index = items.findIndex((item) => item.value === picked.value);
			if (index >= 0) cursor = { key: screen.key(picked.value), index };
		}
		let outcome: NavOutcome;
		try {
			outcome = await screen.onPick(picked);
		} catch (err) {
			app.flash(errorText(err));
			continue;
		}
		if (outcome === "close" || outcome === "up") return outcome;
		reload = outcome === "refresh";
	}
}

/** Row to put the cursor on after a re-show: the row with the remembered key, else the remembered position clamped to the list. */
export function cursorIndex<T>(items: readonly PickItem<T>[], cursor: { key: string; index: number }, key: (value: T) => string): number {
	const found = items.findIndex((item) => key(item.value) === cursor.key);
	return found >= 0 ? found : Math.max(0, Math.min(cursor.index, items.length - 1));
}

function errorText(err: unknown): string {
	return `✗ ${(err as Error).message ?? String(err)}`;
}
