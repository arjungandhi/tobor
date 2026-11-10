// Non-TS files tobor reads from disk at runtime: package.json and the assets under src/ (init skeleton, artifact themes,
// vendored Tailwind). From source they sit beside the modules. A compiled binary's modules live in `/$bunfs`, so
// build/compile-entry.ts extracts the embedded copies to a cache dir mirroring the repo root and sets $TOBOR_ASSET_ROOT.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Disk path of a shipped asset: `repoPath` (relative to the repo root) under `$TOBOR_ASSET_ROOT`, else `local`. */
export function assetPath(repoPath: string, local: URL): string {
	const root = process.env.TOBOR_ASSET_ROOT;
	return root ? join(root, repoPath) : fileURLToPath(local);
}
