// Pure pieces of `App.pick`'s behaviour (kept free of UI types so they can be unit-tested).

/** Index of the row whose `value` is `value`, or 0 when there is none (no previous selection, or it was filtered out). */
export function indexOfValue(shown: readonly { value: string }[], value: string | undefined): number {
	if (value === undefined) return 0;
	const index = shown.findIndex((entry) => entry.value === value);
	return index < 0 ? 0 : index;
}

/** The footer hint of a list: the empty state, the active filter (single keys are typed into it), or the caller's hint plus the filter advert. */
export function pickHint(state: { itemCount: number; query: string | undefined; hint: string; emptyHint: string; commands: boolean }): string {
	if (state.itemCount === 0) return state.emptyHint;
	if (state.query !== undefined) return `filtering /${state.query}▏ · keys type into the filter · Enter select · Esc clear filter`;
	return `${state.hint}${state.commands ? " · / filter or command" : " · / filter"}`;
}
