// $TOBOR_HOME resolution and the fixed layout under it (design: "Deployment and $TOBOR_HOME layout").
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Flags that influence home resolution. */
export type HomeFlags = { home?: string };

/** Expand a leading `~` or `~/` to the user's home directory; other paths are returned unchanged. */
export function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Resolve `$TOBOR_HOME`: `--home`, then the `TOBOR_HOME` env var, then `~/.local/share/tobor`. Always absolute. */
export function resolveHome(flags: HomeFlags = {}, env: NodeJS.ProcessEnv = process.env): string {
	const raw = flags.home || env.TOBOR_HOME || join(homedir(), ".local", "share", "tobor");
	const expanded = expandTilde(raw);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Every fixed path under `$TOBOR_HOME`. */
export type HomePaths = {
	/** `$TOBOR_HOME` itself. */
	home: string;
	/** `.tobor/state/`: gitignored node state (db, credentials, identity, artifact store); never agent-visible. */
	stateDir: string;
	/** pi-durable SQLite storage (plus `-wal`, `-shm`), under `.tobor/state/`. */
	db: string;
	/** tobor `fileStore` CredentialStore, mode 0600, under `.tobor/state/`. */
	auth: string;
	/** Default `env_file`, under `.tobor/state/` (config may point elsewhere, relative to home). */
	agentEnv: string;
	/** Node identity: system conversation id, ntfy topic (under `.tobor/state/`). */
	nodeJson: string;
	/** Node-level agent data git repo (`state/` inside it is gitignored). */
	toborDir: string;
	/** `.tobor/config.yml`. */
	config: string;
	/** `.tobor/mcp.json`. */
	mcp: string;
	/** `.tobor/AGENTS.md`. */
	agentsMd: string;
	/** `.tobor/RULES.md`. */
	rulesMd: string;
	/** `.tobor/SYSTEM.md` (optional preamble replacement). */
	systemMd: string;
	/** `.tobor/APPEND_SYSTEM.md` (optional preamble suffix). */
	appendSystemMd: string;
	/** `.tobor/agents/` agent definitions. */
	agentsDir: string;
	/** `.tobor/skills/` skill directories. */
	skillsDir: string;
	/** `.tobor/design-systems/` themes. */
	designSystemsDir: string;
	/** Artifact store root, under `.tobor/state/`. */
	artifacts: string;
	/** `artifacts/feed.jsonl` publish feed. */
	artifactsFeed: string;
	/** `artifacts/store/<projectId>/<slug>/<rev>/`. */
	artifactsStore: string;
	/** `artifacts/pdf/<rev>.pdf` render cache. */
	artifactsPdf: string;
};

/** Compute every path of the `$TOBOR_HOME` tree. Pure; creates nothing. */
export function paths(home: string): HomePaths {
	const toborDir = join(home, ".tobor");
	const stateDir = join(toborDir, "state");
	const artifacts = join(stateDir, "artifacts");
	return {
		home,
		stateDir,
		db: join(stateDir, "tobor.sqlite"),
		auth: join(stateDir, "auth.json"),
		agentEnv: join(stateDir, "agent.env"),
		nodeJson: join(stateDir, "node.json"),
		toborDir,
		config: join(toborDir, "config.yml"),
		mcp: join(toborDir, "mcp.json"),
		agentsMd: join(toborDir, "AGENTS.md"),
		rulesMd: join(toborDir, "RULES.md"),
		systemMd: join(toborDir, "SYSTEM.md"),
		appendSystemMd: join(toborDir, "APPEND_SYSTEM.md"),
		agentsDir: join(toborDir, "agents"),
		skillsDir: join(toborDir, "skills"),
		designSystemsDir: join(toborDir, "design-systems"),
		artifacts,
		artifactsFeed: join(artifacts, "feed.jsonl"),
		artifactsStore: join(artifacts, "store"),
		artifactsPdf: join(artifacts, "pdf"),
	};
}

/** Contents of `$TOBOR_HOME/.tobor/state/node.json`, written at first boot. */
export type NodeJson = {
	/** Ownerless system conversation holding `tobor.sessions` and `tobor.schedules` (and owning schedule tasks). */
	systemConversationId: number;
	/** Random ntfy topic suggested by `tobor init` (`tobor-<random>`). */
	ntfyTopic?: string;
};
