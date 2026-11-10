// Entry of the compiled binary (`bun run build`). Bundled modules live in `/$bunfs`, so the on-disk assets
// (build/assets.generated.ts) are extracted once per build into `$XDG_CACHE_HOME/tobor/assets/<hash>/`, mirroring the
// repo root, and `$TOBOR_ASSET_ROOT` points there (src/assets.ts) before the normal CLI loads.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ASSETS, ASSETS_HASH } from "./assets.generated.ts";

function extract(): string {
	const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "tobor", "assets");
	const root = join(dir, ASSETS_HASH);
	if (existsSync(root)) return root;
	const staging = join(dir, `.${ASSETS_HASH}.${process.pid}.tmp`);
	for (const [rel, embedded] of Object.entries(ASSETS)) {
		const target = join(staging, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(embedded)); // copyFileSync cannot read /$bunfs
	}
	try {
		renameSync(staging, root);
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		if (!existsSync(root)) throw err; // otherwise a concurrent first run won the rename
	}
	return root;
}

process.env.TOBOR_ASSET_ROOT ??= extract();
// Dynamic so the env is set before src/version.ts reads package.json at module evaluation.
await import("../src/cli.ts");
