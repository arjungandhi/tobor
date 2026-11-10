// Everything `tobor node` plugs into boot: the tool modules (built before the Harness opens), the services they read
// lazily, approval predicates, post-open startup, and the two listeners.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ArtifactsService } from "../artifacts/service.js";
import { createArtifactHandler } from "../artifacts/viewer.js";
import { paths as homePaths } from "../config/home.js";
import { formatListen, loadConfig, parseProjectConfig } from "../config/load.js";
import type { Config, ListenAddress } from "../config/schema.js";
import { EventBus } from "../events.js";
import type { Host } from "../host.js";
import { toolModules } from "../tools/index.js";
import { AgentData } from "./agentdata.js";
import { type CoreServices, type NodePlugins, readNodeJson } from "./harness/boot.js";
import { loadEnvFile } from "./harness/env.js";
import { Schedules } from "./harness/schedules/service.js";
import { Workers } from "./harness/workers/service.js";
import { taskSpawnsAutoWorker } from "./harness/workers/tools.js";
import { type Listener, startApi, startArtifactsListener } from "./http/server.js";
import { McpServiceImpl } from "./mcp/service.js";
import { NtfyNotifier } from "./notify/ntfy.js";

/** A node's plugins plus what `tobor node` needs around them. */
export type BuiltPlugins = {
	plugins: NodePlugins;
	/** Bound addresses once `listen` ran (port 0 resolved). */
	addresses(): { api?: ListenAddress; artifacts?: ListenAddress };
	/** Stop background work that outlives the listeners (the `.tobor/` watcher). */
	stop(): Promise<void>;
};

/** Build the node's plugins for `home`. Services that need the open Harness read it from boot's core lazily. */
export async function buildPlugins(home: string): Promise<BuiltPlugins> {
	const paths = homePaths(home);
	const events = new EventBus();
	const ntfyTopic = (await readNodeJson(paths.nodeJson))?.ntfyTopic;
	let core: CoreServices | undefined;
	const opened = (): CoreServices => {
		if (!core) throw new Error("node services used before the Harness opened");
		return core;
	};
	const config = (): Config => opened().config();

	const agentData = new AgentData({ home, paths, config, events });
	const notify = new NtfyNotifier({ config, topic: () => ntfyTopic });
	const artifacts = new ArtifactsService({ paths, events, artifactsUrl: () => config().artifacts_url });
	const workers = new Workers(opened);
	const schedules = new Schedules(() => {
		const c = opened();
		return {
			harness: c.harness,
			ctx: c.ctx,
			config: c.config(),
			events,
			notify,
			systemConversationId: c.systemConversationId,
			sessions: c.sessions,
		};
	});
	const modules = toolModules({
		home,
		artifacts: { service: artifacts, nodeDesignsDir: paths.designSystemsDir, theme: (cwd) => projectTheme(config(), cwd) },
		workers: () => ({ harness: opened().harness, config: config(), events, agentData }),
		schedules,
	});

	let envVars: Record<string, string> = {};
	let mcp: McpServiceImpl | undefined;
	const reloadMcp = async (host: Host) => {
		envVars = await loadEnvFile(host.config.env_file);
		await mcp?.reload();
		for (const e of mcp?.errors ?? []) console.error(`tobor: mcp: ${e.path}: ${e.message}`);
	};
	const onCommitted = async (host: Host, changed: readonly string[]) => {
		if (changed.includes("config.yml")) {
			const loaded = await loadConfig(home);
			for (const e of loaded.errors) console.error(`tobor: ${paths.config}: ${e.path || "(file)"}: ${e.message}`);
			host.config = loaded.config;
		}
		if (changed.includes("mcp.json")) await reloadMcp(host);
	};

	const listeners: { api?: Listener; artifacts?: Listener } = {};
	const plugins: NodePlugins = {
		modules,
		events,
		services: (c) => {
			core = c;
			mcp = new McpServiceImpl({
				nodeFile: paths.mcp,
				env: () => envVars,
				config: c.config,
				events,
				install: (module) => c.installTools([module]),
			});
			return { workers, schedules, artifacts, mcp, agentData, notify };
		},
		gates: {
			task: async (args, conversationId) => {
				const c = opened();
				const conversation = await c.harness.conversation(conversationId as ConversationId, c.ctx);
				const cwd = (await conversation?.agent(c.ctx))?.cwd;
				return cwd !== undefined && taskSpawnsAutoWorker(args, cwd, (dir) => agentData.listAgents(dir));
			},
		},
		afterOpen: [
			async (host) => {
				const chrome = await artifacts.init();
				if (!chrome.found) console.error(`tobor: no Chrome/Chromium found; artifact PDFs are unavailable`);
				await agentData.watch();
				events.on("agent.committed", (event) => {
					onCommitted(host, event.paths).catch((error: unknown) =>
						console.error("tobor: applying a .tobor commit failed:", error),
					);
				});
				await reloadMcp(host).catch((error: unknown) => console.error("tobor: loading mcp.json failed:", error));
				await schedules.reconcile();
			},
		],
		listen: async (host) => {
			listeners.api = await startApi(host);
			try {
				listeners.artifacts = await startArtifactsListener(host, createArtifactHandler(artifacts));
			} catch (error) {
				await listeners.api.close();
				throw new Error(`artifacts listener on ${formatListen(host.config.artifacts_listen)}: ${String(error)}`);
			}
			return async () => {
				await Promise.all([listeners.api?.close(), listeners.artifacts?.close()]);
			};
		},
	};
	return {
		plugins,
		addresses: () => ({ api: listeners.api?.address, artifacts: listeners.artifacts?.address }),
		stop: () => agentData.stop(),
	};
}

/** `artifacts.theme` for a cwd: the project overlay of its git root, else the node config. */
function projectTheme(config: Config, cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) {
			const file = join(dir, ".tobor", "config.yml");
			if (!existsSync(file)) return config.artifacts.theme;
			return parseProjectConfig(readFileSync(file, "utf8")).config.artifacts?.theme ?? config.artifacts.theme;
		}
		if (dirname(dir) === dir) return config.artifacts.theme;
	}
}
