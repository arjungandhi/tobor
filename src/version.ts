// Package and dependency versions reported by `tobor version` and `GET /api/whoami`.
import { readFileSync } from "node:fs";

/** The pinned pi-durable version (package.json pins it exactly). */
export const PI_DURABLE_VERSION = "1.5.1";

/** Minimum Node version: `node:sqlite` and pi-durable need 22.19. */
export const MIN_NODE = [22, 19] as const;

/** tobor's own version, read from package.json (one level above both `src/` and `dist/`). */
export const VERSION: string = readVersion();

function readVersion(): string {
	const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") return pkg.version;
	throw new Error("package.json has no version");
}

/** True when the running Node satisfies `MIN_NODE`. */
export function nodeSupported(version: string = process.versions.node): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}
