// GitHub release lookup and binary replacement helpers. Stateless on purpose (no node, host or config state): the node's
// update checker (update.ts) and a CLI self-update both build on them.
import { createWriteStream } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** `releases/latest` endpoint of the tobor repository. */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/arjungandhi/tobor/releases/latest";

/** Release asset targets named in `manifest.json`. */
export type ReleaseTarget = "linux-x64" | "linux-arm64" | "android";

/** One entry of `manifest.json`. */
export type ManifestAsset = { name: string; target: string; sha256: string };

/** `manifest.json` attached to every release. */
export type Manifest = { version: string; assets: ManifestAsset[] };

/** A manifest asset with the URL it downloads from. */
export type ReleaseAsset = ManifestAsset & { url: string };

/** The latest release as far as an upgrade cares. */
export type LatestRelease = { version: string; assets: ReleaseAsset[] };

/** A `fetch` look-alike, injectable for tests. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** True when `v` is a plain semver (`1.2.3`, optional pre-release/build). */
export function isVersion(v: string): boolean {
	return SEMVER.test(v);
}

/** True when version `a` is strictly newer than `b`; false when either is not a valid semver. */
export function isNewer(a: string, b: string): boolean {
	return isVersion(a) && isVersion(b) && Bun.semver.order(a, b) > 0;
}

/** The manifest target for the running machine: `linux-arm64` on arm64, else `linux-x64`. */
export function targetFor(arch: string = process.arch): ReleaseTarget {
	return arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** Strip a leading `v` from a tag (`v1.2.3` → `1.2.3`); undefined when the rest is not a semver. */
export function versionFromTag(tag: string): string | undefined {
	const v = tag.startsWith("v") ? tag.slice(1) : tag;
	return isVersion(v) ? v : undefined;
}

/** Validate a parsed `manifest.json`; undefined when it does not have the expected shape. */
export function parseManifest(value: unknown): Manifest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { version, assets } = value as { version?: unknown; assets?: unknown };
	if (typeof version !== "string" || !isVersion(version) || !Array.isArray(assets)) return undefined;
	const out: ManifestAsset[] = [];
	for (const a of assets) {
		if (!a || typeof a !== "object") return undefined;
		const { name, target, sha256 } = a as Record<string, unknown>;
		if (typeof name !== "string" || typeof target !== "string" || typeof sha256 !== "string" || !SHA256.test(sha256.toLowerCase())) return undefined;
		out.push({ name, target, sha256: sha256.toLowerCase() });
	}
	return { version, assets: out };
}

/** The manifest asset for `target`, with its download URL, if the release has one. */
export function assetFor(release: LatestRelease, target: string = targetFor()): ReleaseAsset | undefined {
	return release.assets.find((a) => a.target === target);
}

/** Fetch `releases/latest` and its `manifest.json`. Throws on network, HTTP or shape problems. */
export async function fetchLatestRelease(options: { fetch?: FetchFn; userAgent: string; url?: string; timeoutMs?: number }): Promise<LatestRelease> {
	const doFetch = options.fetch ?? fetch;
	const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	const res = await doFetch(options.url ?? LATEST_RELEASE_URL, {
		headers: { accept: "application/vnd.github+json", "user-agent": options.userAgent },
		signal,
	});
	if (!res.ok) throw new Error(`releases/latest: HTTP ${res.status}`);
	const release: unknown = await res.json();
	if (!release || typeof release !== "object") throw new Error("releases/latest: unexpected response");
	const { tag_name, assets } = release as { tag_name?: unknown; assets?: unknown };
	const tagVersion = typeof tag_name === "string" ? versionFromTag(tag_name) : undefined;
	if (!tagVersion) throw new Error(`releases/latest: bad tag_name ${JSON.stringify(tag_name)}`);
	const urls = new Map<string, string>();
	if (Array.isArray(assets)) {
		for (const a of assets as { name?: unknown; browser_download_url?: unknown }[]) {
			if (typeof a?.name === "string" && typeof a.browser_download_url === "string") urls.set(a.name, a.browser_download_url);
		}
	}
	const manifestUrl = urls.get("manifest.json");
	if (!manifestUrl) throw new Error("release has no manifest.json");
	const mres = await doFetch(manifestUrl, { headers: { "user-agent": options.userAgent }, signal });
	if (!mres.ok) throw new Error(`manifest.json: HTTP ${mres.status}`);
	const manifest = parseManifest(await mres.json());
	if (!manifest) throw new Error("manifest.json: unexpected shape");
	const resolved: ReleaseAsset[] = [];
	for (const a of manifest.assets) {
		const url = urls.get(a.name);
		if (url) resolved.push({ ...a, url });
	}
	return { version: manifest.version, assets: resolved };
}

/** Hex sha256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** Download `url` to `tmp`, returning the hex sha256 of what was written. Removes `tmp` on failure. */
export async function downloadFile(url: string, tmp: string, options: { fetch?: FetchFn; userAgent?: string; signal?: AbortSignal } = {}): Promise<string> {
	const doFetch = options.fetch ?? fetch;
	try {
		const res = await doFetch(url, { headers: options.userAgent ? { "user-agent": options.userAgent } : {}, ...(options.signal ? { signal: options.signal } : {}) });
		if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
		const hasher = new Bun.CryptoHasher("sha256");
		const out = createWriteStream(tmp, { mode: 0o755 });
		try {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				hasher.update(chunk);
				if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
			}
		} finally {
			await new Promise<void>((resolve, reject) => {
				out.once("error", reject);
				out.end(resolve);
			});
		}
		return hasher.digest("hex");
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Atomically replace `dest` with the file at `tmp` (rename; `tmp` must be on the same filesystem). The result keeps
 * `dest`'s permission bits, or 0755 when `dest` does not exist, and is always executable by its owner.
 */
export async function replaceFile(tmp: string, dest: string): Promise<void> {
	let mode = 0o755;
	try {
		mode = (await stat(dest)).mode & 0o7777;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	await chmod(tmp, mode | 0o100);
	await rename(tmp, dest);
}

/**
 * Download `url` next to `dest`, verify it hashes to `sha256`, then atomically rename it over `dest`. A mismatch or
 * failure leaves `dest` untouched and removes the temp file. Renaming over a running binary is safe on Linux.
 */
export async function downloadAndReplace(url: string, dest: string, sha256: string, options: { fetch?: FetchFn; userAgent?: string; signal?: AbortSignal } = {}): Promise<void> {
	const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.download`);
	const actual = await downloadFile(url, tmp, options);
	if (actual !== sha256.toLowerCase()) {
		await rm(tmp, { force: true });
		throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
	}
	try {
		await replaceFile(tmp, dest);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}
