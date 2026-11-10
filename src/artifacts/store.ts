import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { appendFeed, type FeedEntry, readFeed } from "./feed.js";

/** Artifact slugs: lowercase letters, digits, dashes. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Bundle size limit in bytes. */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
/** Bundle file count limit. */
export const MAX_BUNDLE_FILES = 200;
/** Directories never copied into the store. */
export const SKIP_DIRS: Record<string, true> = { node_modules: true, ".git": true, dist: true, build: true, coverage: true, __pycache__: true };
/** Local scripts the scaffold vendors; every other local `.js` file is dropped on publish. */
export const VENDORED_SCRIPTS: Record<string, true> = { "assets/tailwind.js": true };

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;

/** One file of a bundle. */
export type BundleFile = { rel: string; abs: string; size: number };

/** Files a publish copies, plus what it dropped. */
export type BundleScan = { files: BundleFile[]; size: number; dropped: string[] };

/** Error for an invalid slug, or `undefined`. */
export function slugError(slug: string): string | undefined {
	return SLUG_RE.test(slug) ? undefined : `Invalid slug "${slug}": must match ${SLUG_RE.source}`;
}

/** Walk a bundle: skip `SKIP_DIRS`, symlinks and non-vendored `.js`; enforce the size and file limits. */
export async function scanBundle(dir: string): Promise<BundleScan> {
	const files: BundleFile[] = [];
	const dropped: string[] = [];
	let size = 0;
	const walk = async (abs: string, rel: string): Promise<void> => {
		const entries = await readdir(abs, { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const childAbs = join(abs, entry.name);
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!Object.hasOwn(SKIP_DIRS, entry.name)) await walk(childAbs, childRel);
				continue;
			}
			if (!entry.isFile()) {
				dropped.push(childRel);
				continue;
			}
			if (/\.m?js$/i.test(entry.name) && !Object.hasOwn(VENDORED_SCRIPTS, childRel)) {
				dropped.push(childRel);
				continue;
			}
			const info = await lstat(childAbs);
			files.push({ rel: childRel, abs: childAbs, size: info.size });
			size += info.size;
			if (files.length > MAX_BUNDLE_FILES) throw new Error(`Bundle has more than ${MAX_BUNDLE_FILES} files`);
			if (size > MAX_BUNDLE_BYTES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB`);
		}
	};
	await walk(dir, "");
	return { files, size, dropped };
}

/** sha256 over each file's relative path and content hash, in path order. */
export async function contentHash(files: readonly BundleFile[]): Promise<string> {
	const hash = createHash("sha256");
	for (const file of files) {
		const digest = createHash("sha256").update(await readFile(file.abs)).digest("hex");
		hash.update(`${file.rel}\0${digest}\n`);
	}
	return hash.digest("hex");
}

/** `<title>` of an HTML document, entity-decoded and trimmed. */
export function htmlTitle(html: string): string | undefined {
	const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	const title = raw
		?.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
	return title || undefined;
}

/** Input of one publish. */
export type SubmitOptions = {
	bundleDir: string;
	projectId: string;
	projectName: string;
	slug: string;
	title?: string;
	tags?: string[];
	conversationId?: number;
};

/** Result of one publish. */
export type SubmitResult = { entry: FeedEntry; deduped: boolean; dropped: string[] };

/** Revision store: `feed.jsonl` plus `store/<projectId>/<slug>/<rev>/`, guarded by a file lock. */
export class ArtifactStore {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly feedFile: string,
		readonly storeDir: string,
		private readonly now: () => number = Date.now,
	) {}

	/** Every feed entry in publish order. */
	entries(): Promise<FeedEntry[]> {
		return readFeed(this.feedFile);
	}

	/** Absolute directory of a stored revision. */
	dirOf(entry: Pick<FeedEntry, "projectId" | "slug" | "rev">): string {
		return join(this.storeDir, entry.projectId, entry.slug, entry.rev);
	}

	/** Copy a bundle in as the next revision, or return the latest one when nothing changed and it is still stored. */
	submit(options: SubmitOptions): Promise<SubmitResult> {
		const run = this.chain.then(() => this.locked(() => this.submitLocked(options)));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async submitLocked(options: SubmitOptions): Promise<SubmitResult> {
		const invalid = slugError(options.slug);
		if (invalid) throw new Error(invalid);
		const entryFile = join(options.bundleDir, "index.html");
		if (!existsSync(entryFile)) throw new Error(`No index.html in ${options.bundleDir}`);
		const scan = await scanBundle(options.bundleDir);
		const hash = await contentHash(scan.files);
		const title = options.title?.trim() || htmlTitle(await readFile(entryFile, "utf8")) || options.slug;
		const tags = [...new Set((options.tags ?? []).map((t) => t.trim()).filter(Boolean))];
		const prior = (await this.entries()).filter((e) => e.projectId === options.projectId && e.slug === options.slug);
		const latest = prior.reduce<FeedEntry | undefined>((a, e) => (!a || e.revision > a.revision ? e : a), undefined);
		if (latest && latest.hash === hash && latest.title === title && latest.tags.join("\0") === tags.join("\0") && existsSync(this.dirOf(latest))) {
			return { entry: latest, deduped: true, dropped: scan.dropped };
		}
		const entry: FeedEntry = {
			rev: `rev_${randomBytes(6).toString("hex")}`,
			revision: (latest?.revision ?? 0) + 1,
			projectId: options.projectId,
			projectName: options.projectName,
			slug: options.slug,
			title,
			tags,
			hash,
			...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
			createdAt: this.now(),
			files: scan.files.length,
			size: scan.size,
		};
		const final = this.dirOf(entry);
		const tmp = join(dirname(final), `.tmp-${entry.rev}`);
		try {
			for (const file of scan.files) {
				const target = join(tmp, file.rel);
				await mkdir(dirname(target), { recursive: true });
				await copyFile(file.abs, target);
			}
			await rename(tmp, final);
		} catch (error) {
			await rm(tmp, { recursive: true, force: true });
			throw error;
		}
		await appendFeed(this.feedFile, entry);
		return { entry, deduped: false, dropped: scan.dropped };
	}

	private async locked<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.feedFile), { recursive: true });
		await mkdir(this.storeDir, { recursive: true });
		const lock = `${this.feedFile}.lock`;
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				await (await open(lock, "wx")).close();
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
				if (age > LOCK_STALE_MS) await rm(lock, { force: true });
				else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
				else await sleep(25);
			}
		}
		try {
			return await fn();
		} finally {
			await rm(lock, { force: true });
		}
	}
}
