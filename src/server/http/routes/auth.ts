import { reqString } from "../json.js";
import type { Router } from "../router.js";

/** Auth status and OAuth login; tokens never leave the AuthService. */
export function authRoutes(r: Router): void {
	r.on("GET", "/api/auth", async ({ host }) => host.auth.status());
	r.on("POST", "/api/auth/:provider/login/start", async ({ host, params }) => host.auth.loginStart(params.provider!));
	r.on("POST", "/api/auth/:provider/login/code", async ({ host, params, body }) =>
		host.auth.loginCode(params.provider!, reqString(await body(), "code")),
	);
}
