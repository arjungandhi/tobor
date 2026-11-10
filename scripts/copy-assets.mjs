// Copy the non-TS assets the compiled modules read beside themselves: artifact themes and vendored Tailwind, and the
// `tobor init` skeleton (.md/.yml files next to src/server/skeleton/index.ts).
import { cpSync } from "node:fs";

cpSync("src/artifacts/themes", "dist/artifacts/themes", { recursive: true });
cpSync("src/artifacts/vendor", "dist/artifacts/vendor", { recursive: true });
cpSync("src/server/skeleton", "dist/server/skeleton", {
	recursive: true,
	filter: (src) => !src.endsWith(".ts"),
});
