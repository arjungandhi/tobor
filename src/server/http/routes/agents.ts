import type { Router } from "../router.js";

/** `GET /api/agents?cwd=`. */
export function agentsRoutes(r: Router): void {
	r.on("GET", "/api/agents", async ({ host, query }) => host.agentData.listAgents(query.get("cwd") || undefined));
}
