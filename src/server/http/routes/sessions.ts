import type { CreateSessionResponse, InputMode, PatchSessionRequest } from "../../../api/types.js";
import { APPROVAL_MODES, SESSION_MODES, THINKING_LEVELS } from "../../../config/schema.js";
import {
	ATTACHMENTS_BODY_LIMIT,
	HttpError,
	invalid,
	optAttachments,
	optBool,
	optEnum,
	optString,
	parseInt10,
	reqEnum,
	reqString,
} from "../json.js";
import { idParam, notFound, Reply, type Router } from "../router.js";

const INPUT_MODES: readonly InputMode[] = ["prompt", "steer", "follow_up"];

/** Session CRUD, input, abort and entries. */
export function sessionsRoutes(r: Router): void {
	r.on("GET", "/api/sessions", async ({ host, query }) => {
		const archived = query.get("archived");
		return host.sessions.list({ archived: archived === "1" || archived === "true" });
	});

	r.on("POST", "/api/sessions", async ({ host, body }) => {
		const b = await body(ATTACHMENTS_BODY_LIMIT);
		const attachments = optAttachments(b);
		const { id } = await host.sessions.create({
			cwd: reqString(b, "cwd"),
			prompt: optString(b, "prompt"),
			...(attachments ? { attachments } : {}),
			model: optString(b, "model"),
			thinking: optEnum(b, "thinking", THINKING_LEVELS),
			approvalMode: optEnum(b, "approval_mode", APPROVAL_MODES),
			mode: optEnum(b, "mode", SESSION_MODES),
		});
		return new Reply(201, { id } satisfies CreateSessionResponse);
	});

	r.on("GET", "/api/sessions/:id", async (ctx) => {
		const detail = await ctx.host.sessions.get(idParam(ctx));
		if (!detail) throw notFound("session");
		return detail;
	});

	r.on("PATCH", "/api/sessions/:id", async (ctx) => {
		const id = idParam(ctx);
		const b = await ctx.body();
		const patch: PatchSessionRequest = {};
		const title = optString(b, "title");
		const model = optString(b, "model");
		const thinking = optEnum(b, "thinking", THINKING_LEVELS);
		const approvalMode = optEnum(b, "approval_mode", APPROVAL_MODES);
		const mode = optEnum(b, "mode", SESSION_MODES);
		const archived = optBool(b, "archived");
		if (title !== undefined) patch.title = title;
		if (model !== undefined) patch.model = model;
		if (thinking !== undefined) patch.thinking = thinking;
		if (approvalMode !== undefined) patch.approval_mode = approvalMode;
		if (mode !== undefined) patch.mode = mode;
		if (archived !== undefined) await ctx.host.sessions.archive(id, archived);
		if (Object.keys(patch).length > 0) return ctx.host.sessions.patch(id, patch);
		const detail = await ctx.host.sessions.get(id);
		if (!detail) throw notFound("session");
		return detail;
	});

	r.on("DELETE", "/api/sessions/:id", async (ctx) => {
		await ctx.host.sessions.delete(idParam(ctx));
		return { ok: true };
	});

	r.on("POST", "/api/sessions/:id/input", async (ctx) => {
		const id = idParam(ctx);
		const b = await ctx.body(ATTACHMENTS_BODY_LIMIT);
		const attachments = optAttachments(b);
		// Text may be empty only alongside attachments.
		const content = attachments ? (optString(b, "content") ?? "") : reqString(b, "content");
		return ctx.host.sessions.input(id, {
			content,
			...(attachments ? { attachments } : {}),
			mode: reqEnum(b, "mode", INPUT_MODES),
			requestId: reqString(b, "requestId"),
		});
	});

	r.on("POST", "/api/sessions/:id/abort", async (ctx) => {
		await ctx.host.sessions.abort(idParam(ctx));
		return { ok: true };
	});

	r.on("GET", "/api/sessions/:id/complete", async (ctx) => {
		return ctx.host.sessions.complete(idParam(ctx), ctx.query.get("prefix") ?? "");
	});

	r.on("GET", "/api/sessions/:id/entries", async (ctx) => {
		const id = idParam(ctx);
		const q = ctx.query;
		const order = q.get("order") ?? "desc";
		if (order !== "asc" && order !== "desc") throw invalid("order must be asc or desc");
		const limit = parseInt10(q.get("limit"), "limit") ?? 50;
		if (limit < 1 || limit > 500) throw new HttpError(400, "invalid", "limit must be between 1 and 500");
		return ctx.host.sessions.entries(id, {
			minEntryId: parseInt10(q.get("minEntryId"), "minEntryId"),
			maxEntryId: parseInt10(q.get("maxEntryId"), "maxEntryId"),
			order,
			limit,
		});
	});
}
