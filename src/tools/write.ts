import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { WriteToolInput } from "@earendil-works/pi-durable/tools";
import type { Schema } from "@earendil-works/pi-schema";
import type { FileToolDeps } from "./filetools.js";
import { decodeText } from "./hashline/lineio.js";
import { displayPath, header } from "./hashline/render.js";
import { hashFile } from "./hashline/tag.js";

/** pi-durable's `write` tool registration (`createWriteTool()`). */
export type WriteTool = ToolRegistration<Schema<WriteToolInput>>;

/** Strip `N:` prefixes copied from `read` output when every non-blank row has one and the numbers rise by 1. */
export function stripCopiedPrefixes(content: string): string {
	const rows = content.split("\n");
	let expected: number | undefined;
	let prefixed = 0;
	for (const row of rows) {
		if (row.replace(/\r$/, "").trim() === "") continue;
		const m = /^(\d+):/.exec(row);
		if (!m) return content;
		const n = Number(m[1]);
		if (expected !== undefined && n !== expected) return content;
		expected = n + 1;
		prefixed++;
	}
	if (prefixed === 0) return content;
	return rows.map((row) => row.replace(/^\d+:/, "")).join("\n");
}

/** Wrap pi-durable's `write` (keeping its file queue): strip copied prefixes, record `seen = "all"`, prepend `[path#TAG]`. */
export function writeWrapper(deps: FileToolDeps): (tool: WriteTool) => WriteTool {
	return (tool) => ({
		...tool,
		async execute(args, api, ctx) {
			const content = stripCopiedPrefixes(args.content);
			const result = await tool.execute({ ...args, content }, api, ctx);
			const env = api.env;
			if (result.isError || !env) return result;
			const abs = await env.absolutePath(args.path, ctx);
			const file = decodeText(new TextEncoder().encode(content));
			if (!abs.ok || !file) return result;
			const hash = hashFile(file);
			const conv = deps.store.conversation(api.conversationId);
			conv.invalidate(abs.value);
			conv.record(abs.value, hash, "all");
			const head = header(displayPath(args.path, abs.value, env.cwd), hash.tag);
			const text = (result.output ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
			return { ...result, output: [{ type: "text", text: text ? `${head}\n${text}` : head }] };
		},
	});
}
