// `tobor node` wiring: buildPlugins + boot over memory storage and faux models (no listeners, no real model).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig, parseConfigText } from "../../src/config/load.js";
import { initHome } from "../../src/server/cli/init.js";
import { type BootedHost, boot } from "../../src/server/harness/boot.js";
import { parseAgentFile } from "../../src/server/harness/workers/agents.js";
import { resolveWorkerModel } from "../../src/server/harness/workers/tools.js";
import { type BuiltPlugins, buildPlugins } from "../../src/server/plugins.js";
import { fauxModels, tempHome } from "../harness/helpers.js";

const fixture = fileURLToPath(new URL("../mcp/fixtures/echo-server.ts", import.meta.url));
const running: { host: BootedHost; built: BuiltPlugins }[] = [];

afterEach(async () => {
	for (const { host, built } of running.splice(0)) {
		await built.stop();
		await host.shutdown();
	}
});

async function start(): Promise<{ host: BootedHost; home: string }> {
	const { home } = await tempHome();
	await initHome(home);
	const built = await buildPlugins(home);
	const host = await boot({ home, storage: new MemoryStorage(), models: fauxModels().models, plugins: built.plugins });
	running.push({ host, built });
	return { host, home };
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

const toolNames = (host: BootedHost) => host.registry.snapshot().tools().map((t) => t.tool.name);

describe("node plugins", () => {
	it("installs every built-in tool and plugs every service", async () => {
		const { host } = await start();
		expect(toolNames(host)).toEqual(
			expect.arrayContaining([
				"bash",
				"read",
				"edit",
				"write",
				"todo",
				"artifact_create",
				"artifact_publish",
				"artifact_list",
				"artifact_export",
				"task",
				"wait",
				"agent_output",
				"schedule_create",
				"schedule_list",
				"schedule_delete",
			]),
		);
		expect((await host.agentData.listAgents()).map((a) => a.name)).toEqual(["fast", "reviewer", "scout", "worker"]);
		expect(await host.schedules.list()).toEqual([]);
		expect(host.mcp.status()).toEqual([]);
		expect(host.notify.enabled("approval")).toBe(false);
	});

	it("reloads config.yml and mcp.json when .tobor/ commits change them", async () => {
		const { host, home } = await start();
		const config = await readFile(join(home, ".tobor", "config.yml"), "utf8");
		await host.agentData.write("config.yml", { content: `${config}agents: { model_overrides: { fast: faux/m } }\n` });
		await until(() => host.config.agents.model_overrides.fast === "faux/m");

		const mcp = { servers: { echo: { type: "stdio", command: process.execPath, args: [fixture, "--stdio"] } } };
		await host.agentData.write("mcp.json", { content: JSON.stringify(mcp) });
		await until(() => toolNames(host).some((n) => n.startsWith("mcp__echo__")));
		expect(toolNames(host)).toContain("bash");
		expect(host.mcp.status()[0]).toMatchObject({ server: "echo", status: "connected" });
	});
});

describe("worker models", () => {
	const config = validateConfig({ defaults: { worker_model: "anthropic/claude-haiku-5-5" } }, "/h").config;
	config.agents.model_overrides.worker = "anthropic/claude-opus-5-5";

	it("prefers the task item, then the override, then the agent file, then defaults.worker_model", () => {
		const worker = { name: "worker", model: "anthropic/claude-sonnet-5-5" };
		expect(resolveWorkerModel({ model: "faux/m" }, worker, config)).toBe("faux/m");
		expect(resolveWorkerModel({}, worker, config)).toBe("anthropic/claude-opus-5-5");
		expect(resolveWorkerModel({}, { name: "fast", model: "anthropic/claude-sonnet-5-5" }, config)).toBe(
			"anthropic/claude-sonnet-5-5",
		);
		expect(resolveWorkerModel({}, { name: "scout" }, config)).toBe("anthropic/claude-haiku-5-5");
		expect(resolveWorkerModel({}, { name: "scout" }, validateConfig(undefined, "/h").config)).toBeUndefined();
	});

	it("validates agents.model_overrides and defaults.worker_model", () => {
		const { config: parsed, errors } = parseConfigText(
			"defaults: { worker_model: nope }\nagents: { model_overrides: { fast: also-bad, worker: a/b }, extra: 1 }\n",
			"/h",
		);
		expect(errors.map((e) => e.path).sort()).toEqual(["agents.extra", "agents.model_overrides.fast", "defaults.worker_model"]);
		expect(parsed.agents.model_overrides).toEqual({ worker: "a/b" });
		expect(parsed.defaults.worker_model).toBeUndefined();
	});

	it("ships skeleton agents whose models exist in the catalog", async () => {
		const { home } = await tempHome();
		await initHome(home);
		const catalog = builtinModels();
		const tiers: Record<string, string> = {};
		for (const name of ["worker", "fast", "scout", "reviewer"]) {
			const path = join(home, ".tobor", "agents", `${name}.md`);
			const { agent } = parseAgentFile(await readFile(path, "utf8"), path, "node");
			const [provider, id] = agent!.model!.split("/") as [string, string];
			expect(catalog.getModel(provider, id), agent!.model).toBeDefined();
			tiers[name] = agent!.model!;
		}
		expect(tiers).toEqual({
			worker: "anthropic/claude-sonnet-5-5",
			fast: "anthropic/claude-haiku-5-5",
			scout: "anthropic/claude-haiku-5-5",
			reviewer: "anthropic/claude-sonnet-5-5",
		});
	});
});
