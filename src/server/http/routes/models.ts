import type { Router } from "../router.js";

/** `GET /api/models`. */
export function modelsRoutes(r: Router): void {
	r.on("GET", "/api/models", async ({ host }) => host.auth.models());
}
