import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFeed } from "../../src/artifacts/feed.js";
import { projectIdFor, projectInfo } from "../../src/artifacts/project.js";
import { ArtifactStore, htmlTitle, MAX_BUNDLE_FILES, scanBundle } from "../../src/artifacts/store.js";

const temps: string[] = [];
const temp = () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tobor-art-")));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

describe("projectInfo", () => {
	it("uses the first commit sha in a git repo, from any subdir", async () => {
		const repo = temp();
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "-m", "one");
		const first = git(repo, "rev-parse", "HEAD");
		git(repo, "commit", "-q", "--allow-empty", "-m", "two");
		mkdirSync(join(repo, "sub"));
		const info = await projectInfo(join(repo, "sub"));
		expect(info.key).toBe(`git:${first}`);
		expect(info.projectId).toBe(projectIdFor(`git:${first}`));
		expect(info.projectId).toMatch(/^proj_[0-9a-f]{12}$/);
		expect(info.root).toBe(repo);
	});

	it("suffixes linked worktrees with the gitdir name", async () => {
		const repo = temp();
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "-m", "one");
		const first = git(repo, "rev-parse", "HEAD");
		const wt = join(temp(), "wt");
		git(repo, "worktree", "add", "-q", wt);
		const info = await projectInfo(wt);
		expect(info.key).toBe(`git:${first}:wt:wt`);
		expect(info.root).toBe(wt);
	});

	it("falls back to the realpath outside git and in a repo without commits", async () => {
		const dir = temp();
		expect((await projectInfo(dir)).key).toBe(`path:${dir}`);
		git(dir, "init", "-q");
		expect((await projectInfo(dir)).key).toBe(`path:${dir}`);
	});
});

describe("ArtifactStore", () => {
	const setup = () => {
		const home = temp();
		const bundle = join(temp(), "bundle");
		mkdirSync(join(bundle, "assets"), { recursive: true });
		writeFileSync(join(bundle, "index.html"), "<html><head><title>Hello &amp; bye</title></head><body>1</body></html>");
		let t = 1000;
		const store = new ArtifactStore(join(home, "feed.jsonl"), join(home, "store"), () => t++);
		const submit = (extra: { title?: string; tags?: string[] } = {}) =>
			store.submit({ bundleDir: bundle, projectId: "proj_x", projectName: "x", slug: "demo", ...extra });
		return { home, bundle, store, submit };
	};

	it("stores revisions, dedupes unchanged content and counts per slug", async () => {
		const { bundle, store, submit } = setup();
		const a = await submit();
		expect(a.deduped).toBe(false);
		expect(a.entry.revision).toBe(1);
		expect(a.entry.title).toBe("Hello & bye");
		expect(existsSync(join(store.dirOf(a.entry), "index.html"))).toBe(true);

		const same = await submit();
		expect(same.deduped).toBe(true);
		expect(same.entry.rev).toBe(a.entry.rev);

		const retitled = await submit({ title: "Other" });
		expect(retitled.deduped).toBe(false);
		expect(retitled.entry.revision).toBe(2);

		const tagged = await submit({ title: "Other", tags: ["a"] });
		expect(tagged.entry.revision).toBe(3);

		writeFileSync(join(bundle, "index.html"), "<title>Changed</title>");
		const changed = await submit({ title: "Other", tags: ["a"] });
		expect(changed.entry.revision).toBe(4);
		expect(changed.entry.hash).not.toBe(tagged.entry.hash);

		expect((await readFeed(store.feedFile)).map((e) => e.revision)).toEqual([1, 2, 3, 4]);
	});

	it("re-stores when the stored dir is gone", async () => {
		const { store, submit } = setup();
		const a = await submit();
		rmSync(store.dirOf(a.entry), { recursive: true });
		const b = await submit();
		expect(b.deduped).toBe(false);
		expect(b.entry.revision).toBe(2);
	});

	it("serializes concurrent submits into distinct revisions", async () => {
		const { submit } = setup();
		const results = await Promise.all([submit({ title: "a" }), submit({ title: "b" }), submit({ title: "c" })]);
		expect(results.map((r) => r.entry.revision).sort()).toEqual([1, 2, 3]);
	});

	it("rejects bad slugs and bundles without index.html", async () => {
		const { store, bundle } = setup();
		await expect(store.submit({ bundleDir: bundle, projectId: "p", projectName: "p", slug: "Bad" })).rejects.toThrow(/Invalid slug/);
		rmSync(join(bundle, "index.html"));
		await expect(store.submit({ bundleDir: bundle, projectId: "p", projectName: "p", slug: "ok" })).rejects.toThrow(/index.html/);
	});
});

describe("scanBundle", () => {
	it("skips build dirs, drops local js except the vendored runtime, and drops symlinks", async () => {
		const dir = temp();
		mkdirSync(join(dir, "assets"));
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "index.html"), "x");
		writeFileSync(join(dir, "assets", "tailwind.js"), "x");
		writeFileSync(join(dir, "assets", "app.js"), "x");
		writeFileSync(join(dir, "app.mjs"), "x");
		writeFileSync(join(dir, "node_modules", "a.css"), "x");
		symlinkSync("/etc/passwd", join(dir, "assets", "link.txt"));
		const scan = await scanBundle(dir);
		expect(scan.files.map((f) => f.rel)).toEqual(["assets/tailwind.js", "index.html"]);
		expect(scan.dropped.sort()).toEqual(["app.mjs", "assets/app.js", "assets/link.txt"]);
	});

	it("enforces the file limit", async () => {
		const dir = temp();
		for (let i = 0; i <= MAX_BUNDLE_FILES; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
		await expect(scanBundle(dir)).rejects.toThrow(/more than 200 files/);
	});
});

describe("htmlTitle", () => {
	it("extracts and normalizes", () => {
		expect(htmlTitle("<title>\n  A  b </title>")).toBe("A b");
		expect(htmlTitle("<p>none</p>")).toBeUndefined();
		expect(htmlTitle("<title> </title>")).toBeUndefined();
	});
});
