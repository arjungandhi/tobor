import { describe, expect, it } from "vitest";
import type { PathCompleteResponse } from "../../src/api/types.js";
import type { ApiClient } from "../../src/tui/client.js";
import {
	ComposerCompletion,
	extractPathToken,
	pathItems,
	pathValue,
	routeCompletion,
} from "../../src/tui/path-completion.js";

describe("extractPathToken", () => {
	it("takes the text after the last whitespace", () => {
		expect(extractPathToken("look at src/tu")).toEqual({ text: "src/tu", at: false, quoted: false, raw: "src/tu" });
	});

	it("is empty right after whitespace and for empty text", () => {
		expect(extractPathToken("look ").text).toBe("");
		expect(extractPathToken("").raw).toBe("");
	});

	it("keeps an unclosed quote together, spaces included", () => {
		expect(extractPathToken('open "my dir/fi')).toEqual({ text: '"my dir/fi', at: false, quoted: true, raw: "my dir/fi" });
	});

	it("ignores a closed quote", () => {
		expect(extractPathToken('"a b" c').text).toBe("c");
	});

	it("ignores a quote in the middle of a word", () => {
		expect(extractPathToken('say a"b c').text).toBe("c");
	});

	it("recognizes @ tokens and strips the @ from raw", () => {
		expect(extractPathToken("see @src/a")).toEqual({ text: "@src/a", at: true, quoted: false, raw: "src/a" });
		expect(extractPathToken('see @"my d')).toEqual({ text: '@"my d', at: true, quoted: true, raw: "my d" });
		expect(extractPathToken("@").raw).toBe("");
	});

	it("does not treat a mid-word @ as a trigger", () => {
		expect(extractPathToken("mail me@host").at).toBe(false);
	});
});

describe("pathValue", () => {
	const token = (before: string) => extractPathToken(before);

	it("joins the typed directory part, the name and a slash for directories", () => {
		expect(pathValue(token("src/tu"), { name: "tui", type: "dir" })).toBe("src/tui/");
		expect(pathValue(token("~/pro"), { name: "projects", type: "dir" })).toBe("~/projects/");
		expect(pathValue(token("/etc/ho"), { name: "hosts", type: "file" })).toBe("/etc/hosts");
		expect(pathValue(token("RE"), { name: "README.md", type: "file" })).toBe("README.md");
	});

	it("keeps the ~ of a bare ~ token (the host lists the home directory)", () => {
		expect(pathValue(token("~"), { name: "Documents", type: "dir" })).toBe("~/Documents/");
		expect(pathValue(token("@~"), { name: "notes.txt", type: "file" })).toBe("~/notes.txt");
	});

	it("drops the @ and wraps values containing whitespace in quotes", () => {
		expect(pathValue(token("@src/my"), { name: "my dir", type: "dir" })).toBe('"src/my dir/"');
	});

	it("preserves a leading quote", () => {
		expect(pathValue(token('"src/a'), { name: "app.ts", type: "file" })).toBe('"src/app.ts"');
		expect(pathValue(token('@"a'), { name: "b c", type: "file" })).toBe('"b c"');
	});

	it("keeps the typed directory when it has spaces", () => {
		expect(pathValue(token('"my dir/f'), { name: "file", type: "file" })).toBe('"my dir/file"');
	});
});

describe("pathItems", () => {
	it("labels entries by name with a slash for directories", () => {
		const response: PathCompleteResponse = {
			dir: "/w/src",
			entries: [
				{ name: "tui", type: "dir" },
				{ name: "types.ts", type: "file" },
			],
		};
		expect(pathItems(extractPathToken("src/t"), response)).toEqual([
			{ value: "src/tui/", label: "tui/" },
			{ value: "src/types.ts", label: "types.ts" },
		]);
	});
});

describe("routeCompletion", () => {
	it("tries slash commands for a leading /word, without a path until Tab or a second slash", () => {
		expect(routeCompletion("/re", 0, false)).toEqual({ slash: true, path: null });
		expect(routeCompletion("  /re", 0, false)).toEqual({ slash: true, path: null });
		expect(routeCompletion("/re", 0, true)).toEqual({ slash: true, path: extractPathToken("/re") });
		expect(routeCompletion("/etc/ho", 0, false)).toEqual({ slash: true, path: extractPathToken("/etc/ho") });
	});

	it("is not slash context after a space, on later lines, or when the line does not start with /", () => {
		expect(routeCompletion("/open src/", 0, false)).toEqual({ slash: false, path: null });
		expect(routeCompletion("/open src/", 0, true)).toEqual({ slash: false, path: extractPathToken("/open src/") });
		expect(routeCompletion("/re", 1, true).slash).toBe(false);
		expect(routeCompletion("x /re", 0, false)).toEqual({ slash: false, path: null });
	});

	it("completes any token on Tab and nothing otherwise", () => {
		expect(routeCompletion("look src/", 0, true).path?.raw).toBe("src/");
		expect(routeCompletion("look src/", 0, false).path).toBeNull();
	});

	it("sends @ tokens remote, even on a slash line", () => {
		expect(routeCompletion("see @sr", 2, false)).toEqual({ slash: false, path: extractPathToken("see @sr") });
		expect(routeCompletion("/cmd @sr", 0, false).slash).toBe(false);
		expect(routeCompletion("/cmd @sr", 0, false).path?.at).toBe(true);
	});

	it("never completes the argument of /attach remotely, @ tokens included", () => {
		const none = { slash: false, path: null };
		expect(routeCompletion("/attach sh", 0, true)).toEqual(none);
		expect(routeCompletion("  /attach ~/pi", 0, true)).toEqual(none);
		expect(routeCompletion("/attach @sh", 0, false)).toEqual(none);
		expect(routeCompletion("/attach", 0, true).slash).toBe(true);
		expect(routeCompletion("/attachment sh", 0, true).path?.raw).toBe("sh");
	});
});

describe("ComposerCompletion", () => {
	const signal = new AbortController().signal;
	const response: PathCompleteResponse = {
		dir: "/w",
		entries: [
			{ name: "src", type: "dir" },
			{ name: "setup.sh", type: "file" },
		],
	};
	const make = (calls: string[], id: number | null = 7, api: Partial<ApiClient> | undefined = undefined) =>
		new ComposerCompletion({
			target: () => (id === null ? { kind: "none" } : { kind: "session", id }),
			api: () =>
				(api ?? {
					complete: async (_id: number, prefix: string) => {
						calls.push(prefix);
						return response;
					},
				}) as ApiClient,
		});

	it("sends the token without @ and replaces the whole @token", async () => {
		const calls: string[] = [];
		const out = await make(calls).getSuggestions(["see @s"], 0, 6, { signal });
		expect(calls).toEqual(["s"]);
		expect(out?.prefix).toBe("@s");
		expect(out?.items.map((i) => i.value)).toEqual(["src/", "setup.sh"]);
	});

	it("completes on Tab only when forced", async () => {
		const calls: string[] = [];
		const provider = make(calls);
		expect(await provider.getSuggestions(["see s"], 0, 5, { signal })).toBeNull();
		expect((await provider.getSuggestions(["see s"], 0, 5, { signal, force: true }))?.prefix).toBe("s");
		expect(calls).toEqual(["s"]);
	});

	it("keeps slash command completion", async () => {
		const calls: string[] = [];
		const out = await make(calls).getSuggestions(["/res"], 0, 4, { signal });
		expect(out?.items.some((i) => i.value === "restart")).toBe(true);
		expect(calls).toEqual([]);
	});

	it("falls through to paths when a slash line is an absolute path", async () => {
		const calls: string[] = [];
		const out = await make(calls).getSuggestions(["/etc/s"], 0, 6, { signal });
		expect(calls).toEqual(["/etc/s"]);
		expect(out?.prefix).toBe("/etc/s");
	});

	it("returns null for a worker target, without a client, or on errors", async () => {
		const force = { signal, force: true };
		expect(await make([], null).getSuggestions(["a"], 0, 1, force)).toBeNull();
		const none = new ComposerCompletion({ target: () => ({ kind: "session", id: 1 }), api: () => undefined });
		expect(await none.getSuggestions(["a"], 0, 1, force)).toBeNull();
		const failing = make([], 1, {
			complete: async () => {
				throw new Error("boom");
			},
		});
		expect(await failing.getSuggestions(["a"], 0, 1, force)).toBeNull();
	});

	it("with nothing open, completes against the node's default cwd (no session id)", async () => {
		const calls: unknown[][] = [];
		const provider = new ComposerCompletion({
			target: () => ({ kind: "default" }),
			api: () =>
				({
					complete: async () => {
						throw new Error("must not use the session route");
					},
					completeAt: async (...args: unknown[]) => {
						calls.push(args);
						return response;
					},
				}) as unknown as ApiClient,
		});
		const out = await provider.getSuggestions(["see @s"], 0, 6, { signal });
		expect(calls).toEqual([[undefined, "s"]]);
		expect(out?.items.map((i) => i.value)).toEqual(["src/", "setup.sh"]);
		expect((await provider.getSuggestions(["see s"], 0, 5, { signal, force: true }))?.prefix).toBe("s");
		expect(provider.shouldTriggerFileCompletion()).toBe(true);
		expect(new ComposerCompletion({ target: () => ({ kind: "default" }), api: () => undefined }).shouldTriggerFileCompletion()).toBe(false);
	});

	it("stays off for a worker target even when a client exists", async () => {
		const calls: unknown[] = [];
		const provider = new ComposerCompletion({
			target: () => ({ kind: "none" }),
			api: () => ({ complete: async () => calls.push("c"), completeAt: async () => calls.push("a") }) as unknown as ApiClient,
		});
		expect(await provider.getSuggestions(["see @s"], 0, 6, { signal })).toBeNull();
		expect(await provider.getSuggestions(["s"], 0, 1, { signal, force: true })).toBeNull();
		expect(calls).toEqual([]);
		expect(provider.shouldTriggerFileCompletion()).toBe(false);
	});

	it("drops stale results", async () => {
		const abort = new AbortController();
		const slow = make([], 1, {
			complete: async () => {
				abort.abort();
				return response;
			},
		});
		expect(await slow.getSuggestions(["a"], 0, 1, { signal: abort.signal, force: true })).toBeNull();
	});

	it("gates file completion on a session target and a client", () => {
		expect(make([]).shouldTriggerFileCompletion()).toBe(true);
		expect(make([], null).shouldTriggerFileCompletion()).toBe(false);
		expect(new ComposerCompletion({ target: () => ({ kind: "session", id: 1 }), api: () => undefined }).shouldTriggerFileCompletion()).toBe(false);
	});

	it("declares @ as a trigger character", () => {
		expect(make([]).triggerCharacters).toEqual(["@"]);
	});

	it("applies path items: replaces the @token, leaves dirs open, spaces after @files", async () => {
		const provider = make([]);
		const out = await provider.getSuggestions(["see @s now"], 0, 6, { signal });
		const [dir, file] = out?.items ?? [];
		expect(provider.applyCompletion(["see @s now"], 0, 6, dir!, "@s")).toEqual({ lines: ["see src/ now"], cursorLine: 0, cursorCol: 8 });
		expect(provider.applyCompletion(["see @s"], 0, 6, file!, "@s")).toEqual({ lines: ["see setup.sh "], cursorLine: 0, cursorCol: 13 });
	});

	it("applies a Tab file without a trailing space and a quoted dir with the cursor inside the quotes", async () => {
		const provider = new ComposerCompletion({
			target: () => ({ kind: "session", id: 1 }),
			api: () => ({ complete: async () => ({ dir: "/w", entries: [{ name: "my dir", type: "dir" }] }) }) as unknown as ApiClient,
		});
		const out = await provider.getSuggestions(['x "my'], 0, 5, { signal, force: true });
		expect(out?.prefix).toBe('"my');
		expect(provider.applyCompletion(['x "my"'], 0, 5, out!.items[0]!, '"my')).toEqual({
			lines: ['x "my dir/"'],
			cursorLine: 0,
			cursorCol: 10,
		});
	});

	it("applies an absolute path typed as the first word", async () => {
		const provider = make([]);
		const out = await provider.getSuggestions(["/etc/s"], 0, 6, { signal });
		const src = out!.items[0]!;
		expect(provider.applyCompletion(["/etc/s"], 0, 6, src, "/etc/s")).toEqual({ lines: ["/etc/src/"], cursorLine: 0, cursorCol: 9 });
	});
});
