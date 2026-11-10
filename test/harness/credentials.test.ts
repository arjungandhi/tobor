import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/server/harness/credentials.js";

async function tempFile(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "tobor-cred-")), "auth.json");
}

const apiKey = (key: string): Credential => ({ type: "api_key", key });

describe("FileCredentialStore", () => {
	it("reads a missing file as empty and writes 0600 with no leftovers", async () => {
		const path = await tempFile();
		const store = new FileCredentialStore(path);
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.list()).toEqual([]);
		await store.modify("anthropic", async () => apiKey("k1"));
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await store.read("anthropic")).toEqual(apiKey("k1"));
		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
		expect((await readdir(join(path, ".."))).sort()).toEqual(["auth.json"]);
	});

	it("re-reads the file on every call", async () => {
		const path = await tempFile();
		const store = new FileCredentialStore(path);
		await writeFile(path, JSON.stringify({ openai: apiKey("outside") }));
		expect(await store.read("openai")).toEqual(apiKey("outside"));
	});

	it("serializes concurrent read-modify-writes across store instances", async () => {
		const path = await tempFile();
		const a = new FileCredentialStore(path);
		const b = new FileCredentialStore(path);
		const bump = (store: FileCredentialStore) =>
			store.modify("counter", async (current) => {
				const n = Number(current?.type === "api_key" ? current.key : "0");
				await setImmediate();
				return apiKey(String(n + 1));
			});
		await Promise.all(Array.from({ length: 40 }, (_, i) => bump(i % 2 ? a : b)));
		expect(await a.read("counter")).toEqual(apiKey("40"));
		expect((await readdir(join(path, ".."))).sort()).toEqual(["auth.json"]);
	});

	it("leaves the file unchanged and releases the lock when fn throws", async () => {
		const path = await tempFile();
		const store = new FileCredentialStore(path);
		await store.modify("p", async () => apiKey("before"));
		await expect(
			store.modify("p", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await store.read("p")).toEqual(apiKey("before"));
		await store.modify("p", async () => apiKey("after"));
		expect(await store.read("p")).toEqual(apiKey("after"));
	});

	it("returns the current credential when fn returns undefined, and deletes", async () => {
		const path = await tempFile();
		const store = new FileCredentialStore(path);
		await store.modify("p", async () => apiKey("x"));
		expect(await store.modify("p", async () => undefined)).toEqual(apiKey("x"));
		await store.modify("q", async () => apiKey("y"));
		await store.delete("p");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ q: apiKey("y") });
	});

	it("waits for a held lock, times out on a fresh one, and takes over a stale one", async () => {
		const path = await tempFile();
		await writeFile(`${path}.lock`, "999999\n");
		const impatient = new FileCredentialStore(path, { lockTimeoutMs: 100 });
		await expect(impatient.modify("p", async () => apiKey("x"))).rejects.toThrow(/lock held/);

		const old = new Date(Date.now() - 120_000);
		await utimes(`${path}.lock`, old, old);
		const store = new FileCredentialStore(path, { staleLockMs: 60_000 });
		await store.modify("p", async () => apiKey("x"));
		expect(await store.read("p")).toEqual(apiKey("x"));
		expect((await readdir(join(path, ".."))).sort()).toEqual(["auth.json"]);
	});
});
