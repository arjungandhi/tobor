import { appendFile, readFile } from "node:fs/promises";

/** One line of `feed.jsonl`: a stored revision. */
export type FeedEntry = {
	rev: string;
	revision: number;
	projectId: string;
	projectName: string;
	slug: string;
	title: string;
	tags: string[];
	hash: string;
	conversationId?: number;
	createdAt: number;
	files: number;
	size: number;
};

/** All feed entries in publish order; unreadable lines are skipped. */
export async function readFeed(file: string): Promise<FeedEntry[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: FeedEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as FeedEntry);
		} catch {}
	}
	return entries;
}

/** Append one entry as a JSON line. */
export async function appendFeed(file: string, entry: FeedEntry): Promise<void> {
	await appendFile(file, `${JSON.stringify(entry)}\n`);
}

/** Latest entry per `(projectId, slug)`, newest first, with revision counts. */
export function latestPerArtifact(entries: readonly FeedEntry[]): { latest: FeedEntry; revisions: number }[] {
	const byKey = new Map<string, { latest: FeedEntry; revisions: number }>();
	for (const entry of entries) {
		const key = `${entry.projectId}/${entry.slug}`;
		const seen = byKey.get(key);
		if (!seen) byKey.set(key, { latest: entry, revisions: 1 });
		else {
			seen.revisions++;
			if (entry.revision > seen.latest.revision) seen.latest = entry;
		}
	}
	return [...byKey.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}
