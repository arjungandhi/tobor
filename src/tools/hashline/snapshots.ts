import type { ConversationId } from "@earendil-works/pi-durable";
import type { FileHash } from "./tag.js";

/** Lines the model has been shown under a tag. */
export type Seen = Set<number> | "all";

/** What tobor remembers about one `(absPath, tag)`; never the content. */
export interface Snapshot {
	absPath: string;
	tag: string;
	fullHash: string;
	seen: Seen;
	at: number;
}

/** Outcome of checking an edit's tag against the current file. */
export type TagCheck =
	| { ok: true; seen: Seen }
	| { ok: false; kind: "unknown_tag" | "stale_tag" }
	| { ok: false; kind: "other_file_tag"; otherPath: string };

const key = (absPath: string, tag: string) => `${absPath}\0${tag}`;

/** One conversation's snapshots (LRU) and its no-op streak. */
export class ConversationSnapshots {
	private readonly entries = new Map<string, Snapshot>();
	private noop: { key: string; count: number } | undefined;

	constructor(private readonly capacity: number) {}

	/** The record for `(absPath, tag)`, refreshed in the LRU. */
	get(absPath: string, tag: string): Snapshot | undefined {
		const k = key(absPath, tag);
		const snap = this.entries.get(k);
		if (snap) {
			this.entries.delete(k);
			this.entries.set(k, snap);
		}
		return snap;
	}

	/** Record lines as seen under a version; same tag and hash union, a different hash replaces. */
	record(absPath: string, hash: FileHash, rows: Iterable<number> | "all"): Snapshot {
		const k = key(absPath, hash.tag);
		const prev = this.entries.get(k);
		this.entries.delete(k);
		let seen: Seen;
		if (rows === "all" || (prev?.fullHash === hash.fullHash && prev.seen === "all")) seen = "all";
		else {
			seen = prev?.fullHash === hash.fullHash ? new Set(prev.seen as Set<number>) : new Set<number>();
			for (const r of rows) seen.add(r);
		}
		const snap: Snapshot = { absPath, tag: hash.tag, fullHash: hash.fullHash, seen, at: Date.now() };
		this.entries.set(k, snap);
		while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
		return snap;
	}

	/** Drop every record of a path. */
	invalidate(absPath: string): void {
		for (const [k, snap] of this.entries) if (snap.absPath === absPath) this.entries.delete(k);
	}

	/** Validate an edit tag: a matching record, else the current file's own tag, else stale/other-file/unknown. */
	check(absPath: string, tag: string, current: FileHash): TagCheck {
		const snap = this.get(absPath, tag);
		if (snap && snap.fullHash === current.fullHash) return { ok: true, seen: snap.seen };
		if (tag === current.tag) return { ok: true, seen: new Set() };
		if (snap) return { ok: false, kind: "stale_tag" };
		for (const other of this.entries.values()) {
			if (other.tag === tag && other.absPath !== absPath) return { ok: false, kind: "other_file_tag", otherPath: other.absPath };
		}
		return { ok: false, kind: "unknown_tag" };
	}

	/** Count a no-op call; returns how many identical no-ops in a row this makes. */
	noteNoop(callKey: string): number {
		this.noop = this.noop?.key === callKey ? { key: callKey, count: this.noop.count + 1 } : { key: callKey, count: 1 };
		return this.noop.count;
	}

	/** End a no-op streak (any call that changed something). */
	resetNoop(): void {
		this.noop = undefined;
	}
}

/** Per-conversation snapshot stores, themselves bounded LRU. */
export class SnapshotStore {
	private readonly conversations = new Map<ConversationId, ConversationSnapshots>();

	constructor(
		private readonly perConversation = 64,
		private readonly maxConversations = 256,
	) {}

	/** The store of one conversation, created on first use. */
	conversation(id: ConversationId): ConversationSnapshots {
		let c = this.conversations.get(id);
		if (c) this.conversations.delete(id);
		else c = new ConversationSnapshots(this.perConversation);
		this.conversations.set(id, c);
		while (this.conversations.size > this.maxConversations) {
			this.conversations.delete(this.conversations.keys().next().value!);
		}
		return c;
	}
}
