// The node's update checker, self-upgrade and restart. State (latest-release cache, timer, shutdown hook) lives here;
// the stateless download/verify/replace pieces are in release.ts.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RestartResponse, UpgradeResponse } from "../api/types.js";
import { BUILD, VERSION } from "../version.js";
import { HostError } from "../host.js";
import {
	assetFor,
	downloadAndReplace,
	fetchLatestRelease,
	type FetchFn,
	isNewer,
	isVersion,
	type LatestRelease,
	type ReleaseAsset,
	sha256File,
	targetFor,
} from "./release.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Delay between answering `POST /api/upgrade|restart` and restarting, so the response flushes first. */
export const RESTART_DELAY_MS = 300;
/** Exit code that tells systemd (`RestartForceExitStatus=75` in contrib/tobor@.service) to relaunch the node. */
export const RESTART_EXIT_CODE = 75;

/** The latest release plus when it was looked up (epoch ms). */
export type LatestInfo = LatestRelease & { checkedAt: number };

/** Options of an `UpdateChecker`. */
export type UpdateCheckerOptions = {
	/** Cache file (under the node state dir); a restart reads it back. */
	file: string;
	/** Consulted at each periodic check (config can reload); explicit `refresh()` ignores it. */
	enabled: () => boolean;
	/** Build id; `dev` disables checking and reporting. Default `BUILD`. */
	build?: string;
	/** Running version. Default `VERSION`. */
	version?: string;
	fetch?: FetchFn;
};

/** Fetches the latest GitHub release now and about daily, caching the result in memory and on disk. Never throws. */
export class UpdateChecker {
	private info: LatestInfo | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly build: string;
	private readonly version: string;

	constructor(private readonly options: UpdateCheckerOptions) {
		this.build = options.build ?? BUILD;
		this.version = options.version ?? VERSION;
	}

	/** Read the persisted cache (if any) and start the periodic timer. A no-op for `dev` builds. */
	async start(): Promise<void> {
		if (this.build === "dev") return;
		this.info = await readCache(this.options.file);
		this.stopped = false;
		const age = this.info ? Date.now() - this.info.checkedAt : Number.POSITIVE_INFINITY;
		// Fresh cache: wait out the rest of the day; stale or absent: check within a few minutes of boot.
		const delay = age < DAY_MS ? DAY_MS - age + jitter(DAY_MS / 10) : 30_000 + Math.random() * 270_000;
		this.schedule(delay);
	}

	/** Stop the timer. */
	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** The cached latest release, undefined when never fetched. */
	latest(): LatestInfo | undefined {
		return this.info;
	}

	/** `latest_version` / `update_available` for whoami; empty for `dev` builds, when checks are disabled or nothing is cached. */
	whoami(): { latest_version?: string; update_available?: boolean } {
		if (this.build === "dev" || !this.options.enabled() || !this.info) return {};
		return { latest_version: this.info.version, update_available: isNewer(this.info.version, this.version) };
	}

	/** Look up the latest release now. On failure returns the cached value (or undefined) and logs. */
	async refresh(): Promise<LatestInfo | undefined> {
		try {
			const release = await fetchLatestRelease({ userAgent: `tobor/${this.version}`, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
			this.info = { ...release, checkedAt: Date.now() };
			await writeCache(this.options.file, this.info).catch((err: unknown) => console.error("update: cannot persist cache:", err));
		} catch (err) {
			console.error("update: check failed:", err instanceof Error ? err.message : err);
		}
		return this.info;
	}

	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			void (async () => {
				if (this.options.enabled()) await this.refresh();
				this.schedule(DAY_MS + jitter(DAY_MS / 10));
			})();
		}, delay);
		this.timer.unref?.();
	}
}

/** `x ± spread` offset, uniform in `[-spread, spread]`. */
function jitter(spread: number): number {
	return (Math.random() * 2 - 1) * spread;
}

async function readCache(file: string): Promise<LatestInfo | undefined> {
	try {
		const v: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!v || typeof v !== "object") return undefined;
		const { version, checkedAt, assets } = v as { version?: unknown; checkedAt?: unknown; assets?: unknown };
		if (typeof version !== "string" || !isVersion(version) || typeof checkedAt !== "number" || !Array.isArray(assets)) return undefined;
		const ok = assets.filter(
			(a): a is ReleaseAsset => !!a && typeof a.name === "string" && typeof a.target === "string" && typeof a.sha256 === "string" && typeof a.url === "string",
		);
		return { version, checkedAt, assets: ok };
	} catch {
		return undefined;
	}
}

async function writeCache(file: string, info: LatestInfo): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(info)}\n`);
	await rename(tmp, file);
}

let checker: UpdateChecker | undefined;

/** Create the process-wide checker (boot) and start its timer. Replaces and stops any earlier one. */
export async function startUpdateChecker(options: UpdateCheckerOptions): Promise<UpdateChecker> {
	checker?.stop();
	checker = new UpdateChecker(options);
	await checker.start();
	return checker;
}

/** The process-wide checker, if boot created one. */
export function updateChecker(): UpdateChecker | undefined {
	return checker;
}

/** The binary on disk; Linux appends ` (deleted)` to the exec path once the file is replaced. */
const EXEC_PATH = process.execPath.replace(/ \(deleted\)$/, "");

/**
 * `POST /api/upgrade`: refresh the release info, and when this binary is stale download, verify and replace it, then
 * schedule a restart. Throws `HostError` 400 `unsupported` (dev builds) or 503 (lookup/download failures).
 */
export async function upgradeSelf(
	options: { execPath?: string; version?: string; build?: string; target?: string; restart?: () => void; checker?: UpdateChecker; fetch?: FetchFn } = {},
): Promise<UpgradeResponse> {
	const build = options.build ?? BUILD;
	const version = options.version ?? VERSION;
	const execPath = options.execPath ?? EXEC_PATH;
	if (build === "dev") throw new HostError(400, "unsupported", "upgrade is not supported for dev builds (running from source)");
	const c = options.checker ?? checker;
	if (!c) throw new HostError(503, "unavailable", "update checker is not running");
	const info = await c.refresh();
	if (!info) throw new HostError(503, "update_unavailable", "could not determine the latest release");
	const asset = assetFor(info, options.target ?? targetFor());
	if (!asset) throw new HostError(503, "update_unavailable", `release ${info.version} has no asset for this platform`);
	const upToDate = (await sha256File(execPath)) === asset.sha256;
	if (upToDate && version === info.version) return { status: "current", version, latest: info.version };
	// Never downgrade a newer local build.
	if (!upToDate && !isNewer(info.version, version)) return { status: "current", version, latest: info.version };
	// A binary already on disk but not yet running (replaced earlier, restart pending) only needs the restart.
	if (!upToDate) {
		try {
			await downloadAndReplace(asset.url, execPath, asset.sha256, { userAgent: `tobor/${version}`, ...(options.fetch ? { fetch: options.fetch } : {}) });
		} catch (err) {
			console.error("update: download failed:", err);
			throw new HostError(503, "download_failed", `upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	(options.restart ?? scheduleRestart)();
	return { status: "upgrading", version, latest: info.version };
}

/** `POST /api/restart`: schedule a restart and return the reply. */
export function requestRestart(restart: () => void = scheduleRestart): RestartResponse {
	restart();
	return { status: "restarting" };
}

let shutdownHook: (() => Promise<void>) | undefined;

/** Register how the node stops gracefully (listeners closed, harness closed) before a restart; `tobor node` sets it. */
export function setShutdownHook(hook: (() => Promise<void>) | undefined): void {
	shutdownHook = hook;
}

let restarting = false;

/** Restart the node `RESTART_DELAY_MS` from now (once; later calls are ignored). */
export function scheduleRestart(delayMs: number = RESTART_DELAY_MS): void {
	if (restarting) return;
	restarting = true;
	setTimeout(() => {
		void restartNode().catch((err: unknown) => {
			console.error("update: restart failed:", err);
			process.exit(1);
		});
	}, delayMs);
}

/**
 * Environment for the re-exec'd node: a copy of `env` without `TOBOR_ASSET_ROOT`. compile-entry.ts does
 * `TOBOR_ASSET_ROOT ??= extract()`, so an inherited value would make the new binary skip extraction and serve the old
 * package.json/skeleton/themes.
 */
export function reexecEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const { TOBOR_ASSET_ROOT: _stale, ...rest } = env;
	return rest;
}

/**
 * Restart the node: stop gracefully via the shutdown hook, then under systemd (`INVOCATION_ID` set) exit with code 75 so
 * the unit relaunches it, otherwise spawn `process.execPath` with the original arguments (detached, inherited stdio)
 * and exit 0.
 */
export async function restartNode(): Promise<never> {
	await shutdownHook?.();
	if (process.env.INVOCATION_ID) process.exit(RESTART_EXIT_CODE);
	// Compiled binaries get their arguments after the embedded script at argv[1]; from source argv[1] is the script.
	const args = BUILD === "dev" ? process.argv.slice(1) : process.argv.slice(2);
	const child = Bun.spawn([EXEC_PATH, ...args], { stdio: ["inherit", "inherit", "inherit"], detached: true, env: reexecEnv() });
	child.unref();
	process.exit(0);
}
