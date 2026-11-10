// Client-side pieces of `tobor upgrade|restart` and the TUI's /upgrade and /restart: error wording, waiting for a restarted
// node to answer again, `--check` formatting and the build-mismatch hint. Free of server state so the TUI can import it.
import type { WhoamiResponse } from "../api/types.js";
import { isNewer } from "../server/release.js";
import { ApiRequestError } from "./client.js";

/** Longest the CLI and TUI wait for a restarted node to answer again. */
export const WAIT_TIMEOUT_MS = 60_000;

/** After this long still answering without ever having gone down, the restart is reported as unconfirmed. */
const NEVER_DOWN_MS = 8_000;

/** The `version` and `build` a node (or this binary) reports. */
export type BuildId = { version: string; build?: string };

/**
 * How to restart a node that runs another build than this CLI (a rebuilt binary is picked up only on restart), or
 * undefined when it runs the same build, none answers, or either side runs from source.
 */
export function staleNodeHint(
	cli: { version: string; build: string },
	node: { version: string; build?: string } | undefined,
	unit: string | undefined,
): string | undefined {
	if (!node || cli.build === "dev" || node.build === "dev") return undefined;
	if (node.version === cli.version && node.build === cli.build) return undefined;
	const restart = unit ? `systemctl --user restart tobor@${unit}` : "stop it and start `tobor node` again";
	return `note: the running node is tobor ${node.version} (build ${node.build ?? "unknown"}), this CLI is ${cli.version} (build ${cli.build}); restart the node to pick up a rebuilt binary: ${restart}`;
}

/**
 * Hint when a node and this client run different builds: a node newer than the client means the client is stale
 * (`tobor upgrade`), anything else is `staleNodeHint` (a rebuilt binary is picked up only on restart). Undefined for dev builds.
 */
export function mismatchHint(cli: { version: string; build: string }, node: BuildId | undefined): string | undefined {
	if (!node || cli.build === "dev" || node.build === "dev") return undefined;
	if (isNewer(node.version, cli.version)) return `note: the node runs tobor ${node.version}, this client is ${cli.version}; run \`tobor upgrade\` to update this binary`;
	return staleNodeHint(cli, { version: node.version, ...(node.build === undefined ? {} : { build: node.build }) }, undefined);
}

/** A friendly sentence for a failed `POST /api/upgrade|restart` (or an unreachable node). */
export function upgradeErrorMessage(err: unknown): string {
	if (err instanceof ApiRequestError) {
		const detail = err.body?.error;
		switch (err.body?.code) {
			case "unsupported":
				return "the node runs from source (dev build); upgrading is not supported, rebuild it instead";
			case "update_unavailable":
				return `no release available: ${detail ?? "could not determine the latest release"}`;
			case "download_failed":
				return `download failed: ${detail ?? "the node could not fetch the new binary"}`;
			case "unavailable":
				return "the node's update checker is not running";
		}
		if (err.status === 404) return "the node does not support upgrades (it predates this feature; update it by hand once)";
		return err.message;
	}
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "the node did not answer in time";
	const message = err instanceof Error ? err.message : String(err);
	return /fetch failed|ECONNREFUSED|Unable to connect|ConnectionRefused|ENOTFOUND/i.test(message) ? "cannot reach the node" : message;
}

/** Outcome of `waitForNode`. `unconfirmed`: it kept answering and never went down, so the restart cannot be confirmed. */
export type WaitResult =
	| { status: "back"; whoami: WhoamiResponse }
	| { status: "unconfirmed"; whoami: WhoamiResponse }
	| { status: "timeout" };

/**
 * Poll `probe` (a whoami that resolves undefined when the node does not answer) with a growing delay until the node
 * answers again after a restart: once it has been seen down, or reports another version/build than `before`. The node
 * restarts a moment after replying, so an early answer from the old process is not taken for the new one.
 */
export async function waitForNode(options: {
	probe: () => Promise<WhoamiResponse | undefined>;
	before?: BuildId;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<WaitResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const start = now();
	const deadline = start + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
	let seenDown = false;
	let delay = 250;
	for (;;) {
		const who = await options.probe();
		if (!who) seenDown = true;
		else {
			const changed = options.before !== undefined && (who.version !== options.before.version || (who.build ?? "") !== (options.before.build ?? ""));
			if (seenDown || changed) return { status: "back", whoami: who };
			if (now() - start >= NEVER_DOWN_MS) return { status: "unconfirmed", whoami: who };
		}
		if (now() >= deadline) return { status: "timeout" };
		await sleep(delay);
		delay = Math.min(2_000, Math.round(delay * 1.5));
	}
}

/** `--check` report: what runs, what is latest and what to do about it. `latest` undefined: the release is unknown. */
export function formatCheck(options: { label: string; version: string; build: string; latest: string | undefined; available: boolean; command: string }): string {
	const { label, version, build, latest, available, command } = options;
	const lines = [`${label}: tobor ${version} (build ${build})`];
	if (latest === undefined) lines.push("latest release: unknown (update checks are off or the release could not be fetched)");
	else if (available) lines.push(`latest release: ${latest} (update available: run \`${command}\`)`);
	else lines.push(`latest release: ${latest} (up to date)`);
	if (build === "dev") lines.push("runs from source: upgrading is not supported");
	return `${lines.join("\n")}\n`;
}

/** Reminder printed after a local binary was replaced. */
export const RESTART_REMINDER =
	"running nodes keep the old binary until restarted: `tobor upgrade <workspace>` upgrades and restarts a node, or restart it yourself (`systemctl --user restart tobor@<name>`)";
