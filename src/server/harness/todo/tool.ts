import { defineTool } from "@earendil-works/pi-durable";
import { arr, oneOf, obj, opt, str } from "@earendil-works/pi-schema";
import { TodoDoc } from "../../../docs.js";
import type { ToolModule } from "../../../tools/registry.js";
import { applyTodo, renderTodo, type TodoOp } from "./service.js";

/** The `todo` tool: `init` replaces the list, `start`/`done` move one item, `view` shows it. */
export const todoTool = defineTool({
	name: "todo",
	description:
		"Track your plan. `init` with `items` replaces the list; `start`/`done` with `id` mark one item " +
		"(one item is `doing` at a time); `view` shows it.",
	parameters: obj({
		op: oneOf(["init", "start", "done", "view"] as const),
		items: opt(arr(str())),
		id: opt(str()),
	}),
	async execute(args, api, context) {
		let op: TodoOp;
		if (args.op === "init") op = { op: "init", items: args.items ?? [] };
		else if (args.op === "view") op = { op: "view" };
		else if (args.id === undefined) return { output: [{ type: "text", text: `${args.op} needs id` }], isError: true };
		else op = { op: args.op, id: args.id };
		const result = await api.commit(async (tx) => {
			const doc = await tx.doc(TodoDoc, api.conversationId);
			const error = applyTodo(doc, op);
			return { error, items: doc.items.map((t) => ({ ...t })) };
		}, context);
		if (result.error) return { output: [{ type: "text", text: result.error }], isError: true };
		return { output: [{ type: "text", text: renderTodo(result.items) }], details: { items: result.items } };
	},
});

/** Module contributing `todo`. */
export const todoModule: ToolModule = { tools: [todoTool], docs: [TodoDoc] };
