import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assetFor,
	downloadAndReplace,
	downloadFile,
	type FetchFn,
	fetchLatestRelease,
	isNewer,
	parseManifest,
	tempDownloadPath,
	sha256File,
	targetFor,
	versionFromTag,
} from "../../src/server/release.js";
import { UpdateChecker, upgradeSelf } from "../../src/server/update.js";
import { HostError } from "../../src/host.js";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "tobor-update-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const bytes = (text: string): FetchFn => async () => new Response(text);

describe("versions", () => {
	it("compares semver", () => {
		expect(isNewer("0.2.0", "0.1.9")).toBe(true);
		expect(isNewer("1.0.0", "0.99.99")).toBe(true);
		expect(isNewer("0.1.0", "0.1.0")).toBe(false);
		expect(isNewer("0.1.0", "0.2.0")).toBe(false);
		expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
		expect(isNewer("garbage", "0.1.0")).toBe(false);
	});

	it("parses tags", () => {
		expect(versionFromTag("v1.2.3")).toBe("1.2.3");
		expect(versionFromTag("1.2.3")).toBe("1.2.3");
		expect(versionFromTag("nightly")).toBeUndefined();
	});

	it("picks the target by arch", () => {
		expect(targetFor("arm64")).toBe("linux-arm64");
		expect(targetFor("x64")).toBe("linux-x64");
	});
});

describe("manifest", () => {
	const good = {
		version: "1.2.3",
		assets: [
			{ name: "tobor", target: "linux-x64", sha256: "a".repeat(64) },
			{ name: "tobor-arm64", target: "linux-arm64", sha256: "B".repeat(64) },
		],
	};

	it("accepts the release shape and lowercases hashes", () => {
		const m = parseManifest(good);
		expect(m?.version).toBe("1.2.3");
		expect(m?.assets[1]?.sha256).toBe("b".repeat(64));
	});

	it("rejects malformed manifests", () => {
		expect(parseManifest(null)).toBeUndefined();
		expect(parseManifest({ ...good, version: "x" })).toBeUndefined();
		expect(parseManifest({ ...good, assets: "nope" })).toBeUndefined();
		expect(parseManifest({ ...good, assets: [{ name: "tobor", target: "linux-x64", sha256: "short" }] })).toBeUndefined();
	});

	it("fetches the latest release through injected fetch", async () => {
		const seen: { url: string; headers: RequestInit["headers"] }[] = [];
		const fake: FetchFn = async (url, init) => {
			seen.push({ url, headers: init?.headers });
			if (url.includes("releases/latest"))
				return Response.json({
					tag_name: "v1.2.3",
					assets: [
						{ name: "manifest.json", browser_download_url: "https://dl/manifest.json" },
						{ name: "tobor", browser_download_url: "https://dl/tobor" },
					],
				});
			return Response.json(good);
		};
		const latest = await fetchLatestRelease({ fetch: fake, userAgent: "tobor/test" });
		expect(latest.version).toBe("1.2.3");
		expect(assetFor(latest, "linux-x64")?.url).toBe("https://dl/tobor");
		expect(assetFor(latest, "linux-arm64")).toBeUndefined(); // listed in the manifest but not attached
		expect(seen[0]?.headers).toMatchObject({ accept: "application/vnd.github+json", "user-agent": "tobor/test" });
	});

	it("throws on HTTP failure", async () => {
		await expect(fetchLatestRelease({ fetch: async () => new Response("no", { status: 403 }), userAgent: "t" })).rejects.toThrow(/HTTP 403/);
	});
});

describe("download and replace", () => {
	it("verifies sha256, keeps the mode and replaces atomically", async () => {
		const dest = join(dir, "tobor");
		await writeFile(dest, "old", { mode: 0o750 });
		await downloadAndReplace("https://dl/tobor", dest, sha("new binary"), { fetch: bytes("new binary") });
		expect(await readFile(dest, "utf8")).toBe("new binary");
		expect((await stat(dest)).mode & 0o777).toBe(0o750);
		expect(await sha256File(dest)).toBe(sha("new binary"));
		expect(await readdir(dir)).toEqual(["tobor"]); // no temp file left
	});

	it("is executable even when the destination did not exist", async () => {
		const dest = join(dir, "fresh");
		await downloadAndReplace("https://dl/x", dest, sha("x"), { fetch: bytes("x") });
		expect((await stat(dest)).mode & 0o100).toBe(0o100);
	});

	it("leaves the destination untouched on a hash mismatch", async () => {
		const dest = join(dir, "tobor");
		await writeFile(dest, "old");
		await expect(downloadAndReplace("https://dl/tobor", dest, sha("expected"), { fetch: bytes("tampered") })).rejects.toThrow(/sha256 mismatch/);
		expect(await readFile(dest, "utf8")).toBe("old");
		expect(await readdir(dir)).toEqual(["tobor"]);
	});

	it("leaves the destination untouched on an HTTP error", async () => {
		const dest = join(dir, "tobor");
		await writeFile(dest, "old");
		await expect(downloadAndReplace("https://dl/tobor", dest, sha("x"), { fetch: async () => new Response("", { status: 404 }) })).rejects.toThrow(/HTTP 404/);
		expect(await readdir(dir)).toEqual(["tobor"]);
	});
});

describe("downloadFile errors", () => {
	it("rejects cleanly when the destination directory is unwritable", async () => {
		const tmp = join(dir, "missing", "x.download");
		const crashes: unknown[] = [];
		const onCrash = (err: unknown) => crashes.push(err);
		process.on("uncaughtException", onCrash);
		try {
			await expect(downloadFile("https://dl/x", tmp, { fetch: bytes("payload") })).rejects.toThrow(/ENOENT/);
			// A large body exercises the backpressure (drain) path too.
			await expect(downloadFile("https://dl/x", tmp, { fetch: bytes("x".repeat(4 * 1024 * 1024)) })).rejects.toThrow(/ENOENT/);
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			process.off("uncaughtException", onCrash);
		}
		expect(crashes).toEqual([]);
		expect(await readdir(dir)).toEqual([]);
	});

	it("removes the temp file and reports the error when downloadAndReplace cannot write", async () => {
		const dest = join(dir, "nope", "tobor");
		await expect(downloadAndReplace("https://dl/x", dest, sha("x"), { fetch: bytes("x") })).rejects.toThrow(/ENOENT/);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("tempDownloadPath", () => {
	it("is unique per call, next to the destination", () => {
		const dest = join(dir, "tobor");
		const names = new Set(Array.from({ length: 100 }, () => tempDownloadPath(dest)));
		expect(names.size).toBe(100);
		for (const n of names) expect(n.startsWith(join(dir, ".tobor."))).toBe(true);
	});

	it("lets concurrent downloads to one destination succeed without clobbering each other", async () => {
		const dest = join(dir, "tobor");
		await writeFile(dest, "old");
		await Promise.all([
			downloadAndReplace("https://dl/x", dest, sha("new"), { fetch: bytes("new") }),
			downloadAndReplace("https://dl/x", dest, sha("new"), { fetch: bytes("new") }),
		]);
		expect(await readFile(dest, "utf8")).toBe("new");
		expect(await readdir(dir)).toEqual(["tobor"]);
	});
});

describe("upgradeSelf", () => {
	async function setup(running: string, latest: string, latestBinary: string) {
		const exec = join(dir, "tobor");
		await writeFile(exec, running);
		await mkdir(join(dir, "state"));
		const fake: FetchFn = async (url) => {
			if (url.includes("releases/latest"))
				return Response.json({
					tag_name: `v${latest}`,
					assets: [
						{ name: "manifest.json", browser_download_url: "https://dl/manifest.json" },
						{ name: "tobor", browser_download_url: "https://dl/tobor" },
					],
				});
			if (url.endsWith("manifest.json")) return Response.json({ version: latest, assets: [{ name: "tobor", target: "linux-x64", sha256: sha(latestBinary) }] });
			return new Response(latestBinary);
		};
		const checker = new UpdateChecker({ file: join(dir, "state", "update.json"), enabled: () => true, build: "abc", version: "1.0.0", fetch: fake });
		let restarts = 0;
		const common = { execPath: exec, version: "1.0.0", build: "abc", target: "linux-x64", checker, fetch: fake, restart: () => void restarts++ };
		return { exec, checker, common, restarts: () => restarts };
	}

	it("replaces a stale binary and restarts", async () => {
		const { exec, common, restarts, checker } = await setup("old", "1.1.0", "new");
		expect(await upgradeSelf(common)).toEqual({ status: "upgrading", version: "1.0.0", latest: "1.1.0" });
		expect(await readFile(exec, "utf8")).toBe("new");
		expect(restarts()).toBe(1);
		expect(checker.whoami()).toEqual({ latest_version: "1.1.0", update_available: true });
		expect(JSON.parse(await readFile(join(dir, "state", "update.json"), "utf8")).version).toBe("1.1.0"); // persisted
	});

	it("reports current when hash and version match", async () => {
		const { common, restarts } = await setup("same", "1.0.0", "same");
		expect(await upgradeSelf(common)).toEqual({ status: "current", version: "1.0.0", latest: "1.0.0" });
		expect(restarts()).toBe(0);
	});

	it("only restarts when the new binary is already on disk", async () => {
		const { common, restarts } = await setup("new", "1.1.0", "new");
		expect(await upgradeSelf({ ...common, fetch: async (u) => (u.includes("dl/tobor") ? Promise.reject(new Error("no download expected")) : common.fetch(u)) })).toMatchObject({ status: "upgrading" });
		expect(restarts()).toBe(1);
	});

	it("does not downgrade a newer local build", async () => {
		const { exec, common, restarts } = await setup("local", "0.9.0", "released");
		expect((await upgradeSelf(common)).status).toBe("current");
		expect(await readFile(exec, "utf8")).toBe("local");
		expect(restarts()).toBe(0);
	});

	it("rejects dev builds with 400 unsupported", async () => {
		const { common } = await setup("old", "1.1.0", "new");
		await expect(upgradeSelf({ ...common, build: "dev" })).rejects.toMatchObject({ status: 400, code: "unsupported" });
		await expect(upgradeSelf({ ...common, build: "dev" })).rejects.toBeInstanceOf(HostError);
	});

	it("answers 503 and keeps the binary when the download is corrupt", async () => {
		const { exec, common, restarts } = await setup("old", "1.1.0", "new");
		const bad: FetchFn = async (u) => (u.includes("dl/tobor") ? new Response("corrupt") : common.fetch(u));
		await expect(upgradeSelf({ ...common, fetch: bad })).rejects.toMatchObject({ status: 503, code: "download_failed" });
		expect(await readFile(exec, "utf8")).toBe("old");
		expect(restarts()).toBe(0);
	});
});

describe("UpdateChecker", () => {
	it("survives network failure and omits whoami fields for dev or disabled", async () => {
		const file = join(dir, "update.json");
		const down: FetchFn = async () => {
			throw new Error("offline");
		};
		const c = new UpdateChecker({ file, enabled: () => true, build: "abc", version: "1.0.0", fetch: down });
		expect(await c.refresh()).toBeUndefined();
		expect(c.whoami()).toEqual({});
		const dev = new UpdateChecker({ file, enabled: () => true, build: "dev", version: "1.0.0" });
		expect(dev.whoami()).toEqual({});
	});

	it("remembers the last result across restarts and keeps it on later failures", async () => {
		const file = join(dir, "update.json");
		await writeFile(file, JSON.stringify({ version: "2.0.0", checkedAt: Date.now(), assets: [] }));
		let enabled = true;
		const c = new UpdateChecker({ file, enabled: () => enabled, build: "abc", version: "1.0.0", fetch: async () => Promise.reject(new Error("offline")) });
		await c.start();
		try {
			expect(c.whoami()).toEqual({ latest_version: "2.0.0", update_available: true });
			expect((await c.refresh())?.version).toBe("2.0.0");
			enabled = false;
			expect(c.whoami()).toEqual({});
		} finally {
			c.stop();
		}
	});
});
