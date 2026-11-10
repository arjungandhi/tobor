import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ListenAddress } from "../../config/schema.js";
import type { Host } from "../../host.js";
import { checkRequest } from "./guards.js";
import { sendError, sendJson } from "./json.js";
import { Router } from "./router.js";
import { agentsRoutes } from "./routes/agents.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { artifactsRoutes, servePdf } from "./routes/artifacts.js";
import { authRoutes } from "./routes/auth.js";
import { cwdsRoutes } from "./routes/cwds.js";
import { mcpRoutes } from "./routes/mcp.js";
import { modelsRoutes } from "./routes/models.js";
import { schedulesRoutes } from "./routes/schedules.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { toborRoutes } from "./routes/tobor.js";
import { whoamiRoutes } from "./routes/whoami.js";
import { workersRoutes } from "./routes/workers.js";
import { ApiSockets } from "./ws.js";

/** A running listener. */
export type Listener = {
	/** Bound address (resolves port 0). */
	address: ListenAddress;
	/** Stop accepting, close sockets, and resolve once the server is closed. */
	close(): Promise<void>;
};

/** Handles one artifacts-origin request; resolves false when it did not answer (→ 404). */
export type ArtifactsHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Every `/api` REST route. */
export function apiRouter(): Router {
	const r = new Router();
	for (const register of [
		whoamiRoutes,
		sessionsRoutes,
		workersRoutes,
		approvalsRoutes,
		authRoutes,
		modelsRoutes,
		cwdsRoutes,
		toborRoutes,
		artifactsRoutes,
		schedulesRoutes,
		mcpRoutes,
		agentsRoutes,
	]) {
		register(r);
	}
	return r;
}

/** The API request handler: guards, then routing. */
export function apiHandler(host: Host, router = apiRouter()): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		const failure = checkRequest(req);
		if (failure) return sendJson(res, failure.status, { error: failure.error, code: failure.code });
		void router.handle(host, req, res);
	};
}

/** Start the API (REST + WS) on `config.listen`. */
export async function startApi(host: Host, at: ListenAddress = host.config.listen): Promise<Listener> {
	const sockets = new ApiSockets(host);
	const server = createServer(apiHandler(host));
	server.on("upgrade", (req, socket, head) => sockets.upgrade(req, socket, head));
	return listen(server, at, () => sockets.close());
}

/** Start the artifacts origin on `config.artifacts_listen`: PDF routes here, everything else via `handler`. */
export async function startArtifactsListener(
	host: Host,
	handler: ArtifactsHandler,
	at: ListenAddress = host.config.artifacts_listen,
): Promise<Listener> {
	const server = createServer((req, res) => {
		void (async () => {
			try {
				if ((await servePdf(host, req, res)) || (await handler(req, res))) return;
				if (!res.headersSent) sendJson(res, 404, { error: "not found", code: "not_found" });
			} catch (error) {
				sendError(res, error);
			}
		})();
	});
	server.on("upgrade", (_req, socket) => socket.destroy());
	return listen(server, at);
}

async function listen(server: Server, at: ListenAddress, beforeClose?: () => void): Promise<Listener> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(at.port, at.host, () => resolve());
	await promise;
	server.off("error", reject);
	const addr = server.address() as AddressInfo;
	return {
		address: { host: addr.address, port: addr.port },
		close: async () => {
			beforeClose?.();
			const closed = Promise.withResolvers<void>();
			server.close((error) => (error ? closed.reject(error) : closed.resolve()));
			server.closeAllConnections();
			await closed.promise;
		},
	};
}
