import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Document, isMap, isScalar, parseDocument, type YAMLMap } from "yaml";
import type { WhoamiResponse } from "../api/types.js";

// Client-side configuration of the TUI and `tobor workspace`: `$XDG_CONFIG_HOME/tobor/config.yml` (named workspaces,
// the default one and preferences) and `$XDG_STATE_HOME/tobor/state.json` (runtime state such as the last open session
// per workspace, never written to the config). Edits go through the `yaml` Document API so comments and unknown keys
// survive a write.

/** Default API port of a tobor node. */
export const DEFAULT_PORT = 7879;

/** Workspace names: lowercase letters, digits, `_` and `-`, starting with a letter or digit. */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** A node address: hostname (or an `https://` origin behind a proxy) and port. */
export type Address = { host: string; port: number };

/** One named node. */
export type Workspace = Address & { name: string };

/** Preferences, edited on the settings screen. */
export type Prefs = {
	/** Ask before switching a session or the node default to auto approval (default true). */
	confirm_auto?: boolean;
	/** Editor command for agent files; overrides `$VISUAL`/`$EDITOR`. */
	editor?: string;
	/** Directory artifact PDFs are saved to (`~` expanded; default `~/Downloads`). */
	pdf_dir?: string;
};

/** A parsed config.yml: its source text plus the validated view of it. */
export type ClientConfig = {
	text: string;
	workspaces: Workspace[];
	/** Workspace the picker preselects. */
	default?: string;
	prefs: Prefs;
};

function configHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
}

/** `$XDG_CONFIG_HOME/tobor/config.yml`, default `~/.config/tobor/config.yml`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "tobor", "config.yml");
}

/** The pre-workspaces client config, migrated once by `migrateLegacy`. */
export function legacyPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "tobor", "tui.json");
}

/** `$XDG_STATE_HOME/tobor/state.json`, default `~/.local/state/tobor/state.json`. */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "tobor", "state.json");
}

/** Expand a leading `~` to the home directory. */
export function expandHome(path: string, home = homedir()): string {
	return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** Parse `host:port`, `host` (port 7879), `http://host:port` or an `https://` origin. */
export function parseAddress(input: string): Address {
	const raw = input.trim().replace(/\/+$/, "");
	if (raw === "") throw new Error("empty address");
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`invalid address: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported scheme: ${url.protocol}`);
	if (url.pathname !== "/" || url.search || url.hash || url.username) throw new Error(`invalid address: ${input}`);
	if (url.protocol === "https:") return { host: `https://${url.hostname}`, port: url.port ? Number(url.port) : 443 };
	return { host: url.hostname, port: url.port ? Number(url.port) : DEFAULT_PORT };
}

/** `host:port` for display (an https origin keeps its scheme). */
export function formatAddress(a: Address): string {
	return `${a.host}:${a.port}`;
}

/** HTTP base URL (no trailing slash) of an address. */
export function baseUrl(a: Address): string {
	if (a.host.startsWith("https://")) return a.port === 443 ? a.host : `${a.host}:${a.port}`;
	return `http://${a.host}:${a.port}`;
}

/** Throw unless `name` is a valid workspace name. */
export function checkName(name: string): void {
	if (!NAME_RE.test(name)) throw new Error(`invalid workspace name ${JSON.stringify(name)}: use [a-z0-9][a-z0-9_-]*`);
}

function checkPort(port: unknown, where: string): number {
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${where}: port must be an integer 1-65535`);
	return port;
}

/** Parse and validate config.yml text; errors name `source`. */
export function parseClientConfig(text: string, source = "config.yml"): ClientConfig {
	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new Error(`${source}: ${doc.errors[0]!.message}`);
	const data: unknown = doc.toJS() ?? {};
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${source}: expected a mapping`);
	const record = data as Record<string, unknown>;
	const list = record.workspaces ?? {};
	if (typeof list !== "object" || list === null || Array.isArray(list)) throw new Error(`${source}: workspaces must be a mapping of name → { host, port }`);
	const workspaces: Workspace[] = [];
	for (const [name, value] of Object.entries(list)) {
		const where = `${source}: workspaces.${name}`;
		if (!NAME_RE.test(name)) throw new Error(`${where}: invalid name (use [a-z0-9][a-z0-9_-]*)`);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: expected { host, port }`);
		const { host, port } = value as Record<string, unknown>;
		if (typeof host !== "string" || host.trim() === "") throw new Error(`${where}: host must be a non-empty string`);
		workspaces.push({ name, host: host.trim(), port: port === undefined ? DEFAULT_PORT : checkPort(port, where) });
	}
	const def = record.default;
	if (def !== undefined && def !== null) {
		if (typeof def !== "string" || !workspaces.some((w) => w.name === def)) throw new Error(`${source}: default ${JSON.stringify(def)} names no workspace`);
	}
	const prefs: Prefs = {};
	if (record.confirm_auto !== undefined) {
		if (typeof record.confirm_auto !== "boolean") throw new Error(`${source}: confirm_auto must be true or false`);
		prefs.confirm_auto = record.confirm_auto;
	}
	for (const key of ["editor", "pdf_dir"] as const) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value !== "string") throw new Error(`${source}: ${key} must be a string`);
		prefs[key] = key === "pdf_dir" ? expandHome(value) : value;
	}
	return { text, workspaces, ...(typeof def === "string" ? { default: def } : {}), prefs };
}

/** Read config.yml; a missing file is an empty config, an invalid one throws. */
export function loadClientConfig(path: string): ClientConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", workspaces: [], prefs: {} };
		throw err;
	}
	return parseClientConfig(text, path);
}

/** Write config.yml atomically (0600), creating its directory. */
export function saveClientConfig(path: string, config: ClientConfig): void {
	writeAtomic(path, config.text);
}

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Apply `fn` to the config's YAML document and revalidate. */
function edit(config: ClientConfig, fn: (doc: Document) => void): ClientConfig {
	const doc: Document = parseDocument(config.text);
	if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
	fn(doc);
	return parseClientConfig(doc.toString());
}

function workspacesMap(doc: Document): YAMLMap {
	let map = doc.get("workspaces", true);
	if (!isMap(map)) {
		map = doc.createNode({}) as YAMLMap;
		// Workspaces lead the file.
		(doc.contents as YAMLMap).items.unshift(doc.createPair("workspaces", map));
	}
	return map as YAMLMap;
}

/** Look up a workspace by name. */
export function findWorkspace(config: ClientConfig, name: string): Workspace | undefined {
	return config.workspaces.find((w) => w.name === name);
}

/** Add workspace `name`, or change its address; the first workspace becomes the default. */
export function putWorkspace(config: ClientConfig, name: string, address: Address): ClientConfig {
	checkName(name);
	checkPort(address.port, name);
	return edit(config, (doc) => {
		const map = workspacesMap(doc);
		const existing = map.get(name, true);
		if (isMap(existing)) {
			existing.set("host", address.host);
			existing.set("port", address.port);
		} else {
			const node = doc.createNode({ host: address.host, port: address.port }) as YAMLMap;
			node.flow = true;
			map.set(name, node);
		}
		if (config.workspaces.length === 0 && config.default === undefined) doc.set("default", name);
	});
}

/** Remove a workspace (and the default if it was the default). */
export function removeWorkspace(config: ClientConfig, name: string): ClientConfig {
	if (!findWorkspace(config, name)) throw new Error(`no workspace named ${name}`);
	return edit(config, (doc) => {
		workspacesMap(doc).delete(name);
		if (config.default === name) doc.delete("default");
	});
}

/** Rename a workspace in place (keeping its position and comments); a default follows it. */
export function renameWorkspace(config: ClientConfig, from: string, to: string): ClientConfig {
	checkName(to);
	if (!findWorkspace(config, from)) throw new Error(`no workspace named ${from}`);
	if (from !== to && findWorkspace(config, to)) throw new Error(`workspace ${to} already exists`);
	return edit(config, (doc) => {
		const pair = workspacesMap(doc).items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === from);
		if (pair) pair.key = doc.createNode(to);
		if (config.default === from) doc.set("default", to);
	});
}

/** Set (or with `undefined`, clear) the default workspace. */
export function setDefault(config: ClientConfig, name: string | undefined): ClientConfig {
	if (name !== undefined && !findWorkspace(config, name)) throw new Error(`no workspace named ${name}`);
	return edit(config, (doc) => {
		if (name === undefined) doc.delete("default");
		else doc.set("default", name);
	});
}

/** Set (or with `undefined`, clear) one preference. */
export function setPref<K extends keyof Prefs>(config: ClientConfig, key: K, value: Prefs[K] | undefined): ClientConfig {
	return edit(config, (doc) => {
		if (value === undefined) doc.delete(key);
		else doc.set(key, value);
	});
}

/** What the TUI opens on. */
export type Start = { kind: "workspace"; workspace: Workspace } | { kind: "address"; address: Address } | { kind: "picker"; reason?: string };

/** Precedence: positional (workspace name, else `host:port`) → `TOBOR_WORKSPACE` → the picker. */
export function resolveStart(config: ClientConfig, positional: string | undefined, env: NodeJS.ProcessEnv = process.env): Start {
	if (positional !== undefined) {
		const ws = findWorkspace(config, positional);
		if (ws) return { kind: "workspace", workspace: ws };
		if (/[:.]/.test(positional)) return { kind: "address", address: parseAddress(positional) };
		return { kind: "picker", reason: `no workspace named ${positional}` };
	}
	const fromEnv = env.TOBOR_WORKSPACE;
	if (fromEnv) {
		const ws = findWorkspace(config, fromEnv);
		if (ws) return { kind: "workspace", workspace: ws };
		return { kind: "picker", reason: `TOBOR_WORKSPACE=${fromEnv}: no such workspace` };
	}
	return { kind: "picker" };
}

/** The workspace saved for `address`, if any. */
export function workspaceAt(config: ClientConfig, address: Address): Workspace | undefined {
	return config.workspaces.find((w) => w.host === address.host && w.port === address.port);
}

/** Runtime state in state.json. */
export type State = { workspaces: Record<string, { last_session?: number }> };

/** Read state.json; missing or unreadable state is empty. */
export function loadState(path: string): State {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
		return { workspaces: typeof data.workspaces === "object" && data.workspaces !== null ? data.workspaces : {} };
	} catch {
		return { workspaces: {} };
	}
}

/** Session last opened in workspace `name`. */
export function lastSession(path: string, name: string): number | undefined {
	const id = loadState(path).workspaces[name]?.last_session;
	return typeof id === "number" ? id : undefined;
}

/** Record (or with `undefined`, clear) the session last opened in workspace `name`. */
export function setLastSession(path: string, name: string, id: number | undefined): void {
	const state = loadState(path);
	const { last_session: _, ...rest } = state.workspaces[name] ?? {};
	state.workspaces[name] = id === undefined ? rest : { ...rest, last_session: id };
	writeAtomic(path, `${JSON.stringify(state, null, "\t")}\n`);
}

/** Make a legacy name valid and unique. */
function legacyName(raw: string, taken: Set<string>): string {
	let base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").replace(/-+$/, "") || "node";
	if (!NAME_RE.test(base)) base = `ws-${base}`;
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	taken.add(name);
	return name;
}

/** Convert tui.json text to config.yml text plus last sessions by workspace name. */
export function convertLegacy(json: string): { yaml: string; lastSessions: Record<string, number> } {
	const data = JSON.parse(json) as { active?: unknown; contexts?: unknown; prefs?: unknown };
	let config: ClientConfig = { text: "", workspaces: [], prefs: {} };
	const lastSessions: Record<string, number> = {};
	const renamed = new Map<string, string>();
	const taken = new Set<string>();
	for (const item of Array.isArray(data.contexts) ? data.contexts : []) {
		const { name, host, lastSession: last } = (item ?? {}) as Record<string, unknown>;
		if (typeof name !== "string" || typeof host !== "string") continue;
		const ws = legacyName(name, taken);
		renamed.set(name, ws);
		config = putWorkspace(config, ws, parseAddress(host));
		if (typeof last === "number") lastSessions[ws] = last;
	}
	const active = typeof data.active === "string" ? renamed.get(data.active) : undefined;
	config = setDefault(config, active ?? config.default);
	const prefs = (typeof data.prefs === "object" && data.prefs !== null ? data.prefs : {}) as Record<string, unknown>;
	if (typeof prefs.confirm_auto === "boolean") config = setPref(config, "confirm_auto", prefs.confirm_auto);
	if (typeof prefs.editor === "string" && prefs.editor) config = setPref(config, "editor", prefs.editor);
	if (typeof prefs.pdf_dir === "string" && prefs.pdf_dir) config = setPref(config, "pdf_dir", prefs.pdf_dir);
	return { yaml: config.text, lastSessions };
}

/** One-time migration: tui.json → config.yml (+ last sessions → state.json), renaming tui.json to tui.json.migrated. Returns a notice when it ran. */
export function migrateLegacy(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const legacy = legacyPath(env);
	const target = configPath(env);
	if (!existsSync(legacy) || existsSync(target)) return undefined;
	const { yaml, lastSessions } = convertLegacy(readFileSync(legacy, "utf8"));
	writeAtomic(target, yaml);
	for (const [name, id] of Object.entries(lastSessions)) setLastSession(statePath(env), name, id);
	renameSync(legacy, `${legacy}.migrated`);
	return `migrated ${legacy} → ${target}`;
}

/** `GET /api/whoami` with a timeout; undefined when unreachable. */
export async function probe(address: Address, timeoutMs = 1500): Promise<WhoamiResponse | undefined> {
	try {
		const res = await fetch(`${baseUrl(address)}/api/whoami`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return undefined;
		return (await res.json()) as WhoamiResponse;
	} catch {
		return undefined;
	}
}
