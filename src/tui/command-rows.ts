import { COMMANDS } from "./keys.js";

/**
 * Commands a list picker offers as rows while its filter text starts with them: the command name starts with the first
 * word of `query` (case-insensitive; an empty query matches none), and the command takes no required argument (an
 * `argumentHint` in `[brackets]` is optional, so those stay).
 */
export function commandRows(query: string): { name: string; description: string }[] {
	const word = query.trimStart().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!word) return [];
	return COMMANDS.filter((cmd) => (!cmd.argumentHint || cmd.argumentHint.startsWith("[")) && cmd.name.startsWith(word)).map(({ name, description }) => ({ name, description }));
}
