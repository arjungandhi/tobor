import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "../../host.js";
import { asObject, HttpError, parseInt10, readJson, sendError, sendJson } from "./json.js";

/** What a route handler sees. */
export type RouteContext = {
	host: Host;
	req: IncomingMessage;
	res: ServerResponse;
	/** Decoded path parameters (`:name`, and `*name` for the rest of the path). */
	params: Record<string, string>;
	query: URLSearchParams;
	/** The JSON body as an object (400 otherwise); `limit` overrides the default body size cap. */
	body(limit?: number): Promise<Record<string, unknown>>;
};

/** A non-200 JSON reply. */
export class Reply {
	constructor(
		readonly status: number,
		readonly body: unknown,
		readonly headers: Record<string, string> = {},
	) {}
}

/** Return a value for 200 JSON, a `Reply`, or write `res` directly. */
export type Handler = (ctx: RouteContext) => Promise<unknown>;

type Segment = { kind: "lit"; text: string } | { kind: "param"; name: string } | { kind: "rest"; name: string };
type Route = { method: string; segments: Segment[]; handler: Handler };

/** Method + path-pattern routing for `/api`. */
export class Router {
	private readonly routes: Route[] = [];

	/** Register `handler` for `method` and a pattern like `/api/sessions/:id` or `/api/tobor/files/*path`. */
	on(method: string, pattern: string, handler: Handler): this {
		const segments = split(pattern).map((s): Segment => {
			if (s.startsWith(":")) return { kind: "param", name: s.slice(1) };
			if (s.startsWith("*")) return { kind: "rest", name: s.slice(1) };
			return { kind: "lit", text: s };
		});
		this.routes.push({ method, segments, handler });
		return this;
	}

	/** Dispatch; answers 404/405 for unknown routes and maps thrown errors. */
	async handle(host: Host, req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://local");
			const parts = split(url.pathname);
			let pathMatched = false;
			for (const route of this.routes) {
				const params = match(route.segments, parts);
				if (!params) continue;
				pathMatched = true;
				if (route.method !== req.method) continue;
				const ctx: RouteContext = {
					host,
					req,
					res,
					params,
					query: url.searchParams,
					body: async (limit) => asObject(await readJson(req, limit)),
				};
				const result = await route.handler(ctx);
				if (res.headersSent) return;
				if (result instanceof Reply) sendJson(res, result.status, result.body, result.headers);
				else sendJson(res, 200, result ?? { ok: true });
				return;
			}
			throw pathMatched
				? new HttpError(405, "method_not_allowed", "method not allowed")
				: new HttpError(404, "not_found", "no such route");
		} catch (error) {
			sendError(res, error);
		}
	}
}

/** A numeric path parameter, else 400. */
export function idParam(ctx: RouteContext, name = "id"): number {
	const n = parseInt10(ctx.params[name], name);
	if (n === undefined) throw new HttpError(400, "invalid", `${name} is required`);
	return n;
}

/** 404 `not_found` with `what` in the message. */
export function notFound(what: string): HttpError {
	return new HttpError(404, "not_found", `${what} not found`);
}

function split(path: string): string[] {
	return path.split("/").filter((s) => s !== "");
}

function match(segments: Segment[], parts: string[]): Record<string, string> | undefined {
	const params: Record<string, string> = {};
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		if (seg.kind === "rest") {
			params[seg.name] = parts.slice(i).map(decode).join("/");
			return params;
		}
		const part = parts[i];
		if (part === undefined) return undefined;
		if (seg.kind === "lit") {
			if (seg.text !== part) return undefined;
		} else {
			params[seg.name] = decode(part);
		}
	}
	return parts.length === segments.length ? params : undefined;
}

function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		throw new HttpError(400, "invalid", "malformed path");
	}
}
