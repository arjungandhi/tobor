import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Default API port of a tobor node. */
export const DEFAULT_PORT = 7879;

/** One saved node: a name and its `host:port` (or `https://…` base URL behind a proxy). */
export type TuiContext = {
	name: string;
	host: string;
	/** Session the TUI last had open on this node. */
	lastSession?: number;
};

/** TUI preferences (`prefs` in tui.json), edited on the settings screen. */
export type TuiPrefs = {
	/** Ask before switching a session or the node default to auto approval (default true). */
	confirm_auto?: boolean;
	/** Editor command for agent files; overrides `$VISUAL`/`$EDITOR`. */
	editor?: string;
	/** Directory artifact PDFs are saved to (default `~/Downloads`). */
	pdf_dir?: string;
};

/** Contents of `~/.config/tobor/tui.json`. */
export type TuiConfig = {
	/** Name of the active context. */
	active?: string;
	contexts: TuiContext[];
	prefs?: TuiPrefs;
};

/** `$XDG_CONFIG_HOME/tobor/tui.json`, default `~/.config/tobor/tui.json`. */
export function tuiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "tobor", "tui.json");
}

/** Normalize user input to a context host: `host:port` for plain http (port defaults to 7879), the base URL for https. */
export function normalizeHost(input: string): string {
	const raw = input.trim().replace(/\/+$/, "");
	if (raw === "") throw new Error("empty host");
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`invalid host: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported scheme: ${url.protocol}`);
	if (url.pathname !== "/" || url.search || url.hash || url.username) throw new Error(`invalid host: ${input}`);
	if (url.protocol === "https:") return url.origin;
	return `${url.hostname}:${url.port || DEFAULT_PORT}`;
}

/** HTTP base URL (no trailing slash) for a context host. */
export function baseUrl(host: string): string {
	return host.startsWith("https://") || host.startsWith("http://") ? host : `http://${host}`;
}

/** Read the config; a missing file is an empty config, a malformed one throws. */
export function loadContexts(path: string): TuiConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { contexts: [] };
		throw err;
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`${path}: ${(err as Error).message}`);
	}
	return parseConfig(data, path);
}

function parseConfig(data: unknown, path: string): TuiConfig {
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${path}: expected an object`);
	const record = data as Record<string, unknown>;
	const list = record.contexts ?? [];
	if (!Array.isArray(list)) throw new Error(`${path}: contexts must be an array`);
	const contexts: TuiContext[] = [];
	for (const [i, item] of list.entries()) {
		if (typeof item !== "object" || item === null) throw new Error(`${path}: contexts[${i}] must be an object`);
		const { name, host, lastSession } = item as Record<string, unknown>;
		if (typeof name !== "string" || typeof host !== "string") {
			throw new Error(`${path}: contexts[${i}] needs string name and host`);
		}
		contexts.push(typeof lastSession === "number" ? { name, host, lastSession } : { name, host });
	}
	const active = typeof record.active === "string" && contexts.some((x) => x.name === record.active) ? record.active : undefined;
	const prefs = parsePrefs(record.prefs, path);
	return { ...(active === undefined ? {} : { active }), contexts, ...(prefs ? { prefs } : {}) };
}

function parsePrefs(data: unknown, path: string): TuiPrefs | undefined {
	if (data === undefined) return undefined;
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${path}: prefs must be an object`);
	const { confirm_auto, editor, pdf_dir } = data as Record<string, unknown>;
	const prefs: TuiPrefs = {};
	if (typeof confirm_auto === "boolean") prefs.confirm_auto = confirm_auto;
	if (typeof editor === "string" && editor !== "") prefs.editor = editor;
	if (typeof pdf_dir === "string" && pdf_dir !== "") prefs.pdf_dir = pdf_dir;
	return prefs;
}

/** Set (or with `undefined`, clear) one preference. */
export function setPref<K extends keyof TuiPrefs>(config: TuiConfig, key: K, value: TuiPrefs[K] | undefined): TuiConfig {
	const { [key]: _, ...rest } = config.prefs ?? {};
	return { ...config, prefs: value === undefined ? rest : { ...rest, [key]: value } };
}

/** Write the config atomically, creating its directory. */
export function saveContexts(path: string, config: TuiConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Add `host` (normalized) if no context has it, and make that context active. */
export function addOrSelect(config: TuiConfig, input: string, name?: string): TuiConfig {
	const host = normalizeHost(input);
	const existing = config.contexts.find((x) => x.host === host);
	if (existing) return { ...config, active: existing.name };
	let unique = name?.trim() || host;
	for (let n = 2; config.contexts.some((x) => x.name === unique); n++) unique = `${name?.trim() || host}-${n}`;
	return { ...config, active: unique, contexts: [...config.contexts, { name: unique, host }] };
}

/** Make the context named `name` active. */
export function selectContext(config: TuiConfig, name: string): TuiConfig {
	if (!config.contexts.some((x) => x.name === name)) throw new Error(`no context named ${name}`);
	return { ...config, active: name };
}

/** Remove a context; the active one falls back to the first remaining. */
export function removeContext(config: TuiConfig, name: string): TuiConfig {
	const contexts = config.contexts.filter((x) => x.name !== name);
	const active = config.active === name ? contexts[0]?.name : config.active;
	return { ...(active === undefined ? {} : { active }), contexts, ...(config.prefs ? { prefs: config.prefs } : {}) };
}

/** The active context, if any. */
export function activeContext(config: TuiConfig): TuiContext | undefined {
	return config.contexts.find((x) => x.name === config.active);
}

/** Record the session last opened on context `name`. */
export function setLastSession(config: TuiConfig, name: string, id: number | undefined): TuiConfig {
	return {
		...config,
		contexts: config.contexts.map((x) => {
			if (x.name !== name) return x;
			const { lastSession: _, ...rest } = x;
			return id === undefined ? rest : { ...rest, lastSession: id };
		}),
	};
}
