import {
	type ConversationId,
	defineTool,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentDefinition, WorkerState } from "../../../api/types.js";
import { type Config, parseModelRef } from "../../../config/schema.js";
import { SessionDoc, type WorkerRecord, WorkersDoc } from "../../../docs.js";
import type { Host } from "../../../host.js";
import type { ToolModule } from "../../../tools/registry.js";
import { selectTools } from "./agents.js";
import { assistantText, createWorkerHolder, type WorkerInput } from "./holder.js";
import { workerSummary } from "./service.js";

/** Director-only tools; never offered to workers. */
export const DIRECTOR_TOOLS = ["task", "wait", "agent_output", "agent_list", "agent_stop", "agent_send"] as const;

/** What the workers module reads from the node, at call time. */
export type WorkerHost = Pick<Host, "harness" | "config" | "events" | "agentData">;

/** One requested worker, as the `task` tool takes it. `model` (`provider/modelId`) overrides the agent's. */
export type TaskItem = { agent: string; name?: string; task: string; context?: string; model?: string };

/**
 * The model a worker runs: the `task` item's `model`, then `agents.model_overrides[agent]`, then the agent file's
 * `model`, then `defaults.worker_model`; undefined inherits the director's.
 */
export function resolveWorkerModel(
	item: Pick<TaskItem, "model">,
	def: Pick<AgentDefinition, "name" | "model">,
	config: Pick<Config, "agents" | "defaults">,
): string | undefined {
	return item.model ?? config.agents.model_overrides[def.name] ?? def.model ?? config.defaults.worker_model;
}

const LIVE: readonly WorkerState[] = ["starting", "running"];

/** Whether a worker record has not settled. */
export function isLive(record: Pick<WorkerRecord, "state">): boolean {
	return LIVE.includes(record.state);
}

/** The brief a worker receives: context, blank line, task. */
export function composeBrief(item: Pick<TaskItem, "task" | "context">): string {
	const context = item.context?.trim();
	return context ? `${context}\n\n${item.task.trim()}` : item.task.trim();
}

/** Whether a `task` call would spawn an `approval: auto` worker (the only case it needs approval in `ask`). */
export async function taskSpawnsAutoWorker(
	args: unknown,
	cwd: string,
	listAgents: (cwd: string) => Promise<AgentDefinition[]>,
): Promise<boolean> {
	if (typeof args !== "object" || args === null || !("tasks" in args) || !Array.isArray(args.tasks)) return false;
	const names = new Set(
		args.tasks.flatMap((t: unknown) =>
			typeof t === "object" && t !== null && "agent" in t && typeof t.agent === "string" ? [t.agent] : [],
		),
	);
	return (await listAgents(cwd)).some((a) => names.has(a.name) && a.approval === "auto");
}

/** `task`, `wait`, `agent_output`, `agent_list`, `agent_stop`, `agent_send` and the `tobor.worker` task. `host` is read lazily (the Harness opens later). */
export function workersModule(host: () => WorkerHost, options: { pollMs?: number } = {}): ToolModule {
	const holder = createWorkerHolder({
		...options,
		onChange: (directorId, workerId) => {
			void emitWorker(host(), directorId, workerId);
		},
	});

	const taskTool = defineTool({
		name: "task",
		description:
			"Spawn one-shot background workers. Each item gets a fresh conversation running the named agent " +
			"(see .tobor/agents). Returns ids at once; each worker's final answer arrives later as a message " +
			"`[worker <name> finished: <status>]`. Put every independent item in one call.",
		parameters: obj({
			tasks: arr(
				obj({
					agent: str({ description: "Agent name: fast, worker, scout, reviewer, or a custom one" }),
					name: opt(str({ description: "Short label; default <agent>-<id>" })),
					task: str({ description: "What to do, with acceptance criteria" }),
					context: opt(str({ description: "Shared background prepended to the task" })),
					model: opt(str({ description: "provider/modelId; overrides the agent's model" })),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(args, api, context) {
			const h = host();
			const agent = await api.agent(context);
			const cwd = agent.cwd;
			if (!cwd) return { output: [{ type: "text", text: "task: this session has no cwd" }], isError: true };
			const session = await api.snapshot(SessionDoc, api.conversationId, context);
			const agents = new Map((await h.agentData.listAgents(cwd)).map((a) => [a.name, a]));
			const available = api.registry.tools().map((t) => t.tool.name);
			const maxWorkers = h.config.defaults.max_workers;
			const directorId = api.conversationId;
			const results = await api.commit(async (tx) => {
				const doc = await tx.doc(WorkersDoc, directorId);
				let live = Object.values(doc.workers).filter(isLive).length;
				let seq = Object.keys(doc.workers).length;
				const out: { name: string; id?: string; error?: string }[] = [];
				for (const [i, item] of args.tasks.entries()) {
					const def = agents.get(item.agent);
					const label = item.name ?? item.agent;
					if (!def) {
						out.push({ name: label, error: `unknown agent ${item.agent} (have: ${[...agents.keys()].join(", ")})` });
						continue;
					}
					if (live >= maxWorkers) {
						out.push({ name: label, error: `max_workers (${maxWorkers}) reached; wait for a worker to finish` });
						continue;
					}
					const modelName = resolveWorkerModel(item, def, h.config);
					const model = modelName === undefined ? undefined : parseModelRef(modelName);
					if (modelName !== undefined && (!model || !api.models.getModel(model.provider, model.modelId))) {
						out.push({ name: label, error: `unknown model ${modelName}` });
						continue;
					}
					seq += 1;
					const id = `w${seq}`;
					const name = item.name ?? `${def.name}-${id}`;
					const input: WorkerInput = {
						workerId: id,
						name,
						agent: def.name,
						directorId,
						brief: composeBrief(item),
						requestId: `${api.callId}:${i}`,
						cwd,
						tools: selectTools(available, def.tools, DIRECTOR_TOOLS),
						instructions: def.body,
						approvalMode: def.approval === "auto" ? "auto" : (session?.approval_mode ?? h.config.defaults.approval_mode),
						maxTurns: def.max_turns ?? h.config.defaults.max_turns,
						...(model ? { model } : {}),
						...(def.thinking ? { thinking: def.thinking } : {}),
					};
					const holderTaskId = await tx.createTask(holder, input, {
						ownership: { kind: "conversation" },
						conversationId: directorId,
						background: true,
						abandonOnRestart: false,
					});
					doc.workers[id] = {
						id,
						name,
						agent: def.name,
						holderTaskId,
						requestId: input.requestId,
						state: "starting",
						createdAt: api.now(),
					};
					live += 1;
					out.push({ name, id });
				}
				return out;
			}, context);
			for (const r of results) if (r.id) void emitWorker(h, directorId, r.id);
			const text = results
				.map((r) => (r.id ? `${r.name} (${r.id}): started` : `${r.name}: error: ${r.error}`))
				.join("\n");
			const failed = results.every((r) => !r.id);
			return { output: [{ type: "text", text }], details: { workers: results }, ...(failed ? { isError: true } : {}) };
		},
	});

	const waitTool = defineTool({
		name: "wait",
		description:
			"End your turn until workers finish. Results are not returned here: each worker reports back as a new message.",
		parameters: obj({}),
		async execute(_args, api, context) {
			const doc = await api.snapshot(WorkersDoc, api.conversationId, context);
			const live = Object.values(doc?.workers ?? {}).filter(isLive);
			if (live.length === 0) return { output: [{ type: "text", text: "No workers are running." }] };
			const names = live.map((w) => `${w.name} (${w.id})`).join(", ");
			return {
				output: [{ type: "text", text: `Waiting on ${names}. Each result arrives as a message; ending turn.` }],
				control: { terminate: true },
			};
		},
	});

	const outputTool = defineTool({
		name: "agent_output",
		description:
			"A worker's state and final answer. With `before`/`limit`, also page its transcript newest first " +
			"(pass the returned `next` as `before` for older entries).",
		parameters: obj({
			id: str({ description: "Worker id from `task`" }),
			before: opt(int({ description: "Entry id to page before" })),
			limit: opt(int({ minimum: 1, maximum: 50 })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const doc = await api.snapshot(WorkersDoc, api.conversationId, context);
			const w = doc?.workers[args.id];
			if (!w) return { output: [{ type: "text", text: `No worker ${args.id}` }], isError: true };
			const head = `${w.name} (${w.id}, ${w.agent}): ${w.state}${w.reason ? ` (${w.reason})` : ""}`;
			const lines = [head, w.answer ?? (isLive(w) ? "(still running)" : "(no final text)")];
			let details: JsonObject = { worker: w };
			if ((args.before !== undefined || args.limit !== undefined) && w.conversationId !== undefined) {
				const conversation = await host().harness.conversation(w.conversationId as ConversationId, context);
				const page = await conversation?.entries(
					{ order: "descending", ...(args.before !== undefined ? { maxEntryId: (args.before - 1) as EntryId } : {}) },
					args.limit ?? 10,
					undefined,
					context,
				);
				const items = (page?.items ?? []).map((e) => ({ id: e.id as number, kind: e.kind, text: entryText(e) }));
				lines.push("", "transcript (newest first):", ...items.map((e) => `#${e.id} ${e.kind}: ${e.text}`));
				const next = items.at(-1)?.id;
				if (page?.next !== undefined && next !== undefined) lines.push(`next: ${next}`);
				details = { worker: w, entries: items, ...(next !== undefined ? { next } : {}) };
			}
			return { output: [{ type: "text", text: lines.join("\n") }], details };
		},
	});

	const listTool = defineTool({
		name: "agent_list",
		description:
			"List this session's workers with their state and answer. Ids work with `agent_output`, `agent_stop` and `agent_send`.",
		parameters: obj({}),
		replay: "safe",
		async execute(_args, api, context) {
			const doc = await api.snapshot(WorkersDoc, api.conversationId, context);
			const workers = sortWorkers(Object.values(doc?.workers ?? {}));
			if (workers.length === 0) return { output: [{ type: "text", text: "No workers in this session." }] };
			const lines = workers.map((w) => {
				const answer = w.answer?.split("\n", 1)[0] || (isLive(w) ? "(running)" : "(no final text)");
				return `${w.id} ${w.name} (${w.agent}): ${w.state}${w.reason ? ` (${w.reason})` : ""} — ${answer}`;
			});
			return { output: [{ type: "text", text: lines.join("\n") }], details: { workers } };
		},
	});

	const stopTool = defineTool({
		name: "agent_stop",
		description:
			"Stop live workers: one by `id`, or every live one with `all`. Each stopped worker reports back as a message " +
			"`[worker <name> finished: aborted (stopped)]`.",
		parameters: obj({
			id: opt(str({ description: "Worker id, e.g. w1" })),
			all: opt(bool({ description: "Stop every live worker" })),
		}),
		async execute(args, api, context) {
			if ((args.id === undefined) === (args.all !== true)) {
				return { output: [{ type: "text", text: "agent_stop: pass exactly one of `id` or `all`" }], isError: true };
			}
			const doc = await api.snapshot(WorkersDoc, api.conversationId, context);
			const records = Object.values(doc?.workers ?? {});
			const targets = args.id === undefined ? sortWorkers(records.filter(isLive)) : records.filter((w) => w.id === args.id);
			if (args.id !== undefined && targets.length === 0) {
				return { output: [{ type: "text", text: `No worker ${args.id}` }], isError: true };
			}
			if (targets.length === 0) return { output: [{ type: "text", text: "No workers are running." }] };
			const h = host();
			const stopped: string[] = [];
			const lines = await Promise.all(
				targets.map(async (w) => {
					if (!isLive(w)) return `${w.name} (${w.id}): already ${w.state}`;
					await h.harness.abortTask(w.holderTaskId as TaskId, context);
					stopped.push(w.id);
					return `${w.name} (${w.id}): stopping; the abort report arrives as a message`;
				}),
			);
			return { output: [{ type: "text", text: lines.join("\n") }], details: { stopped } };
		},
	});

	const sendTool = defineTool({
		name: "agent_send",
		description:
			"Send a follow-up message to a live worker to steer it. Its new answer arrives later as a message. " +
			"Finished workers cannot be steered: spawn a new `task`.",
		parameters: obj({
			id: str({ description: "Worker id from `task`" }),
			message: str({ description: "Follow-up for the worker" }),
		}),
		async execute(args, api, context) {
			const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true as const });
			const directorId = api.conversationId;
			const doc = await api.snapshot(WorkersDoc, directorId, context);
			const peek = doc?.workers[args.id];
			if (!peek) return fail(`No worker ${args.id}`);
			if (!isLive(peek)) return fail(`worker already ${peek.state}; spawn a new task`);
			if (peek.conversationId === undefined || peek.submissionId === undefined) return fail("still starting; retry shortly");
			const h = host();
			const conversation = await h.harness.conversation(peek.conversationId as ConversationId, context);
			if (!conversation) return fail(`worker conversation ${peek.conversationId} missing`);
			// One commit: the admission precedes the doc write, and documents may be read and written around it.
			const sent = await api.commit(async (tx) => {
				const w = (await tx.doc(WorkersDoc, directorId)).workers[args.id];
				if (!w) return `No worker ${args.id}`;
				if (!isLive(w)) return `worker already ${w.state}; spawn a new task`;
				const submissionId = await conversation.submit(tx, {
					type: "input",
					content: args.message,
					requestId: `${api.callId}:send`,
				});
				w.submissionId = submissionId;
				w.state = "running";
				return undefined;
			}, context);
			if (sent !== undefined) return fail(sent);
			void emitWorker(h, directorId, args.id);
			return {
				output: [{ type: "text", text: `${peek.name} (${peek.id}): sent; its answer arrives as a message` }],
				details: { worker: peek.id },
			};
		},
	});

	return {
		tools: [taskTool, waitTool, outputTool, listTool, stopTool, sendTool],
		tasks: [holder],
		docs: [WorkersDoc],
	};
}

function sortWorkers(records: readonly Readonly<WorkerRecord>[]): Readonly<WorkerRecord>[] {
	return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }));
}

function entryText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (typeof message !== "object" || message === null || !("role" in message)) return "";
	if (message.role === "assistant") {
		return truncate(assistantText(entry) || "(tool calls)");
	}
	if ("content" in message) {
		const content = message.content;
		if (typeof content === "string") return truncate(content);
		if (Array.isArray(content)) {
			return truncate(content.flatMap((c: unknown) => (typeof c === "object" && c !== null && "text" in c ? [String(c.text)] : [])).join(""));
		}
	}
	return "";
}

function truncate(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

async function emitWorker(host: WorkerHost, directorId: number, workerId: string): Promise<void> {
	const summary = await workerSummary(host.harness, directorId, workerId);
	if (summary) host.events.emit({ type: "worker.state", sessionId: directorId, worker: summary });
}
