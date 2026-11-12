import {
	type AutocompleteItem,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";
import type { PathCompleteResponse, SessionId } from "../api/types.js";
import type { ApiClient } from "./client.js";
import { COMMANDS } from "./keys.js";

/** The path-ish token ending at the cursor. */
export type PathToken = {
	/** Exactly the text before the cursor that completion replaces (`@"my d`, `~/pro`, …). */
	text: string;
	/** Started with `@`: live attachment-style completion that drops the `@`. */
	at: boolean;
	/** Opened with a double quote (paths with spaces). */
	quoted: boolean;
	/** The path as typed, without the `@` or the opening quote: what the endpoint receives. */
	raw: string;
};

/** What a completion request should try: slash commands first, then a remote path token. */
export type CompletionRoute = { slash: boolean; path: PathToken | null };

/** Where the editor's completion gets its host: the connected client and the open session, when there are any. */
export type PathCompletionSource = {
	api(): ApiClient | undefined;
	sessionId(): SessionId | undefined;
};

const WHITESPACE = /\s/;

/** Start of the unclosed double quote in `text`, if any. */
function unclosedQuote(text: string): number {
	let open = -1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') open = open === -1 ? i : -1;
	}
	return open;
}

/** The token before the cursor: after the last whitespace, or from an unclosed opening quote (with its `@`). */
export function extractPathToken(before: string): PathToken {
	let start = before.length;
	while (start > 0 && !WHITESPACE.test(before[start - 1] ?? "")) start--;
	const quote = unclosedQuote(before);
	if (quote !== -1) {
		const from = before[quote - 1] === "@" ? quote - 1 : quote;
		if (from === 0 || WHITESPACE.test(before[from - 1] ?? "")) start = from;
	}
	const text = before.slice(start);
	const at = text.startsWith("@");
	const rest = at ? text.slice(1) : text;
	const quoted = rest.startsWith('"');
	return { text, at, quoted, raw: quoted ? rest.slice(1) : rest };
}

/** Decide what to complete: `@` tokens always go remote, a leading `/word` tries slash commands first, Tab completes any token. */
export function routeCompletion(before: string, cursorLine: number, force: boolean): CompletionRoute {
	const token = extractPathToken(before);
	if (token.at) return { slash: false, path: token };
	if (cursorLine === 0 && /^\s*\/\S*$/.test(before)) {
		// `/etc/ho` is no command: fall through to the host once it has a second `/` (or on Tab).
		return { slash: true, path: force || token.text.indexOf("/", 1) !== -1 ? token : null };
	}
	return { slash: false, path: force ? token : null };
}

/** The directory part of the typed path, kept verbatim in the completed value. */
function dirPart(raw: string): string {
	return raw.slice(0, raw.lastIndexOf("/") + 1);
}

/** The text inserted for `entry`: typed directory + name, `/` after dirs, double-quoted when it has whitespace or the token was quoted. */
export function pathValue(token: PathToken, entry: PathCompleteResponse["entries"][number]): string {
	const path = `${dirPart(token.raw)}${entry.name}${entry.type === "dir" ? "/" : ""}`;
	return token.quoted || WHITESPACE.test(path) ? `"${path}"` : path;
}

/** Autocomplete items for a completion response, dirs and files as the host listed them. */
export function pathItems(token: PathToken, response: PathCompleteResponse): AutocompleteItem[] {
	return response.entries.map((entry) => ({
		value: pathValue(token, entry),
		label: entry.type === "dir" ? `${entry.name}/` : entry.name,
	}));
}

/**
 * Composer completion: slash commands on the first line, plus paths on the host the session runs on
 * (Tab anywhere, or live after `@`). Local files never complete; the prompt is for the remote machine.
 */
export class ComposerCompletion extends CombinedAutocompleteProvider {
	readonly triggerCharacters = ["@"];
	private readonly pathItemSet = new WeakSet<AutocompleteItem>();

	constructor(private readonly source: PathCompletionSource) {
		super([...COMMANDS], "/", null);
	}

	override async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const route = routeCompletion(before, cursorLine, options.force ?? false);
		if (route.slash) {
			const slash = await super.getSuggestions(lines, cursorLine, cursorCol, { signal: options.signal });
			if (slash) return slash;
		}
		return route.path ? this.pathSuggestions(route.path, options.signal) : null;
	}

	private async pathSuggestions(token: PathToken, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
		const id = this.source.sessionId();
		const api = this.source.api();
		if (id === undefined || !api) return null;
		let response: PathCompleteResponse;
		try {
			response = await api.complete(id, token.raw);
		} catch {
			return null;
		}
		if (signal.aborted) return null;
		const items = pathItems(token, response);
		if (items.length === 0) return null;
		for (const item of items) this.pathItemSet.add(item);
		return { items, prefix: token.text };
	}

	override applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (!this.pathItemSet.has(item)) return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const line = lines[cursorLine] ?? "";
		const head = line.slice(0, cursorCol - prefix.length);
		let tail = line.slice(cursorCol);
		const closed = item.value.endsWith('"');
		// The closing quote the value brings replaces one already typed after the cursor.
		if (closed && /^@?"/.test(prefix) && tail.startsWith('"')) tail = tail.slice(1);
		const dir = item.label.endsWith("/");
		// `@file` is finished, so move on; directories stay open for further typing.
		const space = prefix.startsWith("@") && !dir ? " " : "";
		const next = [...lines];
		next[cursorLine] = `${head}${item.value}${space}${tail}`;
		const end = head.length + item.value.length;
		return { lines: next, cursorLine, cursorCol: dir && closed ? end - 1 : end + space.length };
	}

	override shouldTriggerFileCompletion(): boolean {
		return this.source.sessionId() !== undefined && this.source.api() !== undefined;
	}
}
