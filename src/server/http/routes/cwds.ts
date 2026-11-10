import type { Router } from "../router.js";

/** `GET /api/cwds`. */
export function cwdsRoutes(r: Router): void {
	r.on("GET", "/api/cwds", async ({ host }) => host.sessions.cwds());
}
