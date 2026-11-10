import type { Router } from "../router.js";

/** `GET /api/mcp`. */
export function mcpRoutes(r: Router): void {
	r.on("GET", "/api/mcp", async ({ host }) => host.mcp.status());
}
