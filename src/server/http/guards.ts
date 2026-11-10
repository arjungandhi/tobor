import type { IncomingMessage } from "node:http";

/** A rejected request: status and `ApiError` code. */
export type GuardFailure = { status: number; code: string; error: string };

const MUTATING: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

/** Whether `method` changes state. */
export function isMutating(method: string | undefined): boolean {
	return MUTATING[(method ?? "GET").toUpperCase()] === true;
}

/** `Host` header must equal an allowlist entry; an entry without a port matches any port. */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
	if (!hostHeader) return false;
	const host = hostHeader.trim().toLowerCase();
	const bare = stripPort(host);
	for (const entry of allowed) {
		const e = entry.trim().toLowerCase();
		if (e === host) return true;
		if (stripPort(e) === e && e === bare) return true;
	}
	return false;
}

/** A present `Origin` must be allowlisted (exact, trailing slash ignored); absent means a non-browser client. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
	if (origin === undefined) return true;
	const o = origin.trim().toLowerCase().replace(/\/+$/, "");
	return allowed.some((a) => a.trim().toLowerCase().replace(/\/+$/, "") === o);
}

/** Whether the request declares a JSON body. */
export function isJson(contentType: string | undefined): boolean {
	return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Check an API request (or WS upgrade) against the Host, Origin and content-type rules. */
export function checkRequest(
	req: IncomingMessage,
	config: { allowed_hosts: readonly string[]; allowed_origins: readonly string[] },
	upgrade = false,
): GuardFailure | undefined {
	if (!hostAllowed(req.headers.host, config.allowed_hosts)) {
		return { status: 403, code: "forbidden_host", error: "host not allowed" };
	}
	const mutating = isMutating(req.method);
	if ((upgrade || mutating) && !originAllowed(req.headers.origin, config.allowed_origins)) {
		return { status: 403, code: "forbidden_origin", error: "origin not allowed" };
	}
	if (!upgrade && mutating && !isJson(req.headers["content-type"]) && !bodylessDelete(req)) {
		return { status: 415, code: "unsupported_media_type", error: "content-type must be application/json" };
	}
	return undefined;
}

function bodylessDelete(req: IncomingMessage): boolean {
	if (req.method?.toUpperCase() !== "DELETE") return false;
	const len = req.headers["content-length"];
	return req.headers["transfer-encoding"] === undefined && (len === undefined || len === "0");
}

function stripPort(host: string): string {
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end === -1 ? host : host.slice(0, end + 1);
	}
	const colon = host.lastIndexOf(":");
	return colon === -1 || host.indexOf(":") !== colon ? host : host.slice(0, colon);
}
