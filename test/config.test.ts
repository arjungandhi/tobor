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
		expect(p.stateDir).toBe("/srv/tobor/.tobor/state");
		expect(p.db).toBe("/srv/tobor/.tobor/state/tobor.sqlite");
		expect(p.auth).toBe("/srv/tobor/.tobor/state/auth.json");
		expect(p.agentEnv).toBe("/srv/tobor/.tobor/state/agent.env");
		expect(p.nodeJson).toBe("/srv/tobor/.tobor/state/node.json");
		expect(p.config).toBe("/srv/tobor/.tobor/config.yml");
		expect(p.artifactsFeed).toBe("/srv/tobor/.tobor/state/artifacts/feed.jsonl");
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
		expect(config.env_file).toBe("/srv/tobor/.tobor/state/agent.env");
		expect(config.defaults.idle).toBe(1_800_000);
		expect(config.retention.documents).toBe(90 * 86_400_000);
		expect(config.mcp.approval.github).toEqual({ allow: ["list_issues"], ask: ["create_issue"] });
	});

	it("resolves env_file against the home, the bare default to .tobor/state", () => {
		const envFile = (text: string) => parseConfigText(text, HOME);
		expect(envFile("").config.env_file).toBe("/srv/tobor/.tobor/state/agent.env");
		expect(envFile("env_file: agent.env").config.env_file).toBe("/srv/tobor/.tobor/state/agent.env");
		expect(envFile("env_file: secrets/api.env").config.env_file).toBe("/srv/tobor/secrets/api.env");
		expect(envFile("env_file: .tobor/state/x.env")).toMatchObject({ errors: [], config: { env_file: "/srv/tobor/.tobor/state/x.env" } });
		expect(envFile("env_file: .tobor/x.env").errors.map((e) => e.path)).toEqual(["env_file"]);
	});

	it("applies defaults to an empty file", () => {
		const { config, errors } = parseConfigText("", HOME);
		expect(errors).toEqual([]);
		expect(config.roots).toEqual([HOME]);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 7879 });
		expect(config.artifacts_listen.port).toBe(7880);
		expect(config.defaults).toMatchObject({ approval_mode: "auto", mode: "director", max_workers: 8 });
	});

	it("lets an explicit defaults.approval_mode win over the built-in auto", () => {
		expect(parseConfigText("defaults: { approval_mode: ask }", HOME).config.defaults.approval_mode).toBe("ask");
		expect(parseConfigText("defaults: { mode: solo }", HOME).config.defaults.approval_mode).toBe("auto");
	});

	it("validates defaults.title_model like worker_model", () => {
		const ok = parseConfigText("defaults: { title_model: openai/gpt-mini }", HOME);
		expect(ok.errors).toEqual([]);
		expect(ok.config.defaults.title_model).toBe("openai/gpt-mini");
		expect(parseConfigText("", HOME).config.defaults.title_model).toBeUndefined();
		const bad = parseConfigText("defaults: { title_model: nope }", HOME);
		expect(bad.errors.map((e) => e.path)).toEqual(["defaults.title_model"]);
		expect(bad.config.defaults.title_model).toBeUndefined();
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
