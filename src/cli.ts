#!/usr/bin/env node
// `tobor <command>`, bare `tobor [workspace|host:port]` being `tobor tui`: hand-rolled argument parsing; each command module is
// imported lazily so `tobor tui` never loads the server and vice versa. Command modules export `run(args: CliArgs): Promise<number | void>`.
import { resolveHome } from "./config/home.js";
import { MIN_NODE, nodeSupported, PI_DURABLE_VERSION, VERSION } from "./version.js";

/** Parsed command line handed to a command module. */
export type CliArgs = {
	/** Resolved absolute `$TOBOR_HOME` (`--home`, `TOBOR_HOME`, `~/.local/share/tobor`). */
	home: string;
	/** Positional arguments after the command name. */
	positionals: string[];
	/** `--name value`, `--name=value` (value flags) or `--name` (boolean flags). */
	flags: Record<string, string | boolean>;
};

/** One subcommand: its usage line, arity and lazily imported module. */
type Command = {
	usage: string;
	summary: string;
	/** Flags that take a value, besides the global `--home`. */
	valueFlags?: string[];
	/** Exact positional count range. */
	positionals: [min: number, max: number];
	load?: () => Promise<{ run(args: CliArgs): Promise<number | void> }>;
};

const COMMANDS: Record<string, Command> = {
	init: {
		usage: "tobor init [--home DIR]",
		summary: "create $TOBOR_HOME, the .tobor repo skeleton and node.json",
		positionals: [0, 0],
		load: () => import("./server/cli/init.js"),
	},
	node: {
		usage: "tobor node [--home DIR]",
		summary: "run the node (HTTP+WS API and artifacts listener)",
		positionals: [0, 0],
		load: () => import("./server/cli/node.js"),
	},
	login: {
		usage: "tobor login <provider> [--home DIR]",
		summary: "log in to a model provider (anthropic: Claude Pro/Max OAuth)",
		positionals: [1, 1],
		load: () => import("./server/cli/login.js"),
	},
	tui: {
		usage: "tobor tui [workspace|host:port]",
		summary: "terminal client (same as bare `tobor`)",
		positionals: [0, 1],
		load: () => import("./tui/main.js"),
	},
	workspace: {
		usage: "tobor workspace list|add <name> <host:port>|remove <name>|use <name>",
		summary: "manage saved nodes in ~/.config/tobor/config.yml (`use` sets the default)",
		positionals: [1, 3],
		load: () => import("./tui/workspace-cli.js"),
	},
	backup: {
		usage: "tobor backup <file> [--home DIR]",
		summary: "copy tobor.sqlite with VACUUM INTO",
		positionals: [1, 1],
		load: () => import("./server/cli/backup.js"),
	},
	version: {
		usage: "tobor version",
		summary: "print versions",
		positionals: [0, 0],
	},
};

/** Bare `tobor [workspace|host:port]` runs the TUI. */
const BARE = {
	usage: "tobor [workspace|host:port]",
	summary: "terminal client: the named workspace, else $TOBOR_WORKSPACE, else a workspace picker",
};

function help(): string {
	const rows = [BARE, ...Object.values(COMMANDS)];
	const width = Math.max(...rows.map((c) => c.usage.length));
	const lines = rows.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
	return `tobor ${VERSION}: remote agent harness\n\nUsage:\n${lines.join("\n")}\n\nGlobal flags:\n  --home DIR   $TOBOR_HOME (default: TOBOR_HOME, then ~/.local/share/tobor)\n  -h, --help   show help\n\nClient config: $XDG_CONFIG_HOME/tobor/config.yml (workspaces, default, preferences);\nstate: $XDG_STATE_HOME/tobor/state.json. TOBOR_WORKSPACE picks the workspace when none is given.\n`;
}

/** Thrown for usage errors; printed with the command's usage line and exit code 2. */
class UsageError extends Error {}

/** `parseArgs` result: `CliArgs` before home resolution (`home` is the raw `--home` value). */
type ParsedArgs = Omit<CliArgs, "home"> & { home?: string };

/** Parse `argv` (without node and script) for one command. */
function parseArgs(command: Command, argv: string[]): ParsedArgs {
	const valueFlags = new Set(["home", ...(command.valueFlags ?? [])]);
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "-h") {
			flags.help = true;
		} else if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
			if (valueFlags.has(name)) {
				const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
				if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
				flags[name] = value;
			} else if (name === "help") {
				flags.help = true;
			} else {
				throw new UsageError(`unknown flag --${name}`);
			}
		} else if (arg.startsWith("-") && arg !== "-") {
			throw new UsageError(`unknown flag ${arg}`);
		} else {
			positionals.push(arg);
		}
	}
	const [min, max] = command.positionals;
	if (!flags.help && (positionals.length < min || positionals.length > max)) {
		throw new UsageError(positionals.length < min ? "missing argument" : `unexpected argument ${positionals[max]}`);
	}
	const home = typeof flags.home === "string" ? flags.home : undefined;
	delete flags.home;
	return { positionals, flags, ...(home ? { home } : {}) };
}

/** A workspace name, `host:port` or a URL: a bare `tobor <target>` opens the TUI on it (anything else is an unknown command). */
function looksLikeTarget(arg: string): boolean {
	return /^[a-z0-9][a-z0-9_-]*$/.test(arg) || arg.includes(":") || arg.includes(".");
}

/** Entry point; returns the process exit code. */
async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (name === "help" || name === "-h" || name === "--help") {
		process.stdout.write(help());
		return 0;
	}
	if (name === "--version") return main(["version"]);
	// No subcommand (nothing, a flag such as --home, a workspace name or host:port): the TUI.
	if (name === undefined || (name.startsWith("-") && name !== "-") || (!Object.hasOwn(COMMANDS, name) && looksLikeTarget(name))) return main(["tui", ...argv]);
	const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
	if (!command) {
		process.stderr.write(`tobor: unknown command ${JSON.stringify(name)}\n\n${help()}`);
		return 2;
	}
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(command, rest);
	} catch (err) {
		if (!(err instanceof UsageError)) throw err;
		process.stderr.write(`tobor ${name}: ${err.message}\nusage: ${command.usage}\n`);
		return 2;
	}
	if (parsed.flags.help) {
		process.stdout.write(`usage: ${command.usage}\n  ${command.summary}\n`);
		return 0;
	}
	if (name === "version") {
		process.stdout.write(`tobor ${VERSION}\npi-durable ${PI_DURABLE_VERSION}\nnode ${process.versions.node}\n`);
		return 0;
	}
	if (!nodeSupported()) {
		process.stderr.write(`tobor: Node >= ${MIN_NODE.join(".")} is required (running ${process.versions.node})\n`);
		return 1;
	}
	const args: CliArgs = { home: resolveHome({ home: parsed.home }), positionals: parsed.positionals, flags: parsed.flags };
	const mod = await command.load!();
	const code = await mod.run(args);
	return typeof code === "number" ? code : 0;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`tobor: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exitCode = 1;
	},
);
