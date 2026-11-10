// Conventions for tool modules: each `src/tools/*.ts` (and approvals, schedules, workers, mcp) exports a `ToolModule`;
// boot composes them into the single `tobor` extension, in module order (which is also section order).
import {
	type AnyTask,
	type ConversationDocToken,
	type Extension,
	type HookRegistration,
	type JsonObject,
	defineDoc as piDefineDoc,
	type PromptSection,
	type SessionDocToken,
	type ToolRegistration,
	type Wrap,
} from "@earendil-works/pi-durable";

/** A registered tool (`defineTool` result or a `CodingTools`/`create*Tool` registration). */
export type Tool = ToolRegistration;
/** A system prompt section (`section(key, render)`). */
export type Section = PromptSection;
/** A task hook (`hook(ToolTask, {...})`). */
export type Hook = HookRegistration;
/** A durable task definition (`defineTask`). */
export type TaskDef = AnyTask;
/** Any doc token (`defineDoc` result); listed so the node can enumerate tobor's docs. */
export type DocDef = { readonly definition: { readonly kind: string; readonly version: number } };

/** What one module contributes to the `tobor` extension. */
export interface ToolModule {
	/** Tools; names must be unique across modules (MCP tools are `mcp__<server>__<tool>`). */
	tools: Tool[];
	/** Prompt sections, rendered in composition order. */
	sections?: Section[];
	/** Task hooks (e.g. the approval `beforeTool`). */
	hooks?: Hook[];
	/** Durable task definitions (`tobor.worker`, `tobor.schedule`). */
	tasks?: TaskDef[];
	/** Doc tokens the module owns (informational; pi-durable needs no doc registration). */
	docs?: DocDef[];
	/** Wraps of same-named tools or sections (`wrapTool`, `wrapSection`). */
	wraps?: Wrap[];
}

/** Merge modules into one extension. Throws on duplicate tool, task or section names. */
export function composeExtension(name: string, modules: readonly ToolModule[]): Extension {
	const tools: Tool[] = [];
	const sections: Section[] = [];
	const hooks: Hook[] = [];
	const tasks: TaskDef[] = [];
	const wraps: Wrap[] = [];
	const seen = { tool: new Set<string>(), task: new Set<string>(), section: new Set<string>() };
	const once = (kind: keyof typeof seen, key: string) => {
		if (seen[kind].has(key)) throw new Error(`extension ${name}: duplicate ${kind} ${JSON.stringify(key)}`);
		seen[kind].add(key);
	};
	for (const m of modules) {
		for (const t of m.tools) {
			once("tool", t.name);
			tools.push(t);
		}
		for (const s of m.sections ?? []) {
			once("section", s.key);
			sections.push(s);
		}
		for (const t of m.tasks ?? []) {
			once("task", t.definition.name);
			tasks.push(t);
		}
		hooks.push(...(m.hooks ?? []));
		wraps.push(...(m.wraps ?? []));
	}
	return { name, tools, sections, hooks, tasks, wraps };
}

/** Every doc token the modules declare, deduplicated by kind. */
export function collectDocs(modules: readonly ToolModule[]): DocDef[] {
	const byKind = new Map<string, DocDef>();
	for (const m of modules) for (const d of m.docs ?? []) byKind.set(d.definition.kind, d);
	return [...byKind.values()];
}

type DocOptions<T extends JsonObject> = {
	/** Stable persisted kind, `tobor.<name>`. */
	kind: string;
	initial(): T;
	/** Default 1. Bump with a `migrate` that handles every older version. */
	version?: number;
	/** Default: throw for any older stored version (forces an explicit migration on a bump). */
	migrate?(value: JsonObject, fromVersion: number): T;
	/** Default: always store a full base (tobor docs are small). */
	checkpointWhen?(value: Readonly<T>): boolean;
};

/** Conversation-scoped, latest-only doc; `fork` default `current`. */
export function defineDoc<T extends JsonObject>(
	options: DocOptions<T> & { scope?: "conversation"; fork?: "current" | "initial" },
): ConversationDocToken<T>;
/** Session-wide singleton doc. */
export function defineDoc<T extends JsonObject>(options: DocOptions<T> & { scope: "session" }): SessionDocToken<T>;
/** `defineDoc` with tobor defaults: `version: 1`, a refusing `migrate`, `checkpointWhen: () => true`. */
export function defineDoc<T extends JsonObject>(
	options: DocOptions<T> & { scope?: "conversation" | "session"; fork?: "current" | "initial" },
): ConversationDocToken<T> | SessionDocToken<T> {
	const version = options.version ?? 1;
	const common = {
		kind: options.kind,
		version,
		initial: options.initial,
		migrate:
			options.migrate ??
			((_value: JsonObject, fromVersion: number): T => {
				throw new Error(`${options.kind}: no migration from version ${fromVersion} to ${version}`);
			}),
		checkpointWhen: options.checkpointWhen ?? (() => true),
	};
	if (options.scope === "session") return piDefineDoc<T>({ ...common, scope: "session" });
	return piDefineDoc<T>({ ...common, scope: "conversation", history: "latest", fork: options.fork ?? "current" });
}
