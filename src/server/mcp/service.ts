// McpService: reads node and project `mcp.json`, keeps one client per server, builds the MCP tool module.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerStatus } from "../../api/types.js";
import { validateMcpJson } from "../../config/load.js";
import type { Config, ConfigError, McpServerSpec } from "../../config/schema.js";
import type { EventBus } from "../../events.js";
import type { McpService } from "../../host.js";
import type { ToolModule } from "../../tools/registry.js";
import { isGated, MCP_SERVER_NAME, mcpToolName } from "./approval.js";
import { type McpClientOptions, McpServerClient } from "./client.js";
import { mcpToolModule } from "./register.js";

/** Where a server was configured. */
export type McpSource = "node" | "project";

export type McpServiceOptions = {
	/** Node-level `$TOBOR_HOME/.tobor/mcp.json`. */
	nodeFile: string;
	/** Git root whose `.tobor/mcp.json` merges in (shadowing node servers by name). */
	projectRoot?: string;
	/** `env_file` values for `${VAR}` expansion, read at each reload. */
	env: () => Readonly<Record<string, string>>;
	/** Current node config (for `mcp.approval`). */
	config: () => Config;
	events: EventBus;
	/** Asked before a project server first connects; without it project servers stay disconnected. */
	approveConnect?: (server: string, spec: McpServerSpec) => boolean | Promise<boolean>;
	/** Installs the MCP tool module (reinstalls the `tobor` extension); called after each reload and on tool drift. */
	install: (module: ToolModule) => void;
	client?: McpClientOptions;
};

type Entry = { source: McpSource; spec: McpServerSpec; key: string; client?: McpServerClient; error?: string };

/** The node's MCP clients; every reload or tool-list change hands the new tool module to `install`. */
export class McpServiceImpl implements McpService {
	/** Problems found in `mcp.json` files at the last reload. */
	errors: ConfigError[] = [];
	private entries = new Map<string, Entry>();
	private reloading: Promise<void> = Promise.resolve();
	private installed = "";
	private closed = false;
	private busy = false;

	constructor(private readonly options: McpServiceOptions) {}

	status(): McpServerStatus[] {
		return [...this.entries].map(([name, e]) => row(name, e));
	}

	/** The tool module for the current clients. */
	toolModule(): ToolModule {
		return mcpToolModule(this.clients());
	}

	needsApproval(toolName: string): boolean {
		const project = new Set([...this.entries].filter(([, e]) => e.source === "project").map(([n]) => n));
		return isGated(toolName, this.options.config().mcp.approval, project);
	}

	/** Re-read both files, reconnect changed servers, then `install` the new tool module. Calls are serialized. */
	reload(): Promise<void> {
		this.reloading = this.reloading.catch(() => undefined).then(() => this.doReload());
		return this.reloading;
	}

	async close(): Promise<void> {
		this.closed = true;
		const clients = this.clients();
		this.entries.clear();
		await Promise.all(clients.map((c) => c.close()));
	}

	private async doReload(): Promise<void> {
		if (this.closed) return;
		this.busy = true;
		try {
			await this.apply();
		} finally {
			this.busy = false;
		}
		this.installed = signature(this.clients());
		this.options.install(this.toolModule());
	}

	private async apply(): Promise<void> {
		const errors: ConfigError[] = [];
		const wanted = new Map<string, { source: McpSource; spec: McpServerSpec; error?: string }>();
		const files: [McpSource, string][] = [["node", this.options.nodeFile]];
		if (this.options.projectRoot) files.push(["project", join(this.options.projectRoot, ".tobor", "mcp.json")]);
		const env = this.options.env();
		for (const [source, file] of files) {
			for (const [name, spec] of Object.entries(await readServers(file, errors))) {
				if (!MCP_SERVER_NAME.test(name)) {
					errors.push({ path: `${file}: servers.${name}`, message: "name must be letters, digits, - and single _" });
					continue;
				}
				const expanded = expandSpec(spec, env);
				wanted.set(name, { source, ...expanded });
			}
		}
		this.errors = errors;

		const starts: Promise<void>[] = [];
		const closes: Promise<void>[] = [];
		const next = new Map<string, Entry>();
		for (const [name, w] of wanted) {
			const key = JSON.stringify([w.source, w.spec]);
			const old = this.entries.get(name);
			if (old && old.key === key && old.client && !w.error) {
				next.set(name, old);
				continue;
			}
			if (old?.client) closes.push(old.client.close());
			const entry: Entry = { source: w.source, spec: w.spec, key };
			next.set(name, entry);
			if (w.error) {
				entry.error = w.error;
				continue;
			}
			if (w.source === "project" && !(await this.options.approveConnect?.(name, w.spec))) {
				entry.error = "project server awaiting approval to connect";
				continue;
			}
			entry.client = new McpServerClient(name, w.spec, {
				...this.options.client,
				onChange: (c) => this.changed(name, c),
			});
			starts.push(entry.client.start());
		}
		for (const [name, old] of this.entries) if (!next.has(name) && old.client) closes.push(old.client.close());
		this.entries = next;
		for (const [name, e] of next) if (!e.client) this.options.events.emit({ type: "mcp.status", status: row(name, e) });
		await Promise.all([...starts, ...closes]);
	}

	private changed(name: string, client: McpServerClient): void {
		const entry = this.entries.get(name);
		if (entry?.client !== client) return;
		this.options.events.emit({ type: "mcp.status", status: row(name, entry) });
		const sig = signature(this.clients());
		if (this.busy || sig === this.installed) return;
		this.installed = sig;
		this.options.install(this.toolModule());
	}

	private clients(): McpServerClient[] {
		return [...this.entries.values()].flatMap((e) => (e.client ? [e.client] : []));
	}
}

/** Replace `${VAR}` in every string of a server spec; an unknown variable is an error for that server. */
export function expandSpec(
	spec: McpServerSpec,
	env: Readonly<Record<string, string>>,
): { spec: McpServerSpec; error?: string } {
	const missing = new Set<string>();
	const sub = (s: string) =>
		s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, v: string) => {
			if (Object.hasOwn(env, v)) return env[v]!;
			missing.add(v);
			return "";
		});
	const map = (r: Record<string, string> | undefined) =>
		r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sub(v)]));
	const out: McpServerSpec =
		spec.type === "stdio"
			? {
					type: "stdio",
					command: sub(spec.command),
					...(spec.args ? { args: spec.args.map(sub) } : {}),
					...(spec.env ? { env: map(spec.env)! } : {}),
				}
			: { type: "http", url: sub(spec.url), ...(spec.headers ? { headers: map(spec.headers)! } : {}) };
	if (missing.size === 0) return { spec: out };
	return { spec: out, error: `undefined variable${missing.size > 1 ? "s" : ""} ${[...missing].join(", ")} (env_file)` };
}

async function readServers(file: string, errors: ConfigError[]): Promise<Record<string, McpServerSpec>> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ path: file, message: (err as Error).message });
		return {};
	}
	let raw: unknown;
	try {
		raw = text.trim() === "" ? {} : JSON.parse(text);
	} catch (err) {
		errors.push({ path: file, message: `JSON: ${(err as Error).message}` });
		return {};
	}
	const result = validateMcpJson(raw);
	for (const e of result.errors) errors.push({ path: `${file}: ${e.path}`, message: e.message });
	return result.mcp.servers;
}

function row(name: string, e: Entry): McpServerStatus {
	const c = e.client;
	const toolNames = c ? [...new Set(c.tools.map((t) => mcpToolName(name, t.name)))] : [];
	const error = c ? c.error : e.error;
	return {
		server: name,
		type: e.spec.type,
		status: c ? c.status : "error",
		...(error ? { error } : {}),
		tools: toolNames.length,
		toolNames,
	};
}

function signature(clients: McpServerClient[]): string {
	return JSON.stringify(clients.map((c) => [c.name, c.tools]));
}
