import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
	ConversationTranscript,
	type EntryLoader,
	type EntryRecord,
	type LiveState,
	type TranscriptItem,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import type { WatchValue, WatchWindow } from "../api/types.js";

/** Lifecycle of a tool call as the transcript shows it. */
export type ToolStatus = "streaming" | "pending" | "approval" | "question" | "running" | "done" | "error";

/** One renderable transcript block; `key` is stable across updates of the same block. */
export type Block =
	| { kind: "earlier"; key: string }
	| { kind: "gap"; key: string; after: number; upTo: number }
	| { kind: "user"; key: string; text: string }
	| { kind: "assistant"; key: string; text: string; streaming: boolean }
	| { kind: "thinking"; key: string; text: string; streaming: boolean }
	| ToolBlock
	| { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string };

/** A tool call: arguments from the assistant message, progress from `pi.live.tools`, output from its result entry. */
export type ToolBlock = {
	kind: "tool";
	key: string;
	callId: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	output: string;
	droppedLines?: number;
};

type Part = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
	role?: string;
	content?: string | Part[];
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
};

/** Token and cost totals summed over `pi.usage`. */
export type ViewUsage = { tokens: number; cost: number };

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[image]" : "")).join("");
}

function messageOf(entry: EntryRecord): Message | undefined {
	return entry.model?.[0] as Message | undefined;
}

/** `pi.live` of a view (empty when absent). */
export function liveOf(docs: WatchValue["docs"] | undefined): LiveState {
	return (docs?.["pi.live"] ?? {}) as LiveState;
}

/** Sum `pi.usage.models` into tokens and USD. */
export function usageOf(docs: WatchValue["docs"] | undefined): ViewUsage {
	type ModelUsage = { totalTokens?: number; cost?: { total?: number } };
	const doc = docs?.["pi.usage"];
	const models = doc && typeof doc.models === "object" && doc.models !== null ? (doc.models as Record<string, ModelUsage>) : {};
	let tokens = 0;
	let cost = 0;
	for (const usage of Object.values(models)) {
		tokens += usage.totalTokens ?? 0;
		cost += usage.cost?.total ?? 0;
	}
	return { tokens, cost };
}

/**
 * Derive transcript blocks from transcript items and the view's docs. Tool calls are keyed by call id so a call keeps
 * its block from the streaming partial through its live slot to its result entry. `pending` holds call ids awaiting
 * operator approval and `asking` those of `ask_user` calls awaiting an answer.
 */
export function deriveBlocks(
	items: readonly TranscriptItem[],
	docs: WatchValue["docs"] | undefined,
	pending: ReadonlySet<string> = new Set(),
	asking: ReadonlySet<string> = new Set(),
): Block[] {
	const blocks: Block[] = [];
	const tools = new Map<string, ToolBlock>();

	const addTool = (callId: string, name: string, args: unknown, status: ToolStatus, key = `t:${callId}`): ToolBlock => {
		const existing = tools.get(callId);
		if (existing) return existing;
		const block: ToolBlock = { kind: "tool", key, callId, name, args, status, output: "" };
		tools.set(callId, block);
		blocks.push(block);
		return block;
	};

	const addAssistant = (message: Message, prefix: string, streaming: boolean): void => {
		const parts = Array.isArray(message.content) ? message.content : [];
		for (const [i, part] of parts.entries()) {
			if (part.type === "text" && part.text) blocks.push({ kind: "assistant", key: `${prefix}:${i}`, text: part.text, streaming });
			else if (part.type === "thinking" && part.thinking) {
				blocks.push({ kind: "thinking", key: `${prefix}:${i}`, text: part.thinking, streaming });
			} else if (part.type === "toolCall") {
				const callId = part.id || `${prefix}:${i}`;
				const block = addTool(callId, part.name ?? "tool", part.arguments, streaming ? "streaming" : "pending");
				block.args = part.arguments;
			}
		}
	};

	for (const item of items) {
		if (item.kind === "earlier") {
			blocks.push({ kind: "earlier", key: "earlier" });
			continue;
		}
		if (item.kind === "gap") {
			blocks.push({ kind: "gap", key: `gap:${item.after}`, after: item.after, upTo: item.upTo });
			continue;
		}
		const entry = item.entry;
		const message = messageOf(entry);
		switch (entry.kind) {
			case "pi.user":
				blocks.push({ kind: "user", key: `u:${entry.id}`, text: textOf(message?.content) });
				break;
			case "pi.assistant": {
				if (!message) break;
				addAssistant(message, `a:${entry.id}`, false);
				if (message.stopReason === "error") {
					blocks.push({ kind: "notice", key: `n:${entry.id}`, level: "error", text: `model error: ${message.errorMessage ?? "unknown"}` });
				} else if (message.stopReason === "aborted") {
					blocks.push({ kind: "notice", key: `n:${entry.id}`, level: "warning", text: "aborted" });
				} else if (message.stopReason === "length") {
					blocks.push({ kind: "notice", key: `n:${entry.id}`, level: "warning", text: "answer cut off at the output limit" });
				}
				break;
			}
			case "pi.tool-result": {
				if (!message) break;
				const callId = message.toolCallId ?? `r:${entry.id}`;
				const block = addTool(callId, message.toolName ?? "tool", undefined, "done");
				block.status = message.isError ? "error" : "done";
				block.output = textOf(message.content);
				break;
			}
			case "pi.reset":
				blocks.push({ kind: "notice", key: `n:${entry.id}`, level: "info", text: "context reset" });
				break;
			case "pi.compaction":
				blocks.push({ kind: "notice", key: `n:${entry.id}`, level: "info", text: "earlier context compacted" });
				break;
		}
	}

	const live = liveOf(docs);
	const partial = live.generation?.message as Message | undefined;
	if (partial) addAssistant(partial, "live", true);
	for (const slot of live.tools ?? []) {
		const block = addTool(slot.callId, slot.name, undefined, "pending");
		if (block.status === "done" || block.status === "error") continue;
		if (slot.status === "done") block.status = "done";
		else if (slot.status === "running") block.status = "running";
		else block.status = "pending";
		block.output = slot.output ?? "";
		if (slot.droppedLines) block.droppedLines = slot.droppedLines;
	}
	for (const block of tools.values()) {
		if ((block.status === "pending" || block.status === "streaming") && pending.has(block.callId)) block.status = "approval";
		else if ((block.status === "pending" || block.status === "streaming" || block.status === "running") && asking.has(block.callId)) {
			block.status = "question";
		}
	}
	if (live.generation?.retry) {
		blocks.push({ kind: "notice", key: "live:retry", level: "warning", text: `retrying: ${live.generation.retry.error}` });
	}
	if (live.compactions?.length) blocks.push({ kind: "notice", key: "live:compacting", level: "info", text: "compacting context…" });
	if (live.compactionFailure) {
		blocks.push({ kind: "notice", key: "live:compaction-failure", level: "warning", text: `compaction failed: ${live.compactionFailure.error}` });
	}
	if (live.runFailure) {
		const { reason, detail, taskId } = live.runFailure;
		blocks.push({ kind: "notice", key: `fail:${taskId}`, level: "error", text: `run ended without an answer: ${reason}${detail ? ` — ${detail}` : ""}` });
	}
	return blocks;
}

/** Page loader for `GET /api/sessions/:id/entries`, in pi-durable `EntryLoader` form. */
export type EntriesFetcher = (query: {
	minEntryId?: number;
	maxEntryId?: number;
	order: "asc" | "desc";
	limit: number;
}) => Promise<{ items: readonly EntryRecord[]; more: boolean }>;

/** Client replica of one conversation view: a snapshot plus applied Chord ops, merged into a growing transcript. */
export class ConversationReplica {
	private value: WatchValue | undefined;
	private readonly transcript: ConversationTranscript;
	private current: TranscriptView | undefined;

	constructor(fetchEntries: EntriesFetcher) {
		const load: EntryLoader = async (query, limit) => {
			const page = await fetchEntries({
				...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
				...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
				order: query.order === "ascending" ? "asc" : "desc",
				limit,
			});
			return page.more ? { items: page.items, next: {} } : { items: page.items };
		};
		this.transcript = new ConversationTranscript(load);
	}

	/** Replace the view with a `{t:"snapshot"}` value (first connect or reconnect). */
	snapshot(value: WatchValue): void {
		this.value = value;
		this.current = this.transcript.merge(value);
	}

	/** Apply one `{t:"ops"}` batch. */
	apply(ops: readonly Op[]): void {
		if (this.value === undefined) throw new Error("ops before snapshot");
		this.value = applyImmutable(this.value, ops);
		this.current = this.transcript.merge(this.value);
	}

	/** The current view (window), if a snapshot arrived. */
	get view(): WatchValue | undefined {
		return this.value;
	}

	/** Every transcript item the client holds, with earlier/gap markers. */
	get items(): readonly TranscriptItem[] {
		return this.current?.items ?? [];
	}

	/** The window to watch from after a disconnect. */
	get resume(): WatchWindow | undefined {
		return this.transcript.resume;
	}

	/** Whether a run is in progress (`pi.live.run` present). */
	get running(): boolean {
		return liveOf(this.value?.docs).run !== undefined;
	}

	/** Load the page before the oldest entry held. */
	async loadEarlier(): Promise<void> {
		this.current = await this.transcript.loadEarlier(BACKGROUND_CONTEXT);
	}

	/** Load the next page of a gap. */
	async fillGap(after: number, upTo: number): Promise<void> {
		const gap = this.items.find((item) => item.kind === "gap" && item.after === after && item.upTo === upTo);
		if (gap?.kind !== "gap") return;
		this.current = await this.transcript.fillGap(gap, BACKGROUND_CONTEXT);
	}

	/** Derived transcript blocks. */
	blocks(pending?: ReadonlySet<string>, asking?: ReadonlySet<string>): Block[] {
		return deriveBlocks(this.items, this.value?.docs, pending, asking);
	}
}
