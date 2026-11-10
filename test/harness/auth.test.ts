import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type OAuthAuth } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/load.js";
import { AuthService } from "../../src/server/auth.js";
import { FileCredentialStore } from "../../src/server/harness/credentials.js";

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

async function setup() {
	const credentials = new FileCredentialStore(join(await mkdtemp(join(tmpdir(), "tobor-auth-")), "auth.json"));
	const models = createModels({ credentials });
	const base = fauxProvider({ provider: "keyed", models: [{ id: "m" }] }).provider;
	models.setProvider(base);
	models.setProvider({ ...base, id: "oa", auth: { oauth } });
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

	it("lists the catalog with availability and defaults", async () => {
		const { auth } = await setup();
		const res = await auth.models();
		expect(res.models.find((m) => m.ref === "keyed/m")).toMatchObject({ provider: "keyed", id: "m", available: true });
		expect(res.defaults).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
	});
});
