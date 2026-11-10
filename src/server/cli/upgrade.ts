import type { WhoamiResponse } from "../../api/types.js";
import type { CliArgs } from "../../cli.js";
import { ApiClient } from "../../tui/client.js";
import {
	formatCheck,
	mismatchHint,
	RESTART_REMINDER,
	upgradeErrorMessage,
	WAIT_TIMEOUT_MS,
	type WaitResult,
	waitForNode,
} from "../../tui/node-upgrade.js";
import {
	type Address,
	baseUrl,
	configPath,
	formatAddress,
	loadClientConfig,
	migrateLegacy,
	probe,
	resolveStart,
} from "../../tui/workspaces.js";
import { BUILD, VERSION } from "../../version.js";
import { assetFor, downloadAndReplace, fetchLatestRelease, type FetchFn, isNewer, targetFor } from "../release.js";

/** Where a command writes: stdout and stderr by default, captured in tests. */
export type Io = { out: (text: string) => void; err: (text: string) => void };

const stdio: Io = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) };

/** `tobor upgrade [workspace] [--check]`: no workspace upgrades this binary, a workspace upgrades and restarts that node. */
export async function run(args: CliArgs): Promise<number> {
	const check = args.flags.check === true;
	const name = args.positionals[0];
	if (name === undefined) return upgradeLocal({ check });
	const node = resolveNode(name);
	if (typeof node === "string") {
		stdio.err(`tobor upgrade: ${node}\n`);
		return 1;
	}
	return upgradeNode({ ...node, check });
}

/** A workspace name or `host:port` resolved with the client config, as the TUI does; a string is the error. */
export function resolveNode(name: string): { address: Address; label: string } | string {
	const notice = migrateLegacy();
	if (notice) process.stderr.write(`${notice}\n`);
	const start = resolveStart(loadClientConfig(configPath()), name);
	if (start.kind === "workspace") return { address: start.workspace, label: start.workspace.name };
	if (start.kind === "address") return { address: start.address, label: formatAddress(start.address) };
	return `${start.reason ?? `no workspace named ${name}`} (see \`tobor workspace list\`)`;
}

/** The running binary on disk; Linux appends ` (deleted)` to the exec path once the file is replaced. */
function execPath(): string {
	return process.execPath.replace(/ \(deleted\)$/, "");
}

/** Self-update this binary: look up the latest release, download the asset for this arch, verify its sha256, replace atomically. */
export async function upgradeLocal(options: {
	check: boolean;
	io?: Io;
	version?: string;
	build?: string;
	execPath?: string;
	target?: string;
	fetch?: FetchFn;
}): Promise<number> {
	const io = options.io ?? stdio;
	const version = options.version ?? VERSION;
	const build = options.build ?? BUILD;
	if (build === "dev") {
		io.err("tobor upgrade: this is a dev build (running from source); only released binaries can upgrade themselves\n");
		return 1;
	}
	let release;
	try {
		release = await fetchLatestRelease({ userAgent: `tobor/${version}`, ...(options.fetch ? { fetch: options.fetch } : {}) });
	} catch (err) {
		io.err(`tobor upgrade: cannot look up the latest release: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	const available = isNewer(release.version, version);
	if (options.check) {
		io.out(formatCheck({ label: "this binary", version, build, latest: release.version, available, command: "tobor upgrade" }));
		return 0;
	}
	if (!available) {
		io.out(`tobor ${version} is up to date (latest release ${release.version})\n`);
		return 0;
	}
	const target = options.target ?? targetFor();
	const asset = assetFor(release, target);
	if (!asset) {
		io.err(`tobor upgrade: release ${release.version} has no asset for ${target}\n`);
		return 1;
	}
	const dest = options.execPath ?? execPath();
	io.out(`downloading tobor ${release.version} (${asset.name}, ${target})…\n`);
	try {
		await downloadAndReplace(asset.url, dest, asset.sha256, { userAgent: `tobor/${version}`, ...(options.fetch ? { fetch: options.fetch } : {}) });
	} catch (err) {
		io.err(`tobor upgrade: download failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	io.out(`upgraded ${dest}: tobor ${version} -> ${release.version}\n${RESTART_REMINDER}\n`);
	return 0;
}

/** Everything `upgradeNode`/`restartNode` take besides the action. */
export type NodeOptions = {
	address: Address;
	/** Workspace name (or `host:port`) for messages. */
	label: string;
	io?: Io;
	/** Whoami of the node; undefined when it does not answer. Default `probe`. */
	probe?: (address: Address) => Promise<WhoamiResponse | undefined>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
	/** This binary, for the mismatch hint. */
	cli?: { version: string; build: string };
};

/** Upgrade a node over its API (`POST /api/upgrade`), then wait for it to answer again; `--check` only reports. */
export async function upgradeNode(options: NodeOptions & { check: boolean }): Promise<number> {
	const io = options.io ?? stdio;
	const cli = options.cli ?? { version: VERSION, build: BUILD };
	const who = await (options.probe ?? ((a) => probe(a, 5000)))(options.address);
	if (!who) {
		io.err(`tobor upgrade: cannot reach ${options.label} (${formatAddress(options.address)})\n`);
		return 1;
	}
	if (options.check) {
		const latest = who.latest_version;
		io.out(
			formatCheck({ label: options.label, version: who.version, build: who.build, latest, available: who.update_available === true, command: `tobor upgrade ${options.label}` }),
		);
		return 0;
	}
	let res;
	try {
		res = await new ApiClient(baseUrl(options.address)).upgrade();
	} catch (err) {
		io.err(`tobor upgrade: ${options.label}: ${upgradeErrorMessage(err)}\n`);
		return 1;
	}
	if (res.status === "current") {
		io.out(`${options.label}: tobor ${res.version} is up to date (latest release ${res.latest})\n`);
		return 0;
	}
	io.out(`${options.label}: upgrading tobor ${res.version} -> ${res.latest}; waiting for the node to restart…\n`);
	return waitAndReport({ ...options, io, cli }, who, `upgraded to`);
}

/** Restart a node over its API (`POST /api/restart`) and wait for it to answer again. */
export async function restartNode(options: NodeOptions): Promise<number> {
	const io = options.io ?? stdio;
	const cli = options.cli ?? { version: VERSION, build: BUILD };
	const who = await (options.probe ?? ((a) => probe(a, 5000)))(options.address);
	if (!who) {
		io.err(`tobor restart: cannot reach ${options.label} (${formatAddress(options.address)})\n`);
		return 1;
	}
	try {
		await new ApiClient(baseUrl(options.address)).restart();
	} catch (err) {
		io.err(`tobor restart: ${options.label}: ${upgradeErrorMessage(err)}\n`);
		return 1;
	}
	io.out(`${options.label}: restarting; waiting for the node to come back…\n`);
	return waitAndReport({ ...options, io, cli }, who, "restarted, now");
}

async function waitAndReport(options: NodeOptions & { io: Io; cli: { version: string; build: string } }, before: WhoamiResponse, verb: string): Promise<number> {
	const probeFn = options.probe ?? ((a: Address) => probe(a, 1500));
	const result: WaitResult = await waitForNode({
		probe: () => probeFn(options.address),
		before,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.sleep ? { sleep: options.sleep } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	const { io, label } = options;
	if (result.status === "timeout") {
		io.err(`${label}: no answer after ${Math.round((options.timeoutMs ?? WAIT_TIMEOUT_MS) / 1000)}s; the node may still be starting (check \`tobor workspace list\`, or its logs: journalctl --user -u tobor@<name>)\n`);
		return 1;
	}
	const now = result.whoami;
	if (result.status === "unconfirmed") {
		io.err(`${label}: the node kept answering and never went down; cannot confirm the restart (tobor ${now.version}, build ${now.build})\n`);
		return 1;
	}
	io.out(`${label}: ${verb} tobor ${now.version} (build ${now.build})\n`);
	const hint = mismatchHint(options.cli, now);
	if (hint) io.err(`${hint}\n`);
	return 0;
}
