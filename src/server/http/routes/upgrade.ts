import { requestRestart, upgradeSelf } from "../../update.js";
import type { Router } from "../router.js";

/** `POST /api/upgrade` (replace this binary with the latest release, then restart) and `POST /api/restart`. */
export function upgradeRoutes(r: Router): void {
	r.on("POST", "/api/upgrade", async () => upgradeSelf());
	r.on("POST", "/api/restart", async () => requestRestart());
}
