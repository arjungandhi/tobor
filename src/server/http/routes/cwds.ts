import type { Router } from "../router.js";

/** `GET /api/cwds` and `GET /api/complete?cwd=&prefix=` (session-less path completion; never 404s). */
export function cwdsRoutes(r: Router): void {
	r.on("GET", "/api/cwds", async ({ host }) => host.sessions.cwds());
	r.on("GET", "/api/complete", async ({ host, query }) => host.sessions.completeAt(query.get("cwd") || undefined, query.get("prefix") ?? ""));
}
