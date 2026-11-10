// Load and validate `.tobor/config.yml` by hand: every problem becomes a `ConfigError`, and a usable `Config`
// (defaults for anything missing or invalid) is always returned.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { expandTilde, paths } from "./home.js";
import {
	APPROVAL_MODES,
	type ApprovalMode,
	type Config,
	type ConfigError,
	type ConfigResult,
	DEFAULT_MODEL,
	DEFAULT_PORT,
	DEFAULT_THEME,
	type ListenAddress,
	type McpApprovalPolicy,
	type McpServerSpec,
	NOTIFY_EVENTS,
	type NotifyEvent,
	parseModelRef,
	type ProjectConfig,
	SEARCH_PROVIDERS,
	type SearchProvider,
	SESSION_MODES,
	type SessionMode,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./schema.js";

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse a duration such as `30m`, `12h`, `90d`, `1h30m` or `500ms` into milliseconds; undefined if malformed. */
export function parseDuration(text: string): number | undefined {
	const s = text.trim();
	if (s === "") return undefined;
	const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/y;
	let total = 0;
	let at = 0;
	while (at < s.length) {
		re.lastIndex = at;
		const m = re.exec(s);
		if (!m) return undefined;
		total += Number(m[1]) * UNIT_MS[m[2]!]!;
		at = re.lastIndex;
	}
	return total;
}

/** Parse `host:port`, `[v6]:port` or a bare port (host `127.0.0.1`); undefined if malformed. */
export function parseListen(text: string): ListenAddress | undefined {
	const s = text.trim();
	let host: string;
	let portText: string;
	if (/^\d+$/.test(s)) {
		host = "127.0.0.1";
		portText = s;
	} else if (s.startsWith("[")) {
		const close = s.indexOf("]:");
		if (close < 0) return undefined;
		host = s.slice(1, close);
		portText = s.slice(close + 2);
	} else {
		const colon = s.lastIndexOf(":");
		if (colon <= 0) return undefined;
		host = s.slice(0, colon);
		portText = s.slice(colon + 1);
	}
	if (!/^\d+$/.test(portText)) return undefined;
	const port = Number(portText);
	if (port < 1 || port > 65535 || host === "") return undefined;
	return { host, port };
}

/** Format a listen address back to `host:port` (IPv6 bracketed). */
export function formatListen(addr: ListenAddress): string {
	return addr.host.includes(":") ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/** Collects typed reads from an untyped object, recording errors and unknown keys. */
class Reader {
	constructor(
		readonly errors: ConfigError[],
		readonly prefix: string,
		readonly obj: Record<string, unknown>,
	) {}

	static of(errors: ConfigError[], prefix: string, value: unknown): Reader {
		if (value === undefined || value === null) return new Reader(errors, prefix, {});
		if (typeof value !== "object" || Array.isArray(value)) {
			errors.push({ path: prefix, message: "expected a mapping" });
			return new Reader(errors, prefix, {});
		}
		return new Reader(errors, prefix, value as Record<string, unknown>);
	}

	path(key: string): string {
		return this.prefix ? `${this.prefix}.${key}` : key;
	}

	fail(key: string, message: string): undefined {
		this.errors.push({ path: this.path(key), message });
		return undefined;
	}

	/** Report keys not in `known`. */
	only(known: readonly string[]): void {
		for (const key of Object.keys(this.obj)) if (!known.includes(key)) this.fail(key, "unknown key");
	}

	child(key: string): Reader {
		return Reader.of(this.errors, this.path(key), this.obj[key]);
	}

	has(key: string): boolean {
		return this.obj[key] !== undefined && this.obj[key] !== null;
	}

	string(key: string): string | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string" || v.trim() === "") return this.fail(key, "expected a non-empty string");
		return v;
	}

	stringList(key: string): string[] | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
			return this.fail(key, "expected a list of non-empty strings");
		}
		return v as string[];
	}

	oneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string" || !allowed.includes(v as T)) return this.fail(key, `expected one of ${allowed.join(", ")}`);
		return v as T;
	}

	positiveInt(key: string): number | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return this.fail(key, "expected a positive integer");
		return v;
	}

	boolean(key: string): boolean | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "boolean") return this.fail(key, "expected true or false");
		return v;
	}

	duration(key: string): number | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string") return this.fail(key, "expected a duration with a unit, e.g. 30m, 12h, 30d");
		const ms = parseDuration(v);
		if (ms === undefined) return this.fail(key, `invalid duration ${JSON.stringify(v)}; use e.g. 30m, 12h, 30d`);
		return ms;
	}

	listen(key: string): ListenAddress | undefined {
		const v = this.obj[key];
		if (v === undefined || v === null) return undefined;
		const addr = typeof v === "string" || typeof v === "number" ? parseListen(String(v)) : undefined;
		if (!addr) return this.fail(key, "expected host:port");
		return addr;
	}

	url(key: string): string | undefined {
		const v = this.string(key);
		if (v === undefined) return undefined;
		try {
			const u = new URL(v);
			if (u.protocol !== "http:" && u.protocol !== "https:") return this.fail(key, "expected an http(s) URL");
		} catch {
			return this.fail(key, "expected an absolute URL");
		}
		return v.replace(/\/+$/, "");
	}

	model(key: string): string | undefined {
		const v = this.string(key);
		if (v !== undefined && !parseModelRef(v)) return this.fail(key, "expected provider/modelId");
		return v;
	}
}

function displayHost(host: string): string {
	if (host === "0.0.0.0" || host === "::") return hostname();
	return host.includes(":") ? `[${host}]` : host;
}

function readMcpApproval(r: Reader): Record<string, McpApprovalPolicy> {
	const out: Record<string, McpApprovalPolicy> = {};
	for (const [server, value] of Object.entries(r.obj)) {
		if (value === "auto" || value === "ask") {
			out[server] = value;
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			r.fail(server, "expected auto, ask, or {allow, ask}");
			continue;
		}
		const p = Reader.of(r.errors, r.path(server), value);
		p.only(["allow", "ask"]);
		out[server] = { allow: p.stringList("allow") ?? [], ask: p.stringList("ask") ?? [] };
	}
	return out;
}

/** Validate one `mcp.json` server entry. */
export function readMcpServer(errors: ConfigError[], path: string, value: unknown): McpServerSpec | undefined {
	const r = Reader.of(errors, path, value);
	const type = r.oneOf("type", ["stdio", "http"] as const);
	const env = (key: string): Record<string, string> | undefined => {
		const v = r.obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) {
			return r.fail(key, "expected a mapping of strings");
		}
		return v as Record<string, string>;
	};
	if (type === "stdio") {
		r.only(["type", "command", "args", "env"]);
		const command = r.string("command") ?? r.fail("command", "required");
		if (command === undefined) return undefined;
		const args = r.stringList("args");
		const e = env("env");
		return { type, command, ...(args ? { args } : {}), ...(e ? { env: e } : {}) };
	}
	if (type === "http") {
		r.only(["type", "url", "headers"]);
		const url = r.url("url") ?? r.fail("url", "required");
		if (url === undefined) return undefined;
		const headers = env("headers");
		return { type, url, ...(headers ? { headers } : {}) };
	}
	if (!r.has("type")) r.fail("type", "required (stdio or http)");
	return undefined;
}

/** Validate a parsed `mcp.json` value. */
export function validateMcpJson(raw: unknown): { mcp: { servers: Record<string, McpServerSpec> }; errors: ConfigError[] } {
	const errors: ConfigError[] = [];
	const root = Reader.of(errors, "", raw);
	root.only(["servers"]);
	const servers: Record<string, McpServerSpec> = {};
	const s = root.child("servers");
	for (const [name, value] of Object.entries(s.obj)) {
		const spec = readMcpServer(errors, s.path(name), value);
		if (spec) servers[name] = spec;
	}
	return { mcp: { servers }, errors };
}

/** Validate a parsed node-level config value (`undefined` = empty file) and apply defaults. */
export function validateConfig(raw: unknown, home: string): ConfigResult {
	const errors: ConfigError[] = [];
	const root = Reader.of(errors, "", raw);
	root.only([
		"roots",
		"env_file",
		"listen",
		"artifacts_listen",
		"public_url",
		"artifacts_url",
		"notify",
		"defaults",
		"agents",
		"retention",
		"mcp",
		"artifacts",
		"search",
		"fetch",
	]);

	const roots: string[] = [];
	for (const root0 of root.stringList("roots") ?? [home]) {
		const p = expandTilde(root0);
		if (!isAbsolute(p)) root.fail("roots", `root ${JSON.stringify(root0)} must be absolute or start with ~`);
		else roots.push(resolve(p));
	}

	const toborDir = paths(home).toborDir;
	let envFile = resolve(home, expandTilde(root.string("env_file") ?? "agent.env"));
	const rel = relative(toborDir, envFile);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		root.fail("env_file", "must not be inside .tobor/");
		envFile = paths(home).agentEnv;
	}

	const listen = root.listen("listen") ?? { host: "127.0.0.1", port: DEFAULT_PORT };
	const artifactsListen = root.listen("artifacts_listen") ?? { host: listen.host, port: listen.port + 1 };
	const publicUrl = root.url("public_url") ?? `http://${displayHost(listen.host)}:${listen.port}`;
	const artifactsUrl = root.url("artifacts_url") ?? `http://${displayHost(artifactsListen.host)}:${artifactsListen.port}`;

	const notify = root.child("notify");
	notify.only(["ntfy", "on"]);
	let ntfy: Config["notify"]["ntfy"];
	if (notify.has("ntfy")) {
		const n = notify.child("ntfy");
		n.only(["url", "topic"]);
		const topic = n.string("topic") ?? n.fail("topic", "required");
		const url = n.url("url") ?? "https://ntfy.sh";
		if (topic !== undefined) ntfy = { url, topic };
	}
	let on: NotifyEvent[] = [...NOTIFY_EVENTS];
	const onRaw = notify.stringList("on");
	if (onRaw) {
		const bad = onRaw.filter((e) => !NOTIFY_EVENTS.includes(e as NotifyEvent));
		if (bad.length) notify.fail("on", `unknown events ${bad.join(", ")}; expected ${NOTIFY_EVENTS.join(", ")}`);
		on = onRaw.filter((e): e is NotifyEvent => NOTIFY_EVENTS.includes(e as NotifyEvent));
	}

	const d = root.child("defaults");
	d.only(["model", "thinking", "approval_mode", "max_turns", "mode", "max_workers", "worker_model", "idle", "approval_timeout"]);
	const workerModel = d.model("worker_model");
	const defaults: Config["defaults"] = {
		model: d.model("model") ?? DEFAULT_MODEL,
		thinking: d.oneOf<ThinkingLevel>("thinking", THINKING_LEVELS) ?? "high",
		approval_mode: d.oneOf<ApprovalMode>("approval_mode", APPROVAL_MODES) ?? "auto",
		max_turns: d.positiveInt("max_turns") ?? 100,
		mode: d.oneOf<SessionMode>("mode", SESSION_MODES) ?? "director",
		max_workers: d.positiveInt("max_workers") ?? 8,
		...(workerModel ? { worker_model: workerModel } : {}),
		idle: d.duration("idle") ?? 30 * UNIT_MS.m!,
		approval_timeout: d.duration("approval_timeout") ?? 12 * UNIT_MS.h!,
	};

	const ret = root.child("retention");
	ret.only(["context", "documents"]);
	const retention = {
		context: ret.duration("context") ?? 30 * UNIT_MS.d!,
		documents: ret.duration("documents") ?? 90 * UNIT_MS.d!,
	};

	const mcp = root.child("mcp");
	mcp.only(["approval"]);
	const approval = readMcpApproval(mcp.child("approval"));

	const agents = root.child("agents");
	agents.only(["model_overrides"]);
	const overrides = agents.child("model_overrides");
	const modelOverrides: Record<string, string> = {};
	for (const name of Object.keys(overrides.obj)) {
		const model = overrides.model(name);
		if (model !== undefined) modelOverrides[name] = model;
	}

	const art = root.child("artifacts");
	art.only(["theme"]);
	const theme = art.string("theme") ?? DEFAULT_THEME;

	const s = root.child("search");
	s.only(["provider", "url", "api_key_env", "max_results"]);
	const provider = s.oneOf<SearchProvider>("provider", SEARCH_PROVIDERS) ?? "auto";
	const searchUrl = s.url("url");
	if (provider === "searxng" && searchUrl === undefined) s.fail("url", "required for provider searxng");
	const apiKeyEnv = s.string("api_key_env");
	const search: Config["search"] = {
		provider,
		...(searchUrl !== undefined ? { url: searchUrl } : {}),
		...(apiKeyEnv !== undefined ? { api_key_env: apiKeyEnv } : {}),
		max_results: Math.min(s.positiveInt("max_results") ?? 10, 20),
	};

	const f = root.child("fetch");
	f.only(["allow_private", "max_chars", "timeout_ms", "remote_reader"]);
	const fetch: Config["fetch"] = {
		allow_private: f.boolean("allow_private") ?? false,
		max_chars: f.positiveInt("max_chars") ?? 20_000,
		timeout_ms: f.positiveInt("timeout_ms") ?? 20_000,
		remote_reader: f.boolean("remote_reader") ?? true,
	};

	return {
		config: {
			roots,
			env_file: envFile,
			listen,
			artifacts_listen: artifactsListen,
			public_url: publicUrl,
			artifacts_url: artifactsUrl,
			notify: { ...(ntfy ? { ntfy } : {}), on },
			defaults,
			retention,
			mcp: { approval },
			agents: { model_overrides: modelOverrides },
			artifacts: { theme },
			search,
			fetch,
		},
		errors,
	};
}

/** Parse and validate config YAML text (used by the files API before committing an edit). */
export function parseConfigText(text: string, home: string): ConfigResult {
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (err) {
		const result = validateConfig(undefined, home);
		result.errors.push({ path: "", message: `YAML: ${(err as Error).message}` });
		return result;
	}
	return validateConfig(raw, home);
}

/** Load `$TOBOR_HOME/.tobor/config.yml`. A missing file yields pure defaults with no errors. */
export async function loadConfig(home: string): Promise<ConfigResult> {
	let text: string;
	try {
		text = await readFile(paths(home).config, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return validateConfig(undefined, home);
		const result = validateConfig(undefined, home);
		result.errors.push({ path: "", message: `read: ${(err as Error).message}` });
		return result;
	}
	return parseConfigText(text, home);
}

/**
 * Parse a project-level `<git root>/.tobor/config.yml`. Only the whitelist is kept; every other key is reported
 * (callers log these as warnings, never as failures).
 */
export function parseProjectConfig(text: string): { config: ProjectConfig; errors: ConfigError[] } {
	const errors: ConfigError[] = [];
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (err) {
		return { config: {}, errors: [{ path: "", message: `YAML: ${(err as Error).message}` }] };
	}
	const root = Reader.of(errors, "", raw);
	root.only(["defaults", "artifacts", "mcp"]);
	const config: ProjectConfig = {};
	if (root.has("defaults")) {
		const d = root.child("defaults");
		d.only(["model", "thinking", "mode"]);
		const model = d.model("model");
		const thinking = d.oneOf<ThinkingLevel>("thinking", THINKING_LEVELS);
		const mode = d.oneOf<SessionMode>("mode", SESSION_MODES);
		config.defaults = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(mode ? { mode } : {}) };
	}
	if (root.has("artifacts")) {
		const a = root.child("artifacts");
		a.only(["theme"]);
		const theme = a.string("theme");
		if (theme) config.artifacts = { theme };
	}
	if (root.has("mcp")) {
		const m = root.child("mcp");
		m.only(["servers"]);
		const s = m.child("servers");
		const servers: Record<string, McpServerSpec> = {};
		for (const [name, value] of Object.entries(s.obj)) {
			const spec = readMcpServer(errors, s.path(name), value);
			if (spec) servers[name] = spec;
		}
		config.mcp = { servers };
	}
	return { config, errors };
}

/** Overlay the project whitelist onto a node config (only `defaults.model|thinking|mode` and `artifacts.theme`). */
export function applyProjectConfig(config: Config, project: ProjectConfig): Config {
	return {
		...config,
		defaults: { ...config.defaults, ...project.defaults },
		artifacts: { ...config.artifacts, ...project.artifacts },
	};
}
