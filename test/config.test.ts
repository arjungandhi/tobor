import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths, resolveHome } from "../src/config/home.js";
import { parseConfigText, parseDuration, parseListen } from "../src/config/load.js";

const HOME = "/srv/tobor";

describe("resolveHome", () => {
	it("prefers --home, then TOBOR_HOME, then ~/.local/share/tobor", () => {
		expect(resolveHome({ home: "/a" }, { TOBOR_HOME: "/b" })).toBe("/a");
		expect(resolveHome({}, { TOBOR_HOME: "/b" })).toBe("/b");
		expect(resolveHome({}, {})).toBe(join(homedir(), ".local/share/tobor"));
		expect(resolveHome({ home: "~/t" }, {})).toBe(join(homedir(), "t"));
	});

	it("lays out the home tree", () => {
		const p = paths(HOME);
		expect(p.db).toBe("/srv/tobor/tobor.sqlite");
		expect(p.config).toBe("/srv/tobor/.tobor/config.yml");
		expect(p.artifactsFeed).toBe("/srv/tobor/artifacts/feed.jsonl");
	});
});

describe("parsers", () => {
	it("parses durations", () => {
		expect(parseDuration("30m")).toBe(1_800_000);
		expect(parseDuration("12h")).toBe(43_200_000);
		expect(parseDuration("1h30m")).toBe(5_400_000);
		expect(parseDuration("30")).toBeUndefined();
		expect(parseDuration("3x")).toBeUndefined();
	});

	it("parses listen addresses", () => {
		expect(parseListen("0.0.0.0:7879")).toEqual({ host: "0.0.0.0", port: 7879 });
		expect(parseListen("[::1]:80")).toEqual({ host: "::1", port: 80 });
		expect(parseListen("7879")).toEqual({ host: "127.0.0.1", port: 7879 });
		expect(parseListen("host:99999")).toBeUndefined();
	});
});

describe("loadConfig validation", () => {
	it("accepts the design example", () => {
		const { config, errors } = parseConfigText(
			`roots: [~/repos]
env_file: agent.env
listen: 0.0.0.0:7879
artifacts_listen: 0.0.0.0:7880
public_url: http://host:7879
artifacts_url: http://host:7880
allowed_hosts: [host, host:7879, host:7880]
allowed_origins: [http://host:7879]
notify: { ntfy: { url: https://ntfy.sh, topic: tobor-x }, on: [approval, error, settled] }
defaults:
  model: anthropic/claude-opus-5-5
  thinking: high
  approval_mode: ask
  max_turns: 100
  mode: director
  max_workers: 8
  idle: 30m
  approval_timeout: 12h
retention: { context: 30d, documents: 90d }
mcp: { approval: { github: { allow: [list_issues], ask: [create_issue] } } }
artifacts: { theme: retro-log }
`,
			HOME,
		);
		expect(errors).toEqual([]);
		expect(config.roots).toEqual([join(homedir(), "repos")]);
		expect(config.env_file).toBe("/srv/tobor/agent.env");
		expect(config.defaults.idle).toBe(1_800_000);
		expect(config.retention.documents).toBe(90 * 86_400_000);
		expect(config.mcp.approval.github).toEqual({ allow: ["list_issues"], ask: ["create_issue"] });
	});

	it("applies defaults to an empty file", () => {
		const { config, errors } = parseConfigText("", HOME);
		expect(errors).toEqual([]);
		expect(config.roots).toEqual([HOME]);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 7879 });
		expect(config.artifacts_listen.port).toBe(7880);
		expect(config.allowed_origins).toEqual(["http://127.0.0.1:7879"]);
		expect(config.defaults).toMatchObject({ approval_mode: "ask", mode: "director", max_workers: 8 });
	});

	it("reports every problem with its key path", () => {
		const { errors } = parseConfigText(
			"bogus: 1\nenv_file: .tobor/x.env\ndefaults: { idle: 30, mode: x }\nmcp: { approval: { a: 3 } }",
			HOME,
		);
		expect(errors.map((e) => e.path).sort()).toEqual(
			["bogus", "defaults.idle", "defaults.mode", "env_file", "mcp.approval.a"].sort(),
		);
	});

	it("reports YAML syntax errors", () => {
		expect(parseConfigText("a: [", HOME).errors[0]?.message).toMatch(/^YAML:/);
	});
});
