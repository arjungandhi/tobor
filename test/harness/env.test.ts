import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvTarget } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvCache, findGitRoot, isInside, parseEnvText, resolveCwd } from "../../src/server/harness/env.js";

const target = (cwd?: string) => ({ conversationId: 1, ...(cwd ? { cwd } : {}) }) as unknown as EnvTarget;

afterEach(() => {
	vi.useRealTimers();
});

describe("parseEnvText", () => {
	it("parses keys, export, quotes and comments", () => {
		const text = [
			"# comment",
			"A=1",
			"export B = two ",
			'C="x\\ny"',
			"D='raw \\n'",
			"E=val # trailing",
			"bad line",
			"",
		].join("\n");
		expect(parseEnvText(text)).toEqual({ A: "1", B: "two", C: "x\ny", D: "raw \\n", E: "val" });
	});
});

describe("EnvCache", () => {
	it("reuses an env per cwd and evicts after idle", async () => {
		vi.useFakeTimers();
		const cache = new EnvCache({ shellEnv: { TOBOR_TEST: "1" }, idleMs: () => 1000 });
		expect(cache.env(target())).toBeUndefined();
		const a = cache.env(target("/tmp"));
		expect(cache.env(target("/tmp"))).toBe(a);
		expect(cache.size).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		cache.env(target("/tmp"));
		await vi.advanceTimersByTimeAsync(999);
		expect(cache.size).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(cache.size).toBe(0);
		expect(cache.env(target("/tmp"))).not.toBe(a);
		await cache.cleanup();
		expect(cache.size).toBe(0);
	});
});

describe("resolveCwd", () => {
	it("requires an absolute existing directory inside a root, through symlinks", async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), "tobor-env-")));
		const root = join(base, "root");
		const inside = join(root, "a", "b");
		const outside = join(base, "elsewhere");
		await mkdir(inside, { recursive: true });
		await mkdir(outside);
		await symlink(outside, join(root, "escape"));
		await symlink(inside, join(base, "shortcut"));
		expect(await resolveCwd(inside, [root])).toBe(inside);
		expect(await resolveCwd(join(base, "shortcut"), [root])).toBe(inside);
		await expect(resolveCwd(join(root, "escape"), [root])).rejects.toMatchObject({ status: 403 });
		await expect(resolveCwd("a/b", [root])).rejects.toMatchObject({ status: 400 });
		await expect(resolveCwd(join(root, "nope"), [root])).rejects.toMatchObject({ status: 400 });
		await expect(resolveCwd(outside, [root])).rejects.toMatchObject({ status: 403 });
	});

	it("checks containment and finds git roots", async () => {
		expect(isInside("/a/b", "/a/b")).toBe(true);
		expect(isInside("/a/b", "/a/b/c")).toBe(true);
		expect(isInside("/a/b", "/a/bc")).toBe(false);
		expect(isInside("/a/b", "/a")).toBe(false);
		const base = await realpath(await mkdtemp(join(tmpdir(), "tobor-git-")));
		await mkdir(join(base, "repo", ".git"), { recursive: true });
		await mkdir(join(base, "repo", "x", "y"), { recursive: true });
		expect(await findGitRoot(join(base, "repo", "x", "y"))).toBe(join(base, "repo"));
	});
});
