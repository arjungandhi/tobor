import type { Host } from "../../../host.js";
import { HttpError, optString, parseInt10, reqString } from "../json.js";
import { notFound, type Router } from "../router.js";

/** `.tobor/` history and diff; not yet on `AgentDataService`, so detected at runtime. */
export interface AgentDataHistory {
	/** Recent commits, newest first, optionally touching `path`. */
	history(options: { path?: string; limit?: number }): Promise<unknown>;
	/** Unified diff of `commit` (default HEAD), optionally limited to `path`. */
	diff(options: { commit?: string; path?: string }): Promise<unknown>;
}

/** `.tobor/` files, history and diff. */
export function toborRoutes(r: Router): void {
	r.on("GET", "/api/tobor/files/*path", async ({ host, params }) => {
		const file = await host.agentData.read(params.path ?? "");
		if (!file) throw notFound("file");
		return file;
	});

	r.on("PUT", "/api/tobor/files/*path", async ({ host, params, body }) => {
		const b = await body();
		return host.agentData.write(params.path ?? "", {
			content: typeof b.content === "string" ? b.content : reqString(b, "content"),
			sha: optString(b, "sha"),
			message: optString(b, "message"),
		});
	});

	r.on("DELETE", "/api/tobor/files/*path", async ({ host, params }) => host.agentData.remove(params.path ?? ""));

	r.on("GET", "/api/tobor/history", async ({ host, query }) =>
		history(host).history({ path: query.get("path") || undefined, limit: parseInt10(query.get("limit"), "limit") }),
	);

	r.on("GET", "/api/tobor/diff", async ({ host, query }) =>
		history(host).diff({ commit: query.get("commit") || undefined, path: query.get("path") || undefined }),
	);
}

function history(host: Host): AgentDataHistory {
	const data = host.agentData as Partial<AgentDataHistory>;
	if (typeof data.history !== "function" || typeof data.diff !== "function") {
		throw new HttpError(501, "not_implemented", ".tobor history is unavailable");
	}
	return data as AgentDataHistory;
}
