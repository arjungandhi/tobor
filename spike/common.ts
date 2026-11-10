// Shared harness wiring for the step-1 spike. Run scripts with `npx tsx spike/<name>.ts` from the repo root,
// with ANTHROPIC_API_KEY exported for the process.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, type Extension, Harness, type HarnessSettings, type Report } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export const ctx = BACKGROUND_CONTEXT;
export const MODEL = { provider: "anthropic", modelId: "claude-haiku-4-5" } as const;
export const OUT = "spike/out";
/** The agent `cwd` must be absolute: tools resolve it against the env's own cwd (see REPORT.md, experiment 2). */
export const OUT_ABS = resolve(OUT);
mkdirSync(`${OUT}/fixtures`, { recursive: true });

export type OpenOptions = {
	file: string;
	settings?: HarnessSettings;
	extensions?: Extension[];
	onReport?: (report: Report) => void;
	models?: Models;
};

export async function openHarness(options: OpenOptions) {
	const registry = createRegistry();
	registry.install(CodingTools);
	for (const ext of options.extensions ?? []) registry.install(ext);
	const storage = await openNodeSqliteStorage(options.file);
	return Harness.open(
		storage,
		{
			models: options.models ?? builtinModels(),
			registry,
			settings: options.settings,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
			onReport: options.onReport,
		},
		ctx,
	);
}

/** Concatenated text blocks of an assistant entry's model message. */
export function assistantText(entry: { model?: readonly unknown[] } | undefined): string {
	const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
	return (message?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export function j(value: unknown): string {
	return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
