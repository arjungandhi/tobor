import { idParam, type Router } from "../router.js";

/** `GET /api/sessions/:id/workers`. */
export function workersRoutes(r: Router): void {
	r.on("GET", "/api/sessions/:id/workers", async (ctx) => ctx.host.workers.list(idParam(ctx)));
}
