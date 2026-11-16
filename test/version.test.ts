// Guards hardcoded constants in src/version.ts against drifting from package.json.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { MIN_BUN, PI_DURABLE_VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	engines: { bun: string };
	dependencies: Record<string, string>;
};

test("PI_DURABLE_VERSION matches the pinned @earendil-works/pi-durable dependency", () => {
	expect(PI_DURABLE_VERSION).toBe(pkg.dependencies["@earendil-works/pi-durable"]);
});

test("MIN_BUN matches engines.bun", () => {
	expect(`>=${MIN_BUN}`).toBe(pkg.engines.bun);
});
