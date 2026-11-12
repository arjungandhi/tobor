import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactsService } from "../../src/artifacts/service.js";
import { EventBus } from "../../src/events.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tobor-art-svc-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ArtifactsService.list conversations filter", () => {
	const setup = () => {
		const home = mkdtempSync(join(root, "home-"));
		const cwd = mkdtempSync(join(root, "proj-"));
		const service = new ArtifactsService({
			paths: { artifactsFeed: join(home, "feed.jsonl"), artifactsStore: join(home, "store"), artifactsPdf: join(home, "pdf") },
			events: new EventBus(),
			artifactsUrl: () => "http://x",
		});
		const publish = (slug: string, body: string, conversationId?: number) => {
			const bundle = join(cwd, ".tobor", "artifacts", slug);
			mkdirSync(bundle, { recursive: true });
			writeFileSync(join(bundle, "index.html"), `<html><head><title>${slug}</title></head><body>${body}</body></html>`);
			return service.publish({ cwd, slug, ...(conversationId === undefined ? {} : { conversationId }) });
		};
		return { service, publish };
	};
	const slugs = (list: { slug: string }[]) => list.map((a) => a.slug).sort();

	it("keeps only artifacts published by the given conversations", async () => {
		const { service, publish } = setup();
		await publish("mine", "1", 5);
		await publish("worker", "1", 9);
		await publish("other", "1", 7);
		await publish("anon", "1");
		expect(slugs(await service.list())).toEqual(["anon", "mine", "other", "worker"]);
		expect(slugs(await service.list({ conversations: [5, 9] }))).toEqual(["mine", "worker"]);
		expect(slugs(await service.list({ conversations: [7] }))).toEqual(["other"]);
		expect(await service.list({ conversations: [] })).toEqual([]);
	});

	it("still lists an artifact whose older revision came from the session", async () => {
		const { service, publish } = setup();
		const first = await publish("deck", "1", 5);
		const second = await publish("deck", "2", 7);
		expect(second.artifact.revision).toBe(2);
		const [mine] = await service.list({ conversations: [5] });
		expect(mine).toMatchObject({ slug: "deck", revisions: 1, latest: { rev: first.artifact.rev, revision: 1, conversationId: 5 } });
		const [both] = await service.list({ conversations: [5, 7] });
		expect(both).toMatchObject({ slug: "deck", revisions: 2, latest: { revision: 2 } });
	});

	it("combines with the project filter", async () => {
		const { service, publish } = setup();
		const a = await publish("a", "1", 5);
		expect(await service.list({ projectId: "proj_none", conversations: [5] })).toEqual([]);
		expect(slugs(await service.list({ projectId: a.artifact.projectId, conversations: [5] }))).toEqual(["a"]);
	});
});
