import type { Router } from "../router.js";

/** `GET /api/whoami`. */
export function whoamiRoutes(r: Router): void {
	r.on("GET", "/api/whoami", async ({ host }) => host.whoami());
}
