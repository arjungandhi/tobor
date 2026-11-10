import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { checkRequest, hostAllowed, originAllowed } from "../../src/server/http/guards.js";

const config = { allowed_hosts: ["127.0.0.1", "tobor.ts.net:8080", "[::1]"], allowed_origins: ["https://tobor.ts.net"] };

function req(method: string, headers: Record<string, string>): IncomingMessage {
	return { method, headers } as unknown as IncomingMessage;
}

describe("hostAllowed", () => {
	it("matches exact entries and port-less entries on any port", () => {
		expect(hostAllowed("127.0.0.1:4000", config.allowed_hosts)).toBe(true);
		expect(hostAllowed("127.0.0.1", config.allowed_hosts)).toBe(true);
		expect(hostAllowed("TOBOR.ts.net:8080", config.allowed_hosts)).toBe(true);
		expect(hostAllowed("tobor.ts.net:9090", config.allowed_hosts)).toBe(false);
		expect(hostAllowed("tobor.ts.net", config.allowed_hosts)).toBe(false);
		expect(hostAllowed("[::1]:4000", config.allowed_hosts)).toBe(true);
		expect(hostAllowed("evil.example", config.allowed_hosts)).toBe(false);
		expect(hostAllowed(undefined, config.allowed_hosts)).toBe(false);
	});
});

describe("originAllowed", () => {
	it("passes absent origins and allowlisted ones only", () => {
		expect(originAllowed(undefined, config.allowed_origins)).toBe(true);
		expect(originAllowed("https://tobor.ts.net/", config.allowed_origins)).toBe(true);
		expect(originAllowed("https://evil.example", config.allowed_origins)).toBe(false);
		expect(originAllowed("null", config.allowed_origins)).toBe(false);
	});
});

describe("checkRequest", () => {
	const host = { host: "127.0.0.1:4000" };
	it("rejects a bad Host on any method", () => {
		expect(checkRequest(req("GET", { host: "evil.example" }), config)?.code).toBe("forbidden_host");
	});
	it("ignores Origin on reads", () => {
		expect(checkRequest(req("GET", { ...host, origin: "https://evil.example" }), config)).toBeUndefined();
	});
	it("checks Origin on mutations and upgrades", () => {
		const evil = { ...host, origin: "https://evil.example", "content-type": "application/json" };
		expect(checkRequest(req("POST", evil), config)?.code).toBe("forbidden_origin");
		expect(checkRequest(req("GET", evil), config, true)?.code).toBe("forbidden_origin");
		expect(checkRequest(req("GET", { ...host, origin: "https://tobor.ts.net" }), config, true)).toBeUndefined();
	});
	it("requires a JSON content type on mutations", () => {
		expect(checkRequest(req("POST", host), config)?.status).toBe(415);
		expect(checkRequest(req("PUT", { ...host, "content-type": "text/plain" }), config)?.status).toBe(415);
		expect(checkRequest(req("PATCH", { ...host, "content-type": "application/json; charset=utf-8" }), config)).toBeUndefined();
		expect(checkRequest(req("DELETE", host), config)).toBeUndefined();
		expect(checkRequest(req("DELETE", { ...host, "content-length": "5" }), config)?.status).toBe(415);
	});
});
