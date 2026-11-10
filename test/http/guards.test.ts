import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { checkRequest } from "../../src/server/http/guards.js";

function req(method: string, headers: Record<string, string>): IncomingMessage {
	return { method, headers } as unknown as IncomingMessage;
}

describe("checkRequest", () => {
	const host = { host: "127.0.0.1:4000" };
	it("accepts any Host and Origin", () => {
		expect(checkRequest(req("GET", { host: "evil.example", origin: "https://evil.example" }))).toBeUndefined();
		expect(checkRequest(req("POST", { ...host, origin: "https://evil.example", "content-type": "application/json" }))).toBeUndefined();
	});
	it("requires a JSON content type on mutations", () => {
		expect(checkRequest(req("POST", host))?.status).toBe(415);
		expect(checkRequest(req("PUT", { ...host, "content-type": "text/plain" }))?.status).toBe(415);
		expect(checkRequest(req("PATCH", { ...host, "content-type": "application/json; charset=utf-8" }))).toBeUndefined();
		expect(checkRequest(req("DELETE", host))).toBeUndefined();
		expect(checkRequest(req("DELETE", { ...host, "content-length": "5" }))?.status).toBe(415);
	});
});
