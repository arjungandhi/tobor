// Shape of `$TOBOR_HOME/.tobor/config.yml` after validation and defaults (design: "Agent data (.tobor dirs)").
// Keys mirror the YAML exactly; values are normalized: paths absolute, `~` expanded, durations in milliseconds,
// listen addresses parsed.

/** Model thinking level, as pi-ai's `ModelThinkingLevel`. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Per-conversation approval policy: `ask` gates mutating tools, `auto` skips the hook. */
export type ApprovalMode = "ask" | "auto";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto"];

/** Session mode: `director` dispatches workers, `solo` is a single agent with the full tool set. */
export type SessionMode = "director" | "solo";
export const SESSION_MODES: readonly SessionMode[] = ["director", "solo"];

/** Events that trigger an ntfy notification. */
export type NotifyEvent = "approval" | "error" | "settled";
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ["approval", "error", "settled"];

/** A parsed `host:port` listen address. */
export type ListenAddress = { host: string; port: number };

/** Per-server MCP approval policy (`mcp.approval.<server>`). */
export type McpApprovalPolicy = "auto" | "ask" | { allow: string[]; ask: string[] };

/** One MCP server entry in `mcp.json` (`servers.<name>`). */
export type McpServerSpec =
	| { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
	| { type: "http"; url: string; headers?: Record<string, string> };

/** `.tobor/mcp.json` (node or project level). */
export type McpJson = { servers: Record<string, McpServerSpec> };

/** Validated node-level `config.yml` with every default applied. */
export type Config = {
	/** Absolute, `~`-expanded directories a session cwd must realpath inside. */
	roots: string[];
	/** Absolute path of the env file (configured relative to `$TOBOR_HOME`, never inside `.tobor/`). */
	env_file: string;
	/** API listener. */
	listen: ListenAddress;
	/** Artifacts listener; default `listen` host with port + 1. */
	artifacts_listen: ListenAddress;
	/** Base URL clients and notifications use for the API. */
	public_url: string;
	/** Base URL of the artifacts origin. */
	artifacts_url: string;
	/** Accepted `Host` header values on both listeners. */
	allowed_hosts: string[];
	/** Accepted `Origin` values for mutating requests and WS upgrades. */
	allowed_origins: string[];
	/** Notification settings. */
	notify: {
		/** ntfy target; absent disables ntfy. */
		ntfy?: { url: string; topic: string };
		/** Which events notify. */
		on: NotifyEvent[];
	};
	/** Defaults for new sessions. */
	defaults: {
		/** `provider/modelId`. */
		model: string;
		thinking: ThinkingLevel;
		approval_mode: ApprovalMode;
		max_turns: number;
		mode: SessionMode;
		/** Live workers per session. */
		max_workers: number;
		/** `provider/modelId` for workers whose agent file sets no `model`; unset, workers inherit the director's. */
		worker_model?: string;
		/** Idle time (ms) before an env cache entry for a cwd is released. */
		idle: number;
		/** Time (ms) before a pending approval is denied with reason `timeout`. */
		approval_timeout: number;
	};
	/** pi-durable retention, in ms (`contextRetentionMs`, `documentRetentionMs`). */
	retention: { context: number; documents: number };
	/** MCP settings (node-level only). */
	mcp: { approval: Record<string, McpApprovalPolicy> };
	/** Worker agent settings. */
	agents: {
		/** Per agent name, a `provider/modelId` replacing the agent file's `model` (a `task` item `model` still wins). */
		model_overrides: Record<string, string>;
	};
	/** Artifact settings. */
	artifacts: { theme: string };
};

/** The project-level `<git root>/.tobor/config.yml` whitelist. */
export type ProjectConfig = {
	defaults?: { model?: string; thinking?: ThinkingLevel; mode?: SessionMode };
	artifacts?: { theme?: string };
	mcp?: { servers?: Record<string, McpServerSpec> };
};

/** One validation problem; `path` is a dotted key path such as `defaults.idle` (empty for the whole file). */
export type ConfigError = { path: string; message: string };

/** Result of loading or validating a config file: always a usable config, plus any errors found. */
export type ConfigResult = { config: Config; errors: ConfigError[] };

/** Default API port. */
export const DEFAULT_PORT = 7879;
/** Default session model. */
export const DEFAULT_MODEL = "anthropic/claude-opus-5-5";
/** Default cheap model (titles, the `fast` agent). */
export const DEFAULT_CHEAP_MODEL = "anthropic/claude-haiku-5-5";
/** Built-in artifact theme. */
export const DEFAULT_THEME = "retro-log";
/** pi-durable `settings.restartLimit` used by tobor (approval waits count toward it). */
export const RESTART_LIMIT = 50;

/** Split `provider/modelId` into a pi-durable `ModelRef`; undefined when malformed. */
export function parseModelRef(model: string): { provider: string; modelId: string } | undefined {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
