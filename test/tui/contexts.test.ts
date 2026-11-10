import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	activeContext,
	addOrSelect,
	baseUrl,
	loadContexts,
	normalizeHost,
	removeContext,
	saveContexts,
	selectContext,
	setLastSession,
	type TuiConfig,
	tuiConfigPath,
} from "../../src/tui/contexts.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tobor-tui-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeHost", () => {
	it.each([
		["127.0.0.1:7879", "127.0.0.1:7879"],
		["work-host", "work-host:7879"],
		["http://work-host:8000/", "work-host:8000"],
		["  box.tail1234.ts.net:7000  ", "box.tail1234.ts.net:7000"],
		["[::1]:7879", "[::1]:7879"],
		["https://tobor.example.org", "https://tobor.example.org"],
		["https://tobor.example.org:8443/", "https://tobor.example.org:8443"],
	])("%s → %s", (input, expected) => {
		expect(normalizeHost(input)).toBe(expected);
	});

	it.each(["", "ftp://host", "host:7879/api", "http://user@host", "host:notaport"])("rejects %j", (input) => {
		expect(() => normalizeHost(input)).toThrow();
	});

	it("baseUrl adds http:// to host:port and keeps https URLs", () => {
		expect(baseUrl("host:7879")).toBe("http://host:7879");
		expect(baseUrl("https://tobor.example.org")).toBe("https://tobor.example.org");
	});
});

describe("context list", () => {
	it("adds a new host and makes it active, then selects an existing one without duplicating", () => {
		let cfg: TuiConfig = { contexts: [] };
		cfg = addOrSelect(cfg, "work:7879");
		cfg = addOrSelect(cfg, "home", "personal");
		expect(cfg).toEqual({
			active: "personal",
			contexts: [
				{ name: "work:7879", host: "work:7879" },
				{ name: "personal", host: "home:7879" },
			],
		});
		cfg = addOrSelect(cfg, "http://work:7879");
		expect(cfg.active).toBe("work:7879");
		expect(cfg.contexts).toHaveLength(2);
		expect(activeContext(cfg)?.host).toBe("work:7879");
	});

	it("makes clashing names unique", () => {
		let cfg = addOrSelect({ contexts: [] }, "a:1", "box");
		cfg = addOrSelect(cfg, "b:2", "box");
		cfg = addOrSelect(cfg, "c:3", "box");
		expect(cfg.contexts.map((x) => x.name)).toEqual(["box", "box-2", "box-3"]);
	});

	it("removing the active context falls back to the first remaining", () => {
		let cfg = addOrSelect(addOrSelect({ contexts: [] }, "a:1"), "b:2");
		cfg = removeContext(cfg, "b:2");
		expect(cfg).toEqual({ active: "a:1", contexts: [{ name: "a:1", host: "a:1" }] });
		cfg = removeContext(cfg, "a:1");
		expect(cfg).toEqual({ contexts: [] });
		expect(activeContext(cfg)).toBeUndefined();
	});

	it("selectContext rejects unknown names", () => {
		expect(() => selectContext({ contexts: [] }, "nope")).toThrow("no context named nope");
	});

	it("records and clears the last session per context", () => {
		let cfg = addOrSelect({ contexts: [] }, "a:1");
		cfg = setLastSession(cfg, "a:1", 42);
		expect(activeContext(cfg)?.lastSession).toBe(42);
		cfg = setLastSession(cfg, "a:1", undefined);
		expect(activeContext(cfg)).toEqual({ name: "a:1", host: "a:1" });
	});
});

describe("tui.json", () => {
	it("uses XDG_CONFIG_HOME, else ~/.config", () => {
		expect(tuiConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/tobor/tui.json");
		expect(tuiConfigPath({})).toMatch(/\.config\/tobor\/tui\.json$/);
	});

	it("missing file is an empty config; save creates the directory and round-trips at 0600", () => {
		const path = join(tempDir(), "nested", "tobor", "tui.json");
		expect(loadContexts(path)).toEqual({ contexts: [] });
		const cfg = setLastSession(addOrSelect({ contexts: [] }, "127.0.0.1:7879"), "127.0.0.1:7879", 3);
		saveContexts(path, cfg);
		expect(loadContexts(path)).toEqual(cfg);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	});

	it("drops an active name that matches no context", () => {
		const path = join(tempDir(), "tui.json");
		writeFileSync(path, JSON.stringify({ active: "gone", contexts: [{ name: "a", host: "a:1" }] }));
		expect(loadContexts(path)).toEqual({ contexts: [{ name: "a", host: "a:1" }] });
	});

	it.each([
		["not json", "{"],
		["not an object", "[]"],
		["bad contexts", JSON.stringify({ contexts: {} })],
		["bad entry", JSON.stringify({ contexts: [{ name: 1, host: "a" }] })],
	])("throws on %s", (_label, text) => {
		const path = join(tempDir(), "tui.json");
		writeFileSync(path, text);
		expect(() => loadContexts(path)).toThrow(path);
	});
});
