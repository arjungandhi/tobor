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

/** An image attached to a message or tool result: base64 data and its MIME type. */
export type ImagePart = { data: string; mimeType: string };

/** One renderable transcript block; `key` is stable across updates of the same block. */
export type Block =
	| { kind: "earlier"; key: string }
	| { kind: "gap"; key: string; after: number; upTo: number }
	| { kind: "user"; key: string; text: string; images?: ImagePart[] }
	| { kind: "queued"; key: string; text: string; mode: "steer" | "followUp"; images?: ImagePart[] }
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
	images?: ImagePart[];
};

type Part = { type?: string; text?: string; data?: string; mimeType?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
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

/** Plain text of message content. Image parts become `[image]` unless `placeholder` is false (the caller renders them from `imagesOf`). */
function textOf(content: Message["content"], placeholder = true): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" && placeholder ? "[image]" : "")).join("");
}

/** The image parts of message content, in order (empty for string content or content without images). */
function imagesOf(content: Message["content"]): ImagePart[] {
	if (!Array.isArray(content)) return [];
	const images: ImagePart[] = [];
	for (const part of content) {
		if (part.type === "image" && typeof part.data === "string" && part.data !== "") {
			images.push({ data: part.data, mimeType: typeof part.mimeType === "string" && part.mimeType !== "" ? part.mimeType : "image/png" });
		}
	}
	return images;
}

function messageOf(entry: EntryRecord): Message | undefined {
	return entry.model?.[0] as Message | undefined;
}

/** `pi.live` of a view (empty when absent). */
export function liveOf(docs: WatchValue["docs"] | undefined): LiveState {
	return (docs?.["pi.live"] ?? {}) as LiveState;
}

/** Messages waiting in `pi.inbox` (internal `write` items excluded). */
function queuedOf(docs: WatchValue["docs"] | undefined): Array<{ id: string | number; mode: "steer" | "followUp"; content: Message["content"] }> {
	type Item = { id?: unknown; mode?: unknown; content?: Message["content"] };
	const items = docs?.["pi.inbox"]?.items;
	if (!Array.isArray(items)) return [];
	const queued: Array<{ id: string | number; mode: "steer" | "followUp"; content: Message["content"] }> = [];
	for (const item of items as Item[]) {
		if (item?.mode !== "steer" && item?.mode !== "followUp") continue;
		if (typeof item.id !== "string" && typeof item.id !== "number") continue;
		queued.push({ id: item.id, mode: item.mode, content: item.content });
	}
	return queued;
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

/** What one committed transcript item contributes: finished blocks, and tool calls/results that merge by call id. */
type Fragment =
	| { kind: "block"; block: Block }
	| { kind: "call"; callId: string; name: string; args: unknown }
	| { kind: "result"; callId: string; name: string; status: "done" | "error"; output: string; images: ImagePart[] };

/** Fragments of an item: pure in the item, so cached per item/entry object (committed entries never change). */
const fragmentCache = new WeakMap<object, readonly Fragment[]>();

function fragmentsOf(item: TranscriptItem): readonly Fragment[] {
	const key = item.kind === "entry" ? item.entry : item;
	const cached = fragmentCache.get(key);
	if (cached) return cached;
	const frags = computeFragments(item);
	fragmentCache.set(key, frags);
	return frags;
}

function computeFragments(item: TranscriptItem): Fragment[] {
	const frags: Fragment[] = [];
	const block = (b: Block): void => void frags.push({ kind: "block", block: b });
	if (item.kind === "earlier") {
		block({ kind: "earlier", key: "earlier" });
		return frags;
	}
	if (item.kind === "gap") {
		block({ kind: "gap", key: `gap:${item.after}`, after: item.after, upTo: item.upTo });
		return frags;
	}
	const entry = item.entry;
	const message = messageOf(entry);
	switch (entry.kind) {
		case "pi.user": {
			const images = imagesOf(message?.content);
			block({ kind: "user", key: `u:${entry.id}`, text: textOf(message?.content, false), ...(images.length > 0 ? { images } : {}) });
			break;
		}
		case "pi.assistant": {
			if (!message) break;
			const prefix = `a:${entry.id}`;
			for (const [i, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
				if (part.type === "text" && part.text) block({ kind: "assistant", key: `${prefix}:${i}`, text: part.text, streaming: false });
				else if (part.type === "thinking" && part.thinking) block({ kind: "thinking", key: `${prefix}:${i}`, text: part.thinking, streaming: false });
				else if (part.type === "toolCall") frags.push({ kind: "call", callId: part.id || `${prefix}:${i}`, name: part.name ?? "tool", args: part.arguments });
			}
			if (message.stopReason === "error") {
				block({ kind: "notice", key: `n:${entry.id}`, level: "error", text: `model error: ${message.errorMessage ?? "unknown"}` });
			} else if (message.stopReason === "aborted") {
				block({ kind: "notice", key: `n:${entry.id}`, level: "warning", text: "aborted" });
			} else if (message.stopReason === "length") {
				block({ kind: "notice", key: `n:${entry.id}`, level: "warning", text: "answer cut off at the output limit" });
			}
			break;
		}
		case "pi.tool-result":
			if (!message) break;
			frags.push({
				kind: "result",
				callId: message.toolCallId ?? `r:${entry.id}`,
				name: message.toolName ?? "tool",
				status: message.isError ? "error" : "done",
				output: textOf(message.content, false),
				images: imagesOf(message.content),
			});
			break;
		case "pi.reset":
			block({ kind: "notice", key: `n:${entry.id}`, level: "info", text: "context reset" });
			break;
		case "pi.compaction":
			block({ kind: "notice", key: `n:${entry.id}`, level: "info", text: "earlier context compacted" });
			break;
	}
	return frags;
}

/** The blocks of the committed items so far. Tool blocks are replaced (never mutated) when a result lands, so handed-out blocks stay valid. */
type Committed = { items: readonly TranscriptItem[]; blocks: Block[]; tools: Map<string, number> };

function extend(state: Committed, items: readonly TranscriptItem[]): void {
	const { blocks, tools } = state;
	for (let i = state.items.length; i < items.length; i++) {
		for (const frag of fragmentsOf(items[i] as TranscriptItem)) {
			if (frag.kind === "block") {
				blocks.push(frag.block);
				continue;
			}
			const at = tools.get(frag.callId);
			const existing = at === undefined ? undefined : (blocks[at] as ToolBlock);
			if (frag.kind === "call") {
				if (at === undefined || !existing) {
					tools.set(frag.callId, blocks.length);
					blocks.push({ kind: "tool", key: `t:${frag.callId}`, callId: frag.callId, name: frag.name, args: frag.args, status: "pending", output: "" });
				} else blocks[at] = { ...existing, args: frag.args };
				continue;
			}
			const base: ToolBlock = existing ?? { kind: "tool", key: `t:${frag.callId}`, callId: frag.callId, name: frag.name, args: undefined, status: "done", output: "" };
			const block: ToolBlock = { ...base, status: frag.status, output: frag.output, ...(frag.images.length > 0 ? { images: frag.images } : {}) };
			if (at === undefined) {
				tools.set(frag.callId, blocks.length);
				blocks.push(block);
			} else blocks[at] = block;
		}
	}
	state.items = items;
}

/**
 * Derives transcript blocks, incrementally: per-entry fragments are cached by entry (entries never change once
 * committed), and when the items only grew at the end just the new ones are folded into the previous committed blocks.
 * Unchanged entries keep their block objects across derivations. Live state (`pi.live`), approvals and the inbox are
 * layered over a copy on every call, as they change with every frame.
 */
export class BlockDeriver {
	private committed: Committed | undefined;

	derive(
		items: readonly TranscriptItem[],
		docs: WatchValue["docs"] | undefined,
		pending: ReadonlySet<string> = new Set(),
		asking: ReadonlySet<string> = new Set(),
	): Block[] {
		const base = this.commit(items);
		const out = base.blocks.slice();
		const extra = new Map<string, number>();
		const find = (callId: string): number | undefined => extra.get(callId) ?? base.tools.get(callId);
		const addTool = (callId: string, name: string, args: unknown, status: ToolStatus): number => {
			const found = find(callId);
			if (found !== undefined) return found;
			extra.set(callId, out.length);
			out.push({ kind: "tool", key: `t:${callId}`, callId, name, args, status, output: "" });
			return out.length - 1;
		};
		const edit = (at: number, patch: Partial<ToolBlock>): ToolBlock => {
			const block = { ...(out[at] as ToolBlock), ...patch };
			out[at] = block;
			return block;
		};

		const live = liveOf(docs);
		const partial = live.generation?.message as Message | undefined;
		if (partial) {
			const parts = Array.isArray(partial.content) ? partial.content : [];
			for (const [i, part] of parts.entries()) {
				if (part.type === "text" && part.text) out.push({ kind: "assistant", key: `live:${i}`, text: part.text, streaming: true });
				else if (part.type === "thinking" && part.thinking) out.push({ kind: "thinking", key: `live:${i}`, text: part.thinking, streaming: true });
				else if (part.type === "toolCall") edit(addTool(part.id || `live:${i}`, part.name ?? "tool", part.arguments, "streaming"), { args: part.arguments });
			}
		}
		for (const slot of live.tools ?? []) {
			const at = addTool(slot.callId, slot.name, undefined, "pending");
			const block = out[at] as ToolBlock;
			if (block.status === "done" || block.status === "error") continue;
			edit(at, {
				status: slot.status === "done" ? "done" : slot.status === "running" ? "running" : "pending",
				output: slot.output ?? "",
				...(slot.droppedLines ? { droppedLines: slot.droppedLines } : {}),
			});
		}
		// Only calls awaiting approval or an answer change here, so visit those instead of every tool.
		for (const callId of new Set([...pending, ...asking])) {
			const at = find(callId);
			if (at === undefined) continue;
			const { status } = out[at] as ToolBlock;
			if ((status === "pending" || status === "streaming") && pending.has(callId)) edit(at, { status: "approval" });
			else if ((status === "pending" || status === "streaming" || status === "running") && asking.has(callId)) edit(at, { status: "question" });
		}
		if (live.generation?.retry) {
			out.push({ kind: "notice", key: "live:retry", level: "warning", text: `retrying: ${live.generation.retry.error}` });
		}
		if (live.compactions?.length) out.push({ kind: "notice", key: "live:compacting", level: "info", text: "compacting context…" });
		if (live.compactionFailure) {
			out.push({ kind: "notice", key: "live:compaction-failure", level: "warning", text: `compaction failed: ${live.compactionFailure.error}` });
		}
		if (live.runFailure) {
			const { reason, detail, taskId } = live.runFailure;
			out.push({ kind: "notice", key: `fail:${taskId}`, level: "error", text: `run ended without an answer: ${reason}${detail ? ` — ${detail}` : ""}` });
		}
		for (const item of queuedOf(docs)) {
			const images = imagesOf(item.content);
			out.push({ kind: "queued", key: `q:${item.id}`, text: textOf(item.content, false), mode: item.mode, ...(images.length > 0 ? { images } : {}) });
		}
		return out;
	}

	/** The committed blocks for `items`: reused as is, extended when the items only grew at the end, else rebuilt (from cached fragments). */
	private commit(items: readonly TranscriptItem[]): Committed {
		const prev = this.committed;
		// Dropped while folding so a throw cannot leave a half-extended state behind.
		this.committed = undefined;
		let state: Committed;
		if (prev && prev.items.length <= items.length && prev.items.every((item, i) => item === items[i])) {
			state = prev;
		} else {
			state = { items: [], blocks: [], tools: new Map() };
		}
		if (state.items !== items) extend(state, items);
		this.committed = state;
		return state;
	}
}

/**
 * Derive transcript blocks from transcript items and the view's docs. Tool calls are keyed by call id so a call keeps
 * its block from the streaming partial through its live slot to its result entry. `pending` holds call ids awaiting
 * operator approval and `asking` those of `ask_user` calls awaiting an answer. (One-shot; a replica keeps a
 * `BlockDeriver` to derive incrementally.)
 */
export function deriveBlocks(
	items: readonly TranscriptItem[],
	docs: WatchValue["docs"] | undefined,
	pending: ReadonlySet<string> = new Set(),
	asking: ReadonlySet<string> = new Set(),
): Block[] {
	return new BlockDeriver().derive(items, docs, pending, asking);
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
	private readonly deriver = new BlockDeriver();
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
		// Both before either is assigned: a merge() that throws must not leave `value` and the transcript disagreeing.
		const current = this.transcript.merge(value);
		this.value = value;
		this.current = current;
	}

	/** Apply one `{t:"ops"}` batch. */
	apply(ops: readonly Op[]): void {
		if (this.value === undefined) throw new Error("ops before snapshot");
		const value = applyImmutable(this.value, ops);
		const current = this.transcript.merge(value);
		this.value = value;
		this.current = current;
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
		return this.deriver.derive(this.items, this.value?.docs, pending, asking);
	}
}
