import { afterEach, describe, expect, it } from "vitest";
import type { Listener } from "../../src/server/http/server.js";
import { startApi } from "../../src/server/http/server.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, optAttachments } from "../../src/server/http/json.js";
import { fakeHost, http } from "./fake-host.js";

let servers: Listener[] = [];
afterEach(async () => {
	await Promise.all(servers.map((s) => s.close()));
	servers = [];
});

async function api(results: Record<string, unknown> = {}) {
	const f = fakeHost(results);
	const s = await startApi(f.host);
	servers.push(s);
	return { ...f, port: s.address.port };
}

/** A well-formed base64 string decoding to `bytes` bytes. */
function b64(bytes: number): string {
	return Buffer.alloc(bytes, 1).toString("base64");
}

const png = (bytes = 3) => ({ type: "image", data: b64(bytes), mimeType: "image/png" });

describe("optAttachments", () => {
	it("is undefined when absent or empty and passes valid images through", () => {
		expect(optAttachments({})).toBeUndefined();
		expect(optAttachments({ attachments: [] })).toBeUndefined();
		const items = [png(), { type: "image", data: b64(5), mimeType: "image/webp" }];
		expect(optAttachments({ attachments: items })).toEqual(items);
		for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
			expect(optAttachments({ attachments: [{ type: "image", data: "AAAA", mimeType }] })).toHaveLength(1);
		}
	});

	it("accepts exactly the limits", () => {
		expect(optAttachments({ attachments: Array.from({ length: MAX_ATTACHMENTS }, () => png()) })).toHaveLength(MAX_ATTACHMENTS);
		expect(optAttachments({ attachments: [png(MAX_ATTACHMENT_BYTES)] })).toHaveLength(1);
	});

	it("rejects too many, too large, bad types and bad base64", () => {
		const bad = (attachments: unknown) => () => optAttachments({ attachments });
		expect(bad(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => png()))).toThrow(/at most 8/);
		expect(bad([png(MAX_ATTACHMENT_BYTES + 1)])).toThrow(/larger than 5 MB/);
		expect(bad("nope")).toThrow(/must be an array/);
		expect(bad([null])).toThrow(/must be an object/);
		expect(bad([{ ...png(), type: "file" }])).toThrow(/type/);
		expect(bad([{ ...png(), mimeType: "image/svg+xml" }])).toThrow(/mimeType/);
		expect(bad([{ ...png(), mimeType: undefined }])).toThrow(/mimeType/);
		expect(bad([{ ...png(), data: "" }])).toThrow(/base64/);
		expect(bad([{ ...png(), data: 12 }])).toThrow(/base64/);
		expect(bad([{ ...png(), data: "data:image/png;base64,AAAA" }])).toThrow(/base64/);
		expect(bad([{ ...png(), data: "AAA" }])).toThrow(/base64/);
		expect(bad([{ ...png(), data: "AA!A" }])).toThrow(/base64/);
		expect(bad([{ ...png(), data: "A=AA" }])).toThrow(/base64/);
	});
});

describe("attachments over HTTP", () => {
	it("POST /api/sessions passes valid attachments, allows an empty prompt, and rejects violations with 400", async () => {
		const { port, calls } = await api({ "sessions.create": { id: 7, submissionId: 1 } });
		const attachments = [png()];
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", prompt: "see", attachments } })).status).toBe(201);
		expect(calls.at(-1)?.args).toEqual([expect.objectContaining({ cwd: "/w", prompt: "see", attachments })]);
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", prompt: "", attachments } })).status).toBe(201);
		expect(calls.at(-1)?.args).toEqual([expect.objectContaining({ prompt: "", attachments })]);

		const n = calls.length;
		const tooMany = Array.from({ length: 9 }, () => png());
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", attachments: tooMany } })).status).toBe(400);
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", attachments: [png(MAX_ATTACHMENT_BYTES + 1)] } })).status).toBe(400);
		expect((await http(port, "POST", "/api/sessions", { body: { cwd: "/w", attachments: [{ ...png(), mimeType: "image/bmp" }] } })).status).toBe(400);
		expect(calls).toHaveLength(n);
	});

	it("POST /api/sessions/:id/input passes attachments, allows empty content with them, and rejects violations with 400", async () => {
		const { port, calls } = await api({ "sessions.input": { submissionId: 9 } });
		const attachments = [png()];
		const ok = await http(port, "POST", "/api/sessions/7/input", { body: { content: "c", attachments, mode: "prompt", requestId: "r1" } });
		expect(ok.status).toBe(200);
		expect(calls.at(-1)?.args).toEqual([7, { content: "c", attachments, mode: "prompt", requestId: "r1" }]);
		const imageOnly = await http(port, "POST", "/api/sessions/7/input", { body: { content: "", attachments, mode: "prompt", requestId: "r2" } });
		expect(imageOnly.status).toBe(200);
		expect(calls.at(-1)?.args).toEqual([7, { content: "", attachments, mode: "prompt", requestId: "r2" }]);

		const n = calls.length;
		const send = (body: Record<string, unknown>) =>
			http(port, "POST", "/api/sessions/7/input", { body: { mode: "prompt", requestId: "r", ...body } });
		expect((await send({ content: "" })).status).toBe(400);
		expect((await send({ content: "c", attachments: Array.from({ length: 9 }, () => png()) })).status).toBe(400);
		expect((await send({ content: "c", attachments: [png(MAX_ATTACHMENT_BYTES + 1)] })).status).toBe(400);
		expect((await send({ content: "c", attachments: [{ ...png(), mimeType: "image/tiff" }] })).status).toBe(400);
		expect(calls).toHaveLength(n);
	});

	it("accepts bodies past 1 MiB when they carry attachments", async () => {
		const { port } = await api({ "sessions.input": { submissionId: 9 } });
		const attachments = [png(MAX_ATTACHMENT_BYTES)];
		const res = await http(port, "POST", "/api/sessions/7/input", { body: { content: "c", attachments, mode: "prompt", requestId: "big" } });
		expect(res.status).toBe(200);
	});
});
