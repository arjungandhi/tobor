import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiRequestError, wrapRequestError } from "../../src/tui/client.js";

describe("request error context", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("prefixes network failures with method and path and keeps the cause", () => {
		const cause = new TypeError("fetch failed");
		const err = wrapRequestError("GET", "/api/whoami", cause);
		expect(err.message).toBe("GET /api/whoami: fetch failed");
		expect(err.cause).toBe(cause);
		expect(err.name).toBe("TypeError");
		expect(err).not.toBeInstanceOf(ApiRequestError);
	});

	it("explains timeouts and keeps the TimeoutError name", () => {
		const err = wrapRequestError("POST", "/api/sessions", new DOMException("The operation timed out.", "TimeoutError"), 30_000);
		expect(err.message).toBe("POST /api/sessions: timed out after 30s");
		expect(err.name).toBe("TimeoutError");
	});

	it("appends a distinct cause message", () => {
		const err = wrapRequestError("GET", "/x", new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
		expect(err.message).toBe("GET /x: fetch failed (ECONNREFUSED)");
	});

	it("ApiClient wraps a rejected fetch", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("fetch failed");
		});
		await expect(new ApiClient("http://x").whoami()).rejects.toThrow("GET /api/whoami: fetch failed");
	});

	it("still throws ApiRequestError with status for HTTP errors", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "gone" }), { status: 404 }));
		const err = await new ApiClient("http://x").approvals().catch((e) => e);
		expect(err).toBeInstanceOf(ApiRequestError);
		expect(err.status).toBe(404);
		expect(err.message).toContain("GET /api/approvals: 404 gone");
	});
});
