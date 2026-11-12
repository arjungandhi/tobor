import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completePath } from "../../src/server/harness/complete.js";

let root: string;
let outside: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "tobor-complete-root-")));
	outside = realpathSync(mkdtempSync(join(tmpdir(), "tobor-complete-out-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const names = (r: { entries: { name: string }[] }) => r.entries.map((e) => e.name);

describe("completePath", () => {
	it("lists the cwd for an empty prefix, hiding dot entries", async () => {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "a.txt"), "");
		writeFileSync(join(root, ".hidden"), "");
		const r = await completePath("", root, [root]);
		expect(r.dir).toBe(root);
		expect(r.entries).toEqual([
			{ name: "src", type: "dir" },
			{ name: "a.txt", type: "file" },
		]);
	});

	it("filters by base name case-insensitively", async () => {
		writeFileSync(join(root, "Readme.md"), "");
		writeFileSync(join(root, "README.txt"), "");
		writeFileSync(join(root, "other"), "");
		expect(names(await completePath("rea", root, [root]))).toEqual(["Readme.md", "README.txt"]);
	});

	it("shows dot entries only when the base starts with a dot", async () => {
		writeFileSync(join(root, ".env"), "");
		writeFileSync(join(root, ".git"), "");
		writeFileSync(join(root, "env"), "");
		expect(names(await completePath(".", root, [root]))).toEqual([".env", ".git"]);
		expect(names(await completePath(".e", root, [root]))).toEqual([".env"]);
		expect(names(await completePath("e", root, [root]))).toEqual(["env"]);
	});

	it("lists a directory for a trailing slash and resolves nested relative parents", async () => {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		writeFileSync(join(root, "a", "x.ts"), "");
		const r = await completePath("a/", root, [root]);
		expect(r.dir).toBe(join(root, "a"));
		expect(names(r)).toEqual(["b", "x.ts"]);
		expect(names(await completePath("a/x", root, [root]))).toEqual(["x.ts"]);
		expect(names(await completePath(`${root}/a/b`, outside, [root]))).toEqual(["b"]);
	});

	it("expands ~ to the home directory", async () => {
		// `os.homedir()` can't be redirected from a vitest worker, so compare against the real home as the root.
		const home = homedir();
		const expected = await completePath(`${home}/`, outside, [home]);
		expect(expected.dir).toBe(realpathSync(home));
		expect(await completePath("~/", outside, [home])).toEqual(expected);
		expect(await completePath("~", outside, [home])).toEqual(expected);
		expect((await completePath("~/", outside, [root])).entries).toEqual([]);
		const first = expected.entries.find((e) => !e.name.startsWith("."));
		if (first) expect(names(await completePath(`~/${first.name.slice(0, 2)}`, outside, [home]))).toContain(first.name);
	});

	it("sorts directories first, then alphabetically ignoring case", async () => {
		for (const d of ["zeta", "Alpha"]) mkdirSync(join(root, d));
		for (const f of ["beta", "Aardvark"]) writeFileSync(join(root, f), "");
		expect(names(await completePath("", root, [root]))).toEqual(["Alpha", "zeta", "Aardvark", "beta"]);
	});

	it("classifies symlinks by target; broken symlinks are files", async () => {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "dirlink"));
		symlinkSync(join(root, "missing"), join(root, "broken"));
		expect((await completePath("", root, [root])).entries).toEqual([
			{ name: "dirlink", type: "dir" },
			{ name: "real", type: "dir" },
			{ name: "broken", type: "file" },
		]);
	});

	it("returns nothing outside the roots", async () => {
		writeFileSync(join(outside, "secret"), "");
		expect((await completePath(`${outside}/`, root, [root])).entries).toEqual([]);
		expect((await completePath("../", root, [root])).entries).toEqual([]);
		expect((await completePath("", outside, [root])).entries).toEqual([]);
	});

	it("returns nothing through a symlink that escapes the roots", async () => {
		writeFileSync(join(outside, "secret"), "");
		symlinkSync(outside, join(root, "escape"));
		expect((await completePath("escape/", root, [root])).entries).toEqual([]);
		expect((await completePath("escape/s", root, [root])).entries).toEqual([]);
	});

	it("returns nothing for a missing or non-directory parent", async () => {
		writeFileSync(join(root, "file"), "");
		expect(await completePath("nope/x", root, [root])).toEqual({ dir: join(root, "nope"), entries: [] });
		expect((await completePath("file/", root, [root])).entries).toEqual([]);
	});

	it("caps results at 50", async () => {
		for (let i = 0; i < 60; i++) writeFileSync(join(root, `f${String(i).padStart(2, "0")}`), "");
		const r = await completePath("f", root, [root]);
		expect(r.entries).toHaveLength(50);
		expect(r.entries[0]?.name).toBe("f00");
		expect(r.entries[49]?.name).toBe("f49");
	});
});
