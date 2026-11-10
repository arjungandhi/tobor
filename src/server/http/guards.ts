import type { IncomingMessage } from "node:http";

/** A rejected request: status and `ApiError` code. */
export type GuardFailure = { status: number; code: string; error: string };

const MUTATING: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

/** Whether `method` changes state. */
export function isMutating(method: string | undefined): boolean {
	return MUTATING[(method ?? "GET").toUpperCase()] === true;
}

/** Whether the request declares a JSON body. */
export function isJson(contentType: string | undefined): boolean {
	return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Check an API request's content type: mutations must declare a JSON body. */
export function checkRequest(req: IncomingMessage): GuardFailure | undefined {
	const mutating = isMutating(req.method);
	if (mutating && !isJson(req.headers["content-type"]) && !bodylessDelete(req)) {
		return { status: 415, code: "unsupported_media_type", error: "content-type must be application/json" };
	}
	return undefined;
}

function bodylessDelete(req: IncomingMessage): boolean {
	if (req.method?.toUpperCase() !== "DELETE") return false;
	const len = req.headers["content-length"];
	return req.headers["transfer-encoding"] === undefined && (len === undefined || len === "0");
}
