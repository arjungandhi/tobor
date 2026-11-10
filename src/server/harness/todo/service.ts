import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { SessionId } from "../../../api/types.js";
import { type TodoDocValue, type TodoItem, TodoDoc } from "../../../docs.js";

/** One `todo` tool operation. */
export type TodoOp =
	| { op: "init"; items: string[] }
	| { op: "start"; id: string }
	| { op: "done"; id: string }
	| { op: "view" };

/** Apply `op` to `doc` in place; returns an error message for a bad id or empty init. */
export function applyTodo(doc: TodoDocValue, op: TodoOp): string | undefined {
	if (op.op === "view") return undefined;
	if (op.op === "init") {
		const texts = op.items.map((t) => t.trim()).filter((t) => t !== "");
		if (texts.length === 0) return "init needs at least one item";
		doc.items = texts.map((text, i) => ({ id: String(i + 1), text, status: "pending" }));
		return undefined;
	}
	const item = doc.items.find((t) => t.id === op.id);
	if (!item) return `no todo ${op.id}`;
	if (op.op === "start") {
		for (const t of doc.items) if (t.status === "doing" && t !== item) t.status = "pending";
		item.status = "doing";
	} else {
		item.status = "done";
	}
	return undefined;
}

/** The list as the model sees it: one line per item, `[ ]`, `[>]` or `[x]`. */
export function renderTodo(items: readonly Readonly<TodoItem>[]): string {
	if (items.length === 0) return "(no todos)";
	const mark = { pending: "[ ]", doing: "[>]", done: "[x]" } as const;
	return items.map((t) => `${mark[t.status]} ${t.id}. ${t.text}`).join("\n");
}

/** Read side for the UI: a session's todo list. */
export class Todos {
	constructor(private readonly host: () => { harness: Harness; ctx: Context }) {}

	/** Items of one conversation, empty when it has none. */
	async get(sessionId: SessionId): Promise<TodoItem[]> {
		const { harness, ctx } = this.host();
		const doc = await harness.snapshot(TodoDoc, sessionId as ConversationId, ctx);
		return (doc?.items ?? []).map((t) => ({ ...t }));
	}
}
