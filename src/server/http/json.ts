import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiError, ImageAttachment } from "../../api/types.js";
import { HostError } from "../../host.js";

/** Maximum accepted request body. */
export const BODY_LIMIT = 1024 * 1024;

/** Most image attachments on one message. */
export const MAX_ATTACHMENTS = 8;

/** Most decoded bytes of one image attachment (5 MiB). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Accepted attachment media types. */
export const IMAGE_MIME_TYPES: readonly ImageAttachment["mimeType"][] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Body limit for routes that take attachments: `BODY_LIMIT` for the fields plus the base64 of a full set of images. */
export const ATTACHMENTS_BODY_LIMIT = BODY_LIMIT + MAX_ATTACHMENTS * Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/** An HTTP-layer failure (bad input, unknown route) answered as an `ApiError`. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/** Write a JSON response. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
		...headers,
	});
	res.end(text);
}

/** Map any thrown value to a status and `ApiError`; unknown errors become 500 without details. */
export function toApiError(error: unknown): { status: number; body: ApiError } {
	if (error instanceof HostError) {
		const body: ApiError = { error: error.message, code: error.code };
		if (error.errors) body.errors = error.errors;
		return { status: error.status, body };
	}
	if (error instanceof HttpError) return { status: error.status, body: { error: error.message, code: error.code } };
	return { status: 500, body: { error: "internal error", code: "internal" } };
}

/** Answer `error` as JSON, logging unexpected failures. */
export function sendError(res: ServerResponse, error: unknown): void {
	const { status, body } = toApiError(error);
	if (status === 500) console.error("api: request failed:", error);
	if (res.headersSent) {
		res.destroy();
		return;
	}
	sendJson(res, status, body);
}

/** Read and parse a JSON body (empty body → `{}`); 413 past `BODY_LIMIT`, 400 on bad JSON. */
export async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > limit) throw new HttpError(413, "too_large", "request body too large");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, "too_large", "request body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HttpError(400, "invalid_json", "request body is not valid JSON");
	}
}

/** A JSON object body, else 400. */
export function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("body must be a JSON object");
	return value as Record<string, unknown>;
}

/** A 400 `invalid` error. */
export function invalid(message: string): HttpError {
	return new HttpError(400, "invalid", message);
}

/** Required string field. */
export function reqString(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	if (typeof v !== "string" || v === "") throw invalid(`${key} must be a non-empty string`);
	return v;
}

/** Optional string field. */
export function optString(body: Record<string, unknown>, key: string): string | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw invalid(`${key} must be a string`);
	return v;
}

/** Optional boolean field. */
export function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw invalid(`${key} must be a boolean`);
	return v;
}

/** Optional enum field. */
export function optEnum<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
		throw invalid(`${key} must be one of ${values.join(", ")}`);
	}
	return v as T;
}

/** Required enum field. */
export function reqEnum<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T {
	const v = optEnum(body, key, values);
	if (v === undefined) throw invalid(`${key} is required`);
	return v;
}

/** Parse a non-negative integer (path id or query number), else 400. */
export function parseInt10(text: string | null | undefined, name: string): number | undefined {
	if (text === null || text === undefined || text === "") return undefined;
	if (!/^\d+$/.test(text)) throw invalid(`${name} must be a non-negative integer`);
	const n = Number(text);
	if (!Number.isSafeInteger(n)) throw invalid(`${name} is out of range`);
	return n;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a base64 string already known to be well formed (length a multiple of 4). */
function decodedLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

/**
 * Optional image attachments: an array of at most `MAX_ATTACHMENTS` `{ type: "image", data, mimeType }` objects, `data`
 * standard padded base64 (no `data:` prefix) decoding to 1..`MAX_ATTACHMENT_BYTES` bytes, `mimeType` one of
 * `IMAGE_MIME_TYPES`. An empty array is the same as absent.
 */
export function optAttachments(body: Record<string, unknown>, key = "attachments"): ImageAttachment[] | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v)) throw invalid(`${key} must be an array`);
	if (v.length > MAX_ATTACHMENTS) throw invalid(`${key} must have at most ${MAX_ATTACHMENTS} items`);
	const out = v.map((item: unknown, i): ImageAttachment => {
		const at = `${key}[${i}]`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw invalid(`${at} must be an object`);
		const a = item as Record<string, unknown>;
		if (a.type !== "image") throw invalid(`${at}.type must be "image"`);
		const mimeType = a.mimeType;
		if (typeof mimeType !== "string" || !(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
			throw invalid(`${at}.mimeType must be one of ${IMAGE_MIME_TYPES.join(", ")}`);
		}
		const data = a.data;
		if (typeof data !== "string" || data === "" || data.length % 4 !== 0 || !BASE64.test(data)) {
			throw invalid(`${at}.data must be non-empty base64 without a data: prefix`);
		}
		if (decodedLength(data) > MAX_ATTACHMENT_BYTES) {
			throw invalid(`${at} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
		}
		return { type: "image", data, mimeType: mimeType as ImageAttachment["mimeType"] };
	});
	return out.length > 0 ? out : undefined;
}
