import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { editConfig, getField, modelOverrides, parseNodeConfig, sessionDefaults } from "../../src/tui/node-config.js";

const SKELETON = readFileSync(new URL("../../src/server/skeleton/config.yml", import.meta.url), "utf8");

const SAMPLE = `# node settings
roots: ["/srv/work"]   # (operator)
listen: 127.0.0.1:7879
future_key: { nested: [1, 2], keep: me }   # not known to the TUI

defaults:
  model: anthropic/claude-opus-5-5
  approval_mode: ask            # (operator) ask | auto
  mode: director                # director | solo
  experimental_flag: true
  idle: 30m

retention: { context: 30d, documents: 90d }
`;

describe("editConfig", () => {
	it("changes one value in place, keeping comment columns, blank lines, flow style and unknown keys", () => {
		const text = editConfig(SAMPLE, ["defaults", "mode"], "solo");
		expect(text).toBe(SAMPLE.replace("mode: director                # director | solo", "mode: solo                    # director | solo"));
		const back = editConfig(text, ["defaults", "mode"], "director");
		expect(back).toBe(SAMPLE);
	});

	it("round-trips the init skeleton", () => {
		const solo = editConfig(SKELETON, ["defaults", "mode"], "solo");
		expect(parse(solo).defaults.mode).toBe("solo");
		expect(solo.split("\n").length).toBe(SKELETON.split("\n").length);
		expect(editConfig(solo, ["defaults", "mode"], "director")).toBe(SKELETON);
	});

	it("adds missing keys as block lines and removes them again", () => {
		let text = editConfig(SAMPLE, ["defaults", "max_workers"], 4);
		expect(text).toContain("  idle: 30m\n  max_workers: 4\n\nretention:");
		text = editConfig(text, ["agents", "model_overrides", "worker"], "anthropic/claude-sonnet-5-5");
		expect(text).toContain("retention: { context: 30d, documents: 90d }\nagents:\n  model_overrides:\n    worker: anthropic/claude-sonnet-5-5\n");
		text = editConfig(text, ["notify", "ntfy", "url"], "https://ntfy.sh");
		const doc = parseNodeConfig(text);
		expect(getField(doc, ["defaults", "max_workers"])).toBe("4");
		expect(modelOverrides(doc)).toEqual({ worker: "anthropic/claude-sonnet-5-5" });
		expect(parse(text).notify).toEqual({ ntfy: { url: "https://ntfy.sh" } });

		text = editConfig(text, ["notify", "ntfy", "url"], undefined);
		text = editConfig(text, ["agents", "model_overrides", "worker"], undefined);
		text = editConfig(text, ["defaults", "max_workers"], undefined);
		expect(text).toBe(SAMPLE);
	});

	it("quotes values that would not read back as the same scalar", () => {
		const text = editConfig(SAMPLE, ["defaults", "model"], "a: b # c");
		expect(getField(parseNodeConfig(text), ["defaults", "model"])).toBe("a: b # c");
		expect(text).toContain("future_key: { nested: [1, 2], keep: me }   # not known to the TUI");
	});

	it("falls back to the Document API inside flow maps, keeping unknown keys and comments", () => {
		const text = editConfig(SAMPLE, ["retention", "context"], "60d");
		const data = parse(text);
		expect(data.retention).toEqual({ context: "60d", documents: "90d" });
		expect(data.future_key).toEqual({ nested: [1, 2], keep: "me" });
		expect(data.defaults.experimental_flag).toBe(true);
		expect(text).toContain("# not known to the TUI");
		expect(text).toContain("# director | solo");
	});

	it("is a no-op when deleting a key that is not there", () => {
		expect(editConfig(SAMPLE, ["defaults", "worker_model"], undefined)).toBe(SAMPLE);
	});
});

describe("sessionDefaults", () => {
	it("reads defaults, falling back to auto/director", () => {
		expect(sessionDefaults(parseNodeConfig(SAMPLE))).toEqual({ model: "anthropic/claude-opus-5-5", approval_mode: "ask", mode: "director" });
		expect(sessionDefaults(parseNodeConfig("roots: []\n"))).toEqual({ approval_mode: "auto", mode: "director" });
	});

	it("rejects malformed YAML", () => {
		expect(() => parseNodeConfig("defaults: [\n")).toThrow(/config.yml/);
	});
});
