import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRevision, ArtifactSummary, SessionId } from "../api/types.js";
import type { HomePaths } from "../config/home.js";
import type { EventBus } from "../events.js";
import type { ArtifactService, PdfResult } from "../host.js";
import { exportHtml, type ChromeProbe, probeChrome, renderPdf } from "./export.js";
import { type FeedEntry, latestPerArtifact } from "./feed.js";
import { projectInfo } from "./project.js";
import { ArtifactStore, slugError } from "./store.js";

const RETRY_AFTER_SECONDS = 5;

/** Construction inputs of `ArtifactsService`. */
export type ArtifactsServiceOptions = {
	paths: Pick<HomePaths, "artifactsFeed" | "artifactsStore" | "artifactsPdf">;
	events: EventBus;
	/** Base URL of the artifacts origin (`config.artifacts_url`), read per call. */
	artifactsUrl: () => string;
	now?: () => number;
};

/** Input of one publish from a cwd. */
export type PublishOptions = { cwd: string; slug: string; title?: string; tags?: string[]; conversationId?: number };

/** Result of one publish. */
export type PublishResult = { artifact: ArtifactRevision; deduped: boolean; dropped: string[]; latestUrl: string; bundleDir: string };

/** The artifact store, PDF cache and chrome probe behind `Host.artifacts`. */
export class ArtifactsService implements ArtifactService {
	readonly store: ArtifactStore;
	private probe: ChromeProbe = { found: false, error: "not probed" };
	private renderChain: Promise<unknown> = Promise.resolve();
	private readonly rendering = new Set<string>();
	private readonly failures = new Map<string, string>();

	constructor(private readonly options: ArtifactsServiceOptions) {
		this.store = new ArtifactStore(options.paths.artifactsFeed, options.paths.artifactsStore, options.now);
	}

	/** Boot: probe Chromium once. */
	async init(): Promise<ChromeProbe> {
		this.probe = await probeChrome();
		return this.probe;
	}

	chrome(): { found: boolean; version?: string; path?: string } {
		const { found, version, path } = this.probe;
		return { found, ...(version ? { version } : {}), ...(path ? { path } : {}) };
	}

	/** Viewer URL that always shows the latest revision. */
	latestUrl(projectId: string, slug: string): string {
		return `${this.base()}/art/${projectId}/${slug}`;
	}

	/** Bundle dir of `slug` for a cwd: `<git root>/.tobor/artifacts/<slug>`. */
	async bundleDir(cwd: string, slug: string): Promise<{ dir: string; projectId: string; root: string }> {
		const invalid = slugError(slug);
		if (invalid) throw new Error(invalid);
		const project = await projectInfo(cwd);
		return { dir: join(project.root, ".tobor", "artifacts", slug), projectId: project.projectId, root: project.root };
	}

	/** Store the bundle of `slug` as a new revision (or dedupe) and emit `artifact.published` for a new one. */
	async publish(options: PublishOptions): Promise<PublishResult> {
		const invalid = slugError(options.slug);
		if (invalid) throw new Error(invalid);
		const project = await projectInfo(options.cwd);
		const bundleDir = join(project.root, ".tobor", "artifacts", options.slug);
		if (!existsSync(bundleDir)) throw new Error(`No artifact bundle at ${bundleDir}. Create it with artifact_create first.`);
		const result = await this.store.submit({
			bundleDir,
			projectId: project.projectId,
			projectName: project.name,
			slug: options.slug,
			...(options.title === undefined ? {} : { title: options.title }),
			...(options.tags === undefined ? {} : { tags: options.tags }),
			...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
		});
		const artifact = this.toRevision(result.entry);
		if (!result.deduped) this.options.events.emit({ type: "artifact.published", artifact });
		return {
			artifact,
			deduped: result.deduped,
			dropped: result.dropped,
			latestUrl: this.latestUrl(project.projectId, options.slug),
			bundleDir,
		};
	}

	async list(filter: { projectId?: string; conversations?: readonly SessionId[] } = {}): Promise<ArtifactSummary[]> {
		const { projectId, conversations } = filter;
		const published = conversations && new Set(conversations);
		const entries = (await this.store.entries()).filter(
			(e) => (!projectId || e.projectId === projectId) && (!published || (e.conversationId !== undefined && published.has(e.conversationId))),
		);
		return latestPerArtifact(entries).map(({ latest, revisions }) => ({
			projectId: latest.projectId,
			slug: latest.slug,
			title: latest.title,
			latest: this.toRevision(latest),
			revisions,
			url: this.latestUrl(latest.projectId, latest.slug),
		}));
	}

	async revisions(projectId: string, slug: string): Promise<ArtifactRevision[]> {
		return (await this.store.entries())
			.filter((e) => e.projectId === projectId && e.slug === slug)
			.sort((a, b) => b.revision - a.revision)
			.map((e) => this.toRevision(e));
	}

	async revision(rev: string): Promise<ArtifactRevision | undefined> {
		const entry = await this.entry(rev);
		return entry && this.toRevision(entry);
	}

	async latest(projectId: string, slug: string): Promise<ArtifactRevision | undefined> {
		return (await this.revisions(projectId, slug))[0];
	}

	async revisionDir(rev: string): Promise<string | undefined> {
		const entry = await this.entry(rev);
		if (!entry) return undefined;
		const dir = this.store.dirOf(entry);
		return existsSync(dir) ? dir : undefined;
	}

	async pdf(rev: string): Promise<PdfResult> {
		const path = join(this.options.paths.artifactsPdf, `${rev}.pdf`);
		if (existsSync(path)) return { status: "ready", path };
		if (this.rendering.has(rev)) return { status: "rendering", retryAfterSeconds: RETRY_AFTER_SECONDS };
		const failure = this.failures.get(rev);
		if (failure !== undefined) {
			this.failures.delete(rev);
			return { status: "unavailable", reason: failure };
		}
		if (!this.probe.found) return { status: "unavailable", reason: this.probe.error ?? "Chromium not found" };
		const dir = await this.revisionDir(rev);
		if (!dir) return { status: "unavailable", reason: `No revision ${rev}` };
		this.rendering.add(rev);
		const chrome = this.probe.path;
		const run = this.renderChain.then(async () => {
			await mkdir(this.options.paths.artifactsPdf, { recursive: true });
			const tmp = `${path}.tmp-${process.pid}`;
			try {
				await renderPdf(exportHtml(dir), tmp, chrome);
				await rename(tmp, path);
			} catch (error) {
				await rm(tmp, { force: true });
				this.failures.set(rev, error instanceof Error ? error.message : String(error));
			} finally {
				this.rendering.delete(rev);
			}
		});
		this.renderChain = run;
		return { status: "rendering", retryAfterSeconds: RETRY_AFTER_SECONDS };
	}

	/** Render (or reuse) the PDF of a revision and wait for it. */
	async waitPdf(rev: string): Promise<PdfResult> {
		const first = await this.pdf(rev);
		if (first.status !== "rendering") return first;
		await this.renderChain;
		return this.pdf(rev);
	}

	private async entry(rev: string): Promise<FeedEntry | undefined> {
		if (!/^rev_[0-9a-f]+$/.test(rev)) return undefined;
		return (await this.store.entries()).find((e) => e.rev === rev);
	}

	private base(): string {
		return this.options.artifactsUrl().replace(/\/+$/, "");
	}

	private toRevision(entry: FeedEntry): ArtifactRevision {
		const base = this.base();
		return {
			rev: entry.rev,
			revision: entry.revision,
			projectId: entry.projectId,
			slug: entry.slug,
			title: entry.title,
			tags: entry.tags,
			hash: entry.hash,
			...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
			createdAt: entry.createdAt,
			url: `${base}/art/r/${entry.rev}`,
			pdfUrl: `${base}/art/r/${entry.rev}.pdf`,
		};
	}
}
