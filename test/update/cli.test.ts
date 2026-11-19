import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WhoamiResponse } from "../../src/api/types.js";
import { type Io, restartNode, upgradeLocal, upgradeNode } from "../../src/server/cli/upgrade.js";
import type { FetchFn } from "../../src/server/release.js";
import { ApiRequestError } from "../../src/tui/client.js";
import { formatCheck, mismatchHint, upgradeErrorMessage, waitForNode } from "../../src/tui/node-upgrade.js";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function capture(): Io & { stdout: string; stderr: string } {
	const io = {
		stdout: "",
		stderr: "",
		out: (t: string) => void (io.stdout += t),
		err: (t: string) => void (io.stderr += t),
	};
	return io;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "tobor-cli-upgrade-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A fetch serving releases/latest, manifest.json and the linux-x64 asset for `version`. */
function releaseFetch(version: string, binary: string, sha256 = sha(binary)): FetchFn {
	return async (url) => {
		if (url.includes("releases/latest")) {
			return Response.json({
				tag_name: `v${version}`,
				assets: [
					{ name: "manifest.json", browser_download_url: "https://dl/manifest.json" },
					{ name: "tobor", browser_download_url: "https://dl/tobor" },
				],
			});
		}
		if (url.endsWith("manifest.json")) return Response.json({ version, assets: [{ name: "tobor", target: "linux-x64", sha256 }] });
		if (url.endsWith("/tobor")) return new Response(binary);
		return new Response("nope", { status: 404 });
	};
}

describe("tobor upgrade (local)", () => {
	it("refuses dev builds", async () => {
		const io = capture();
		expect(await upgradeLocal({ check: false, io, build: "dev" })).toBe(1);
		expect(io.stderr).toContain("dev build");
	});

	it("--check reports without touching the binary", async () => {
		const exe = join(dir, "tobor");
		await writeFile(exe, "old");
		const io = capture();
		const code = await upgradeLocal({ check: true, io, version: "0.1.0", build: "abc", execPath: exe, target: "linux-x64", fetch: releaseFetch("0.2.0", "new") });
		expect(code).toBe(0);
		expect(io.stdout).toContain("tobor 0.1.0 (build abc)");
		expect(io.stdout).toContain("latest release: 0.2.0 (update available: run `tobor upgrade`)");
		expect(await readFile(exe, "utf8")).toBe("old");
	});

	it("says so when current", async () => {
		const io = capture();
		expect(await upgradeLocal({ check: false, io, version: "0.2.0", build: "abc", fetch: releaseFetch("0.2.0", "new") })).toBe(0);
		expect(io.stdout).toContain("up to date");
	});

	it("replaces the binary and reminds about running nodes", async () => {
		const exe = join(dir, "tobor");
		await writeFile(exe, "old");
		const io = capture();
		const code = await upgradeLocal({ check: false, io, version: "0.1.0", build: "abc", execPath: exe, target: "linux-x64", fetch: releaseFetch("0.2.0", "new") });
		expect(code).toBe(0);
		expect(await readFile(exe, "utf8")).toBe("new");
		expect(io.stdout).toContain("0.1.0 -> 0.2.0");
		expect(io.stdout).toContain("tobor upgrade <workspace>");
	});

	it("keeps the old binary on a sha mismatch", async () => {
		const exe = join(dir, "tobor");
		await writeFile(exe, "old");
		const io = capture();
		const code = await upgradeLocal({ check: false, io, version: "0.1.0", build: "abc", execPath: exe, target: "linux-x64", fetch: releaseFetch("0.2.0", "new", "0".repeat(64)) });
		expect(code).toBe(1);
		expect(io.stderr).toContain("download failed");
		expect(await readFile(exe, "utf8")).toBe("old");
	});

	it("fails clearly when the release has no asset for this arch", async () => {
		const io = capture();
		const code = await upgradeLocal({ check: false, io, version: "0.1.0", build: "abc", target: "linux-arm64", fetch: releaseFetch("0.2.0", "new") });
		expect(code).toBe(1);
		expect(io.stderr).toContain("no asset for linux-arm64");
	});
});

const whoami = (over: Partial<WhoamiResponse> = {}): WhoamiResponse =>
	({ host: "box", version: "0.1.0", build: "aaa", pi_durable: "1", runtime: "bun", ...over }) as WhoamiResponse;

describe("formatCheck", () => {
	it("covers available, current and unknown", () => {
		const base = { label: "work", version: "0.1.0", build: "aaa", command: "tobor upgrade work" };
		expect(formatCheck({ ...base, latest: "0.2.0", available: true })).toBe(
			"work: tobor 0.1.0 (build aaa)\nlatest release: 0.2.0 (update available: run `tobor upgrade work`)\n",
		);
		expect(formatCheck({ ...base, latest: "0.1.0", available: false })).toContain("(up to date)");
		expect(formatCheck({ ...base, latest: undefined, available: false })).toContain("latest release: unknown");
		expect(formatCheck({ ...base, build: "dev", latest: undefined, available: false })).toContain("runs from source");
	});
});

describe("upgradeErrorMessage", () => {
	const api = (status: number, code?: string, error = "boom") => new ApiRequestError(status, { error, ...(code ? { code } : {}) }, `POST /api/upgrade: ${status} ${error}`);
	it("maps the node's codes", () => {
		expect(upgradeErrorMessage(api(400, "unsupported"))).toContain("runs from source");
		expect(upgradeErrorMessage(api(503, "update_unavailable"))).toContain("no release available");
		expect(upgradeErrorMessage(api(503, "download_failed", "bad sha"))).toBe("download failed: bad sha");
		expect(upgradeErrorMessage(api(404))).toContain("does not support upgrades");
		expect(upgradeErrorMessage(new TypeError("fetch failed"))).toBe("cannot reach the node");
	});
});

describe("mismatchHint", () => {
	const cli = { version: "0.1.0", build: "aaa" };
	it("tells a stale client to upgrade, a stale node to restart", () => {
		expect(mismatchHint(cli, { version: "0.2.0", build: "bbb" })).toContain("run `tobor upgrade`");
		expect(mismatchHint(cli, { version: "0.1.0", build: "bbb" })).toContain("restart the node");
		expect(mismatchHint(cli, { ...cli })).toBeUndefined();
		expect(mismatchHint({ ...cli, build: "dev" }, { version: "0.2.0", build: "bbb" })).toBeUndefined();
	});
});

describe("waitForNode", () => {
	/** Fake clock: `sleep` advances it. */
	function clock() {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	}

	it("waits for the node to go down and come back", async () => {
		const answers = [whoami(), whoami(), undefined, undefined, whoami({ version: "0.2.0" })];
		const result = await waitForNode({ probe: async () => answers.shift(), before: whoami(), ...clock() });
		expect(result).toMatchObject({ status: "back", whoami: { version: "0.2.0" } });
		expect(answers).toEqual([]);
	});

	it("accepts a changed build without having seen it down", async () => {
		const result = await waitForNode({ probe: async () => whoami({ build: "bbb" }), before: whoami(), ...clock() });
		expect(result.status).toBe("back");
	});

	it("gives up when the node never answers", async () => {
		const result = await waitForNode({ probe: async () => undefined, timeoutMs: 5_000, ...clock() });
		expect(result).toEqual({ status: "timeout" });
	});

	it("reports an unconfirmed restart when it never went down", async () => {
		const result = await waitForNode({ probe: async () => whoami(), before: whoami(), ...clock() });
		expect(result.status).toBe("unconfirmed");
	});
});

describe("upgradeNode / restartNode", () => {
	/** A fake node: whoami plus the two POST endpoints. */
	async function fakeNode(handlers: { upgrade?: () => Response; restart?: () => Response; who?: Partial<WhoamiResponse> }) {
		const calls: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const { pathname } = new URL(req.url);
				calls.push(`${req.method} ${pathname}`);
				if (pathname === "/api/whoami") return Response.json(whoami(handlers.who));
				if (pathname === "/api/upgrade" && handlers.upgrade) return handlers.upgrade();
				if (pathname === "/api/restart" && handlers.restart) return handlers.restart();
				return new Response("not found", { status: 404 });
			},
		});
		return { calls, address: { host: "127.0.0.1", port: server.port as number }, stop: () => server.stop(true) };
	}

	/** whoami answers: the old node, then down, then the new node. */
	const restartedProbe = (next: Partial<WhoamiResponse>) => {
		const answers: (WhoamiResponse | undefined)[] = [whoami(), undefined, whoami(next)];
		return async () => answers.shift() ?? whoami(next);
	};
	const fast = { sleep: async () => {}, cli: { version: "0.2.0", build: "bbb" } };

	it("--check posts nothing", async () => {
		const node = await fakeNode({ who: { latest_version: "0.2.0", update_available: true } });
		const io = capture();
		const code = await upgradeNode({ address: node.address, label: "work", check: true, io });
		node.stop();
		expect(code).toBe(0);
		expect(io.stdout).toContain("update available: run `tobor upgrade work`");
		expect(node.calls).toEqual(["GET /api/whoami"]);
	});

	it("upgrades and prints the new version", async () => {
		const node = await fakeNode({ upgrade: () => Response.json({ status: "upgrading", version: "0.1.0", latest: "0.2.0" }) });
		const io = capture();
		const code = await upgradeNode({ address: node.address, label: "work", check: false, io, ...fast, probe: restartedProbe({ version: "0.2.0", build: "bbb" }) });
		node.stop();
		expect(code).toBe(0);
		expect(node.calls).toContain("POST /api/upgrade");
		expect(io.stdout).toContain("upgrading tobor 0.1.0 -> 0.2.0");
		expect(io.stdout).toContain("work: upgraded to tobor 0.2.0 (build bbb)");
	});

	it("reports a current node", async () => {
		const node = await fakeNode({ upgrade: () => Response.json({ status: "current", version: "0.1.0", latest: "0.1.0" }) });
		const io = capture();
		expect(await upgradeNode({ address: node.address, label: "work", check: false, io, ...fast })).toBe(0);
		node.stop();
		expect(io.stdout).toContain("up to date");
	});

	it("maps a dev node's 400", async () => {
		const node = await fakeNode({ upgrade: () => Response.json({ error: "no", code: "unsupported" }, { status: 400 }) });
		const io = capture();
		expect(await upgradeNode({ address: node.address, label: "work", check: false, io, ...fast })).toBe(1);
		node.stop();
		expect(io.stderr).toContain("runs from source");
	});

	it("gives up waiting with a note", async () => {
		const node = await fakeNode({ restart: () => Response.json({ status: "restarting" }) });
		const io = capture();
		let t = 0;
		const answers = [whoami()];
		const code = await restartNode({
			address: node.address,
			label: "work",
			io,
			cli: fast.cli,
			timeoutMs: 3_000,
			now: () => t,
			sleep: async (ms) => void (t += ms),
			probe: async () => answers.shift(),
		});
		node.stop();
		expect(code).toBe(1);
		expect(io.stderr).toContain("no answer after 3s");
	});

	it("restarts and surfaces a build mismatch", async () => {
		const node = await fakeNode({ restart: () => Response.json({ status: "restarting" }) });
		const io = capture();
		const code = await restartNode({ address: node.address, label: "work", io, ...fast, probe: restartedProbe({ version: "0.3.0", build: "ccc" }) });
		node.stop();
		expect(code).toBe(0);
		expect(io.stdout).toContain("work: restarted, now tobor 0.3.0 (build ccc)");
		expect(io.stderr).toContain("run `tobor upgrade`");
	});
});
