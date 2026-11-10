import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type OAuthAuth } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/load.js";
import { AuthService } from "../../src/server/auth.js";
import { FileCredentialStore } from "../../src/server/harness/credentials.js";
import { nodeUnit, staleNodeHint } from "../../src/server/cli/login.js";

const oauth: OAuthAuth = {
	name: "Test OAuth",
	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "method",
			options: [
				{ id: "browser", label: "Browser login (default)" },
				{ id: "copy", label: "Copy code login (headless)" },
			],
		});
		if (method !== "copy") throw new Error(`picked ${method}`);
		interaction.notify({ type: "auth_url", url: "https://example.test/authorize", instructions: "paste the code" });
		const code = await interaction.prompt({ type: "manual_code", message: "code", signal: interaction.signal });
		if (code !== "good") throw new Error("invalid code");
		return { type: "oauth", refresh: "r", access: "a", expires: 123 };
	},
	refresh: async (credential) => credential,
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

/** A device-code flow (Copilot shape): a pre-URL text prompt, then `device_code`, then polling until approval. */
const deviceAnswers: string[] = [];
const deviceApproval = Promise.withResolvers<void>();
const deviceOAuth: OAuthAuth = {
	name: "Test device OAuth",
	async login(interaction) {
		deviceAnswers.push(await interaction.prompt({ type: "text", message: "Enterprise domain (blank for public)" }));
		interaction.notify({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://example.test/device" });
		await deviceApproval.promise; // polling for approval
		return { type: "oauth", refresh: "r", access: "d", expires: 456 };
	},
	refresh: async (credential) => credential,
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

async function setup() {
	const credentials = new FileCredentialStore(join(await mkdtemp(join(tmpdir(), "tobor-auth-")), "auth.json"));
	const models = createModels({ credentials });
	const base = fauxProvider({ provider: "keyed", models: [{ id: "m" }] }).provider;
	models.setProvider(base);
	models.setProvider({ ...base, id: "oa", auth: { oauth } });
	models.setProvider({ ...base, id: "dev", auth: { oauth: deviceOAuth } });
	const config = validateConfig(undefined, "/nonexistent").config;
	return { credentials, auth: new AuthService({ models, credentials, config: () => config }) };
}

describe("AuthService", () => {
	it("logs in with two calls and stores the credential", async () => {
		const { auth, credentials } = await setup();
		expect(await auth.loginStart("oa")).toEqual({ url: "https://example.test/authorize", instructions: "paste the code" });
		expect(await auth.loginCode("oa", " good\n")).toEqual({ ok: true, auth: { source: "oauth", expiresAt: 123, oauth: true } });
		expect(await credentials.read("oa")).toMatchObject({ type: "oauth", access: "a" });
		const status = await auth.status();
		expect(status.oa).toEqual({ source: "oauth", expiresAt: 123, oauth: true });
		expect(status.keyed).toEqual({ source: "env", oauth: false });
		await expect(auth.loginCode("oa", "good")).rejects.toMatchObject({ status: 409 });
	});

	it("reports a bad code and forgets the login", async () => {
		const { auth } = await setup();
		await auth.loginStart("oa");
		await expect(auth.loginCode("oa", "bad")).rejects.toMatchObject({ status: 400, code: "login_failed" });
		await expect(auth.loginCode("oa", "good")).rejects.toMatchObject({ status: 409 });
	});

	it("rejects unknown providers and providers without OAuth", async () => {
		const { auth } = await setup();
		await expect(auth.loginStart("nope")).rejects.toMatchObject({ status: 404 });
		await expect(auth.loginStart("keyed")).rejects.toMatchObject({ status: 400, code: "no_oauth" });
		await expect(auth.loginCode("oa", "x")).rejects.toMatchObject({ status: 409 });
	});

	it("restarts a login when started twice", async () => {
		const { auth } = await setup();
		await auth.loginStart("oa");
		await auth.loginStart("oa");
		expect((await auth.loginCode("oa", "good")).auth.source).toBe("oauth");
	});

	it("logs in through a device-code flow", async () => {
		const { auth, credentials } = await setup();
		expect(await auth.loginStart("dev")).toEqual({
			url: "https://example.test/device",
			instructions: "Enter the code WXYZ-1234 on that page; once approved, paste the same code here.",
		});
		expect(deviceAnswers).toEqual([""]);
		const done = auth.loginCode("dev", "WXYZ-1234");
		deviceApproval.resolve();
		expect((await done).auth).toEqual({ source: "oauth", expiresAt: 456, oauth: true });
		expect(await credentials.read("dev")).toMatchObject({ type: "oauth", access: "d" });
	});

	it("lists the catalog with availability and defaults", async () => {
		const { auth } = await setup();
		const res = await auth.models();
		expect(res.models.find((m) => m.ref === "keyed/m")).toMatchObject({ provider: "keyed", id: "m", available: true });
		expect(res.defaults).toEqual({ model: "anthropic/claude-fable-5", thinking: "high", approval_mode: "auto", mode: "director" });
	});
});

describe("tobor login stale-node hint", () => {
	const cli = { version: "1.0.0", build: "aaaaaaaaaaaa" };

	it("tells how to restart a node running another build", () => {
		expect(staleNodeHint(cli, { version: "1.0.0", build: "bbbbbbbbbbbb" }, "personal")).toBe(
			"note: the running node is tobor 1.0.0 (build bbbbbbbbbbbb), this CLI is 1.0.0 (build aaaaaaaaaaaa); restart the node to pick up a rebuilt binary: systemctl --user restart tobor@personal",
		);
		// A node from before `build` existed.
		expect(staleNodeHint(cli, { version: "1.0.0" }, undefined)).toContain("(build unknown)");
		expect(staleNodeHint(cli, { version: "1.0.0" }, undefined)).toContain("stop it and start `tobor node` again");
	});

	it("stays quiet for the same build, no node, or a source run", () => {
		expect(staleNodeHint(cli, { ...cli }, "personal")).toBeUndefined();
		expect(staleNodeHint(cli, undefined, "personal")).toBeUndefined();
		expect(staleNodeHint({ ...cli, build: "dev" }, { version: "1.0.0", build: "bbbbbbbbbbbb" }, "personal")).toBeUndefined();
		expect(staleNodeHint(cli, { version: "1.0.0", build: "dev" }, "personal")).toBeUndefined();
	});

	it("finds the tobor@<name> unit from the node env files", async () => {
		const config = await mkdtemp(join(tmpdir(), "tobor-units-"));
		await mkdir(join(config, "tobor", "nodes"), { recursive: true });
		await writeFile(join(config, "tobor", "nodes", "work.env"), "TOBOR_HOME=/srv/work\n");
		await writeFile(join(config, "tobor", "nodes", "personal.env"), "# personal\nTOBOR_HOME=/srv/personal/\n");
		expect(await nodeUnit("/srv/personal", { XDG_CONFIG_HOME: config })).toBe("personal");
		expect(await nodeUnit("/srv/other", { XDG_CONFIG_HOME: config })).toBeUndefined();
		expect(await nodeUnit("/srv/work", { XDG_CONFIG_HOME: join(config, "missing") })).toBeUndefined();
	});
});
