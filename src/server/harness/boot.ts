import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	createRegistry,
	Harness,
	type HarnessSettings,
	type Report,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type NodeJson, paths as homePaths } from "../../config/home.js";
import { loadConfig } from "../../config/load.js";
import { ensureStateDir, migrateHomeLayout } from "../../config/migrate.js";
import { type Config, RESTART_LIMIT } from "../../config/schema.js";
import { TOBOR_DOCS } from "../../docs.js";
import { EventBus } from "../../events.js";
import { type Host, HostError } from "../../host.js";
import { composeExtension, type ToolModule } from "../../tools/registry.js";
import { BUILD, bunSupported, MIN_BUN, PI_DURABLE_VERSION, RUNTIME, VERSION } from "../../version.js";
import { AuthService } from "../auth.js";
import { ApprovalService, type GatePredicate } from "./approvals.js";
import { FileCredentialStore } from "./credentials.js";
import { EnvCache, loadEnvFile } from "./env.js";
import { createModels } from "./models.js";
import { QuestionService } from "./questions/service.js";
import { questionsModule } from "./questions/tool.js";
import { createSections } from "./sections.js";
import { SessionIndex } from "./sessions.js";

/** Services boot builds itself; plugins receive them to build the rest. */
export type CoreServices = {
	readonly home: string;
	readonly paths: Host["paths"];
	readonly config: () => Config;
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly registry: Host["registry"];
	readonly ctx: Context;
	readonly systemConversationId: number;
	readonly events: EventBus;
	readonly sessions: SessionIndex;
	readonly approvals: ApprovalService;
	readonly questions: QuestionService;
	readonly auth: AuthService;
	readonly credentials: FileCredentialStore;
	readonly env: EnvCache;
	/** Recompose and reinstall the `tobor` extension with `extra` modules after the plugin modules (MCP reloads). */
	readonly installTools: (extra: readonly ToolModule[]) => void;
};

/** Host services contributed by other modules. */
export type PluggableServices = Pick<Host, "workers" | "schedules" | "artifacts" | "mcp" | "agentData" | "notify">;

/** What the integrator plugs into boot. */
export type NodePlugins = {
	/** Tool modules composed after the core module (its sections and approval hook come first). */
	modules: ToolModule[];
	/** The bus the modules were built against (they exist before boot); default a new one. */
	events?: EventBus;
	/** Build the pluggable services once the Harness is open. */
	services?: (core: CoreServices) => Partial<PluggableServices>;
	/** Run in order after the Host is assembled (schedule reconcile, notifier re-waits, …). */
	afterOpen?: ((host: Host) => Promise<void>)[];
	/** Approval predicates per tool (e.g. `task` spawning an `auto` worker). */
	gates?: Record<string, GatePredicate>;
	/** Start the listeners; returns a function that stops them (used by `tobor node`). */
	listen?: (host: Host) => Promise<() => Promise<void>>;
};

/** Inputs of `boot`. `storage`/`models` replace SQLite and the built-in catalog (tests). */
export type BootOptions = {
	home: string;
	plugins?: NodePlugins;
	storage?: Storage;
	models?: MutableModels;
	/** Receives pi-durable reports; default logs to stderr. */
	onReport?: (report: Report) => void;
};

/** A booted node: the `Host` plus its shutdown. */
export interface BootedHost extends Host {
	readonly core: CoreServices;
	/**
	 * Cancel `ctx` and release resources. With approvals or questions pending the Harness is left open (closing would settle their
	 * waits), so the process must exit right after; otherwise the Harness is closed.
	 */
	shutdown(): Promise<"closed" | "left_open">;
}

/** Boot sequence (design: Node process components): config, models, registry, open, resume, system conversation. */
export async function boot(options: BootOptions): Promise<BootedHost> {
	if (!bunSupported()) throw new Error(`Bun >= ${MIN_BUN} is required (running ${RUNTIME})`);
	const plugins: NodePlugins = options.plugins ?? { modules: [] };
	const home = options.home;
	const paths = homePaths(home);
	await mkdir(home, { recursive: true, mode: 0o700 });
	await migrateHomeLayout(home);
	await ensureStateDir(home);

	const loaded = await loadConfig(home);
	for (const e of loaded.errors) console.error(`tobor: ${paths.config}: ${e.path || "(file)"}: ${e.message}`);
	let config = loaded.config;
	const getConfig = () => config;
	const envVars = await loadEnvFile(config.env_file);

	const credentials = new FileCredentialStore(paths.auth);
	const models = options.models ?? createModels({ credentials, env: envVars });
	const events = plugins.events ?? new EventBus();
	let plugged: Partial<PluggableServices> = {};
	const approvals = new ApprovalService({
		events,
		config: getConfig,
		notify: () => plugged.notify,
		mcpNeedsApproval: () => plugged.mcp && ((tool: string) => plugged.mcp!.needsApproval(tool)),
		gates: plugins.gates ?? {},
	});
	const questions = new QuestionService({ events, config: getConfig, notify: () => plugged.notify });
	const coreModule: ToolModule = {
		tools: [],
		sections: createSections(paths),
		hooks: approvals.module().hooks ?? [],
		docs: [...TOBOR_DOCS],
	};
	const registry = createRegistry();
	const installTools = (extra: readonly ToolModule[]) =>
		registry.install(composeExtension("tobor", [coreModule, questionsModule(() => questions), ...plugins.modules, ...extra]));
	installTools([]);

	const env = new EnvCache({ shellEnv: envVars, idleMs: () => config.defaults.idle });
	const settings = (): HarnessSettings => ({
		restartLimit: RESTART_LIMIT,
		toolExecution: "sequential",
		afterFailedRun: "withdraw",
		contextRetentionMs: config.retention.context,
		documentRetentionMs: config.retention.documents,
	});
	const storage = options.storage ?? (await openNodeSqliteStorage(paths.db));
	const harness = await Harness.open(
		storage,
		{ models, registry, env: env.env, settings, onReport: options.onReport ?? logReport },
		BACKGROUND_CONTEXT,
	);
	approvals.attach(harness);
	questions.attach(harness);

	const { context: ctx, cancel } = withCancel(BACKGROUND_CONTEXT);
	const systemConversationId = await ensureSystemConversation(harness, paths.nodeJson, ctx);
	const sessions = new SessionIndex({
		harness,
		registry,
		models,
		systemConversationId,
		events,
		config: getConfig,
		approvals,
		questions,
		ctx,
	});
	const auth = new AuthService({ models, credentials, config: getConfig });
	const core: CoreServices = {
		home,
		paths,
		config: getConfig,
		harness,
		models,
		registry,
		ctx,
		systemConversationId,
		events,
		sessions,
		approvals,
		questions,
		auth,
		credentials,
		env,
		installTools,
	};
	plugged = plugins.services?.(core) ?? {};

	const host: BootedHost = {
		home,
		paths,
		get config() {
			return config;
		},
		set config(next: Config) {
			config = next;
		},
		harness,
		models,
		registry,
		ctx,
		systemConversationId,
		sessions,
		approvals,
		questions,
		workers: plugged.workers ?? unavailable("workers"),
		schedules: plugged.schedules ?? unavailable("schedules"),
		artifacts: plugged.artifacts ?? unavailable("artifacts"),
		mcp: plugged.mcp ?? unavailable("mcp"),
		auth,
		agentData: plugged.agentData ?? unavailable("agentData"),
		events,
		notify: plugged.notify ?? unavailable("notify"),
		core,
		whoami: () => ({
			host: hostname(),
			version: VERSION,
			build: BUILD,
			pi_durable: PI_DURABLE_VERSION,
			runtime: RUNTIME,
			public_url: config.public_url,
			artifacts_url: config.artifacts_url,
			...(config.notify.ntfy ? { ntfy_topic: config.notify.ntfy.topic } : {}),
			chrome: plugged.artifacts?.chrome() ?? { found: false },
			now: Date.now(),
		}),
		shutdown: async () => {
			cancel(new Error("node shutting down"));
			sessions.stop();
			auth.cancelLogins();
			await plugged.mcp?.close().catch(() => {});
			const pending = await approvals.pending().catch(() => []);
			const asked = await questions.pending().catch(() => []);
			if (pending.length + asked.length > 0) {
				await env.cleanup();
				return "left_open";
			}
			await harness.close(BACKGROUND_CONTEXT);
			await env.cleanup();
			return "closed";
		},
	};

	// Resumed tasks (workers, schedules) read the plugged services, so start them only now.
	harness.resume();
	await sessions.startTracking();
	for (const hook of plugins.afterOpen ?? []) await hook(host);
	return host;
}

/** The system conversation id from `node.json`, creating the conversation (and the file) when absent. */
export async function ensureSystemConversation(harness: Harness, nodeJsonPath: string, ctx: Context): Promise<number> {
	const node = await readNodeJson(nodeJsonPath);
	const known = node?.systemConversationId;
	if (known !== undefined && (await harness.conversation(known as ConversationId, ctx))) return known;
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	await writeNodeJson(nodeJsonPath, { ...node, systemConversationId: conversation.id });
	return conversation.id;
}

/** Parse `node.json`; undefined when absent. */
export async function readNodeJson(path: string): Promise<Partial<NodeJson> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") throw new Error(`${path}: expected a JSON object`);
	return value as Partial<NodeJson>;
}

/** Write `node.json` atomically. */
export async function writeNodeJson(path: string, value: Partial<NodeJson>): Promise<void> {
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

function logReport(report: Report): void {
	const error = report.error instanceof Error ? (report.error.stack ?? report.error.message) : String(report.error);
	console.error(`tobor: pi-durable ${report.kind}: ${error}`);
}

/** A service that is not plugged into this node: every call fails with 503. */
function unavailable<T extends object>(name: string): T {
	return new Proxy({} as T, {
		get: (_target, prop) =>
			prop === "then"
				? undefined
				: () => {
						throw new HostError(503, "unavailable", `${name} is not available on this node`);
					},
	});
}
