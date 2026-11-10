// Package, dependency and runtime versions reported by `tobor version` and `GET /api/whoami`.
import { readFileSync } from "node:fs";
import { assetPath } from "./assets.js";

/** The pinned pi-durable version (package.json pins it exactly). */
export const PI_DURABLE_VERSION = "1.5.1";

/** Minimum Bun version (package.json `engines.bun`). */
export const MIN_BUN = "1.4.4";

/** The running runtime: `bun <Bun.version>` (`node <version>` only when started under Node by mistake). */
export const RUNTIME = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;

/** tobor's own version, read from package.json (one level above `src/`, or under `$TOBOR_ASSET_ROOT`). */
export const VERSION: string = readVersion();

function readVersion(): string {
	const pkg: unknown = JSON.parse(readFileSync(assetPath("package.json", new URL("../package.json", import.meta.url)), "utf8"));
	if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") return pkg.version;
	throw new Error("package.json has no version");
}

/** True when running under Bun >= `MIN_BUN`. */
export function bunSupported(version: string | undefined = process.versions.bun): boolean {
	return version !== undefined && Bun.semver.order(version, MIN_BUN) >= 0;
}
