import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	baseUrl,
	configPath,
	convertLegacy,
	lastSession,
	loadClientConfig,
	migrateLegacy,
	parseAddress,
	parseClientConfig,
	putWorkspace,
	removeWorkspace,
	renameWorkspace,
	resolveStart,
	saveClientConfig,
	setDefault,
	setLastSession,
	setPref,
	statePath,
} from "../../src/tui/workspaces.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tobor-ws-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `# my nodes
workspaces:
  personal: { host: 127.0.0.1, port: 7879 } # laptop
  work:     { host: 127.0.0.1, port: 7881 }
default: personal
confirm_auto: true
editor: nvim
pdf_dir: ~/Downloads
theme: dark # unknown key, kept
`;

describe("addresses", () => {
	it.each([
		["127.0.0.1:7879", { host: "127.0.0.1", port: 7879 }],
		["work-host", { host: "work-host", port: 7879 }],
		["http://work-host:8000/", { host: "work-host", port: 8000 }],
		["[::1]:7879", { host: "[::1]", port: 7879 }],
		["https://tobor.example.org", { host: "https://tobor.example.org", port: 443 }],
	])("%s", (input, expected) => {
		expect(parseAddress(input)).toEqual(expected);
	});

	it.each(["", "ftp://host", "host:7879/api", "http://user@host", "host:notaport"])("rejects %j", (input) => {
		expect(() => parseAddress(input)).toThrow();
	});

	it("baseUrl", () => {
		expect(baseUrl({ host: "h", port: 1 })).toBe("http://h:1");
		expect(baseUrl({ host: "https://x.org", port: 443 })).toBe("https://x.org");
		expect(baseUrl({ host: "https://x.org", port: 8443 })).toBe("https://x.org:8443");
	});
});

describe("config.yml loader", () => {
	it("parses workspaces, default and prefs with ~ expansion", () => {
		const cfg = parseClientConfig(SAMPLE);
		expect(cfg.workspaces).toEqual([
			{ name: "personal", host: "127.0.0.1", port: 7879 },
			{ name: "work", host: "127.0.0.1", port: 7881 },
		]);
		expect(cfg.default).toBe("personal");
		expect(cfg.prefs).toEqual({ confirm_auto: true, editor: "nvim", pdf_dir: join(homedir(), "Downloads") });
	});

	it("allows the same host:port under two names and defaults the port", () => {
		const cfg = parseClientConfig("workspaces:\n  a: { host: h }\n  b: { host: h, port: 7879 }\n");
		expect(cfg.workspaces.map((w) => `${w.name}=${w.host}:${w.port}`)).toEqual(["a=h:7879", "b=h:7879"]);
	});

	it.each([
		["syntax", "workspaces: [\n"],
		["not a mapping", "- a\n"],
		["workspaces list", "workspaces:\n  - a\n"],
		["bad name", "workspaces:\n  Work: { host: h, port: 1 }\n"],
		["name starting with -", "workspaces:\n  -x: { host: h, port: 1 }\n"],
		["missing host", "workspaces:\n  a: { port: 1 }\n"],
		["bad port", "workspaces:\n  a: { host: h, port: 70000 }\n"],
		["string port", "workspaces:\n  a: { host: h, port: '1' }\n"],
		["unknown default", "workspaces:\n  a: { host: h }\ndefault: b\n"],
		["confirm_auto type", "confirm_auto: yes please\n"],
	])("rejects %s", (_label, text) => {
		expect(() => parseClientConfig(text, "/x/config.yml")).toThrow("/x/config.yml");
	});

	it("missing file is empty; save round-trips at 0600", () => {
		const path = configPath({ XDG_CONFIG_HOME: join(tempDir(), "cfg") });
		expect(loadClientConfig(path)).toEqual({ text: "", workspaces: [], prefs: {} });
		saveClientConfig(path, putWorkspace(loadClientConfig(path), "a", { host: "h", port: 1 }));
		expect(loadClientConfig(path).workspaces).toEqual([{ name: "a", host: "h", port: 1 }]);
		expect(loadClientConfig(path).default).toBe("a");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("XDG paths", () => {
		expect(configPath({ XDG_CONFIG_HOME: "/c" })).toBe("/c/tobor/config.yml");
		expect(configPath({ HOME: "/h" })).toBe("/h/.config/tobor/config.yml");
		expect(statePath({ XDG_STATE_HOME: "/s" })).toBe("/s/tobor/state.json");
		expect(statePath({ HOME: "/h" })).toBe("/h/.local/state/tobor/state.json");
	});
});

describe("edits keep comments and unknown keys", () => {
	it("add, change, rename, default, remove, prefs", () => {
		let cfg = parseClientConfig(SAMPLE);
		cfg = putWorkspace(cfg, "demo", { host: "127.0.0.1", port: 7999 });
		cfg = putWorkspace(cfg, "work", { host: "box", port: 7881 });
		cfg = renameWorkspace(cfg, "personal", "home");
		cfg = setPref(cfg, "editor", undefined);
		expect(cfg.text).toContain("# my nodes");
		expect(cfg.text).toContain("# laptop");
		expect(cfg.text).toContain("theme: dark # unknown key, kept");
		expect(cfg.text).not.toContain("editor:");
		expect(cfg.default).toBe("home");
		expect(cfg.workspaces.map((w) => `${w.name}=${w.host}:${w.port}`)).toEqual(["home=127.0.0.1:7879", "work=box:7881", "demo=127.0.0.1:7999"]);
		cfg = setDefault(cfg, "work");
		cfg = removeWorkspace(cfg, "demo");
		expect(cfg.default).toBe("work");
		cfg = removeWorkspace(cfg, "work");
		expect(cfg.default).toBeUndefined();
		expect(cfg.workspaces.map((w) => w.name)).toEqual(["home"]);
	});

	it("rejects bad names, clashes and unknown workspaces", () => {
		const cfg = parseClientConfig(SAMPLE);
		expect(() => putWorkspace(cfg, "Bad Name", { host: "h", port: 1 })).toThrow("invalid workspace name");
		expect(() => renameWorkspace(cfg, "personal", "work")).toThrow("already exists");
		expect(() => removeWorkspace(cfg, "nope")).toThrow("no workspace named nope");
		expect(() => setDefault(cfg, "nope")).toThrow("no workspace named nope");
	});
});

describe("precedence", () => {
	const cfg = parseClientConfig(SAMPLE);
	it("positional name beats TOBOR_WORKSPACE", () => {
		expect(resolveStart(cfg, "work", { TOBOR_WORKSPACE: "personal" })).toMatchObject({ kind: "workspace", workspace: { name: "work" } });
	});
	it("positional host:port is an address", () => {
		expect(resolveStart(cfg, "10.0.0.1:9000", {})).toEqual({ kind: "address", address: { host: "10.0.0.1", port: 9000 } });
	});
	it("unknown positional name → picker with a reason", () => {
		expect(resolveStart(cfg, "nope", { TOBOR_WORKSPACE: "work" })).toEqual({ kind: "picker", reason: "no workspace named nope" });
	});
	it("TOBOR_WORKSPACE when no positional", () => {
		expect(resolveStart(cfg, undefined, { TOBOR_WORKSPACE: "work" })).toMatchObject({ kind: "workspace", workspace: { name: "work" } });
		expect(resolveStart(cfg, undefined, { TOBOR_WORKSPACE: "gone" })).toMatchObject({ kind: "picker" });
	});
	it("bare: the picker even with a default", () => {
		expect(resolveStart(cfg, undefined, {})).toEqual({ kind: "picker" });
	});
});

describe("state.json", () => {
	it("records last sessions per workspace, outside the config", () => {
		const path = statePath({ XDG_STATE_HOME: join(tempDir(), "state") });
		expect(lastSession(path, "work")).toBeUndefined();
		setLastSession(path, "work", 4);
		setLastSession(path, "personal", 9);
		expect(lastSession(path, "work")).toBe(4);
		setLastSession(path, "work", undefined);
		expect(lastSession(path, "work")).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ workspaces: { work: {}, personal: { last_session: 9 } } });
	});
});

describe("tui.json migration", () => {
	const LEGACY = JSON.stringify({
		active: "work",
		contexts: [
			{ name: "personal", host: "127.0.0.1:7879", lastSession: 9 },
			{ name: "work", host: "127.0.0.1:7881" },
			{ name: "127.0.0.1:7000", host: "127.0.0.1:7000" },
		],
		prefs: { confirm_auto: false, pdf_dir: "~/pdf" },
	});

	it("converts contexts, active and prefs", () => {
		const { yaml, lastSessions } = convertLegacy(LEGACY);
		const cfg = parseClientConfig(yaml);
		expect(cfg.workspaces.map((w) => `${w.name}=${w.host}:${w.port}`)).toEqual(["personal=127.0.0.1:7879", "work=127.0.0.1:7881", "127-0-0-1-7000=127.0.0.1:7000"]);
		expect(cfg.default).toBe("work");
		expect(cfg.prefs).toEqual({ confirm_auto: false, pdf_dir: join(homedir(), "pdf") });
		expect(lastSessions).toEqual({ personal: 9 });
	});

	it("runs once: writes config.yml and state.json, renames tui.json", () => {
		const root = tempDir();
		const env = { XDG_CONFIG_HOME: join(root, "c"), XDG_STATE_HOME: join(root, "s") };
		mkdirSync(join(root, "c", "tobor"), { recursive: true });
		writeFileSync(join(root, "c", "tobor", "tui.json"), LEGACY);
		expect(migrateLegacy(env)).toMatch(/migrated/);
		expect(existsSync(join(root, "c", "tobor", "tui.json"))).toBe(false);
		expect(existsSync(join(root, "c", "tobor", "tui.json.migrated"))).toBe(true);
		expect(loadClientConfig(configPath(env)).default).toBe("work");
		expect(lastSession(statePath(env), "personal")).toBe(9);
		expect(readFileSync(configPath(env), "utf8")).not.toContain("last");
		expect(migrateLegacy(env)).toBeUndefined();
	});

	it("leaves tui.json alone when config.yml exists", () => {
		const root = tempDir();
		const env = { XDG_CONFIG_HOME: root };
		mkdirSync(join(root, "tobor"));
		writeFileSync(join(root, "tobor", "tui.json"), LEGACY);
		writeFileSync(join(root, "tobor", "config.yml"), SAMPLE);
		expect(migrateLegacy(env)).toBeUndefined();
		expect(existsSync(join(root, "tobor", "tui.json"))).toBe(true);
	});
});
