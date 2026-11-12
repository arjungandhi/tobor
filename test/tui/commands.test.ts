import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary } from "../../src/api/types.js";
import { App as AppClass, type App, type Picked } from "../../src/tui/app.js";
import { ApiClient } from "../../src/tui/client.js";
import { COMMANDS } from "../../src/tui/keys.js";
import { showArtifacts } from "../../src/tui/screens/artifacts.js";
import { showSessions } from "../../src/tui/screens/sessions.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("slash commands", () => {
	it("lists /upgrade and /restart once each", () => {
		const names = COMMANDS.map((cmd) => cmd.name);
		expect(names).toContain("upgrade");
		expect(names).toContain("restart");
		expect(new Set(names).size).toBe(names.length);
	});

	it("documents /artifacts [all]", () => {
		expect(COMMANDS.find((cmd) => cmd.name === "artifacts")?.argumentHint).toBe("[all]");
	});
});

describe("ApiClient.artifacts", () => {
	const requested = (): string[] => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				return new Response("[]", { status: 200 });
			}),
		);
		return urls;
	};

	it("builds the query from project and session", async () => {
		const urls = requested();
		const client = new ApiClient("http://node");
		await client.artifacts();
		await client.artifacts({ session: 3 });
		await client.artifacts({ project: "demo", session: 3 });
		expect(urls).toEqual(["http://node/api/artifacts", "http://node/api/artifacts?session=3", "http://node/api/artifacts?project=demo&session=3"]);
	});
});

describe("/artifacts scope", () => {
	const artifact = { title: "Report", projectId: "demo", slug: "report", revisions: 1, latest: { revision: 1, createdAt: 0 } } as unknown as ArtifactSummary;

	/** A fake App with the given open session; `answers` are the keys pressed in successive pickers. */
	function fake(target: unknown, answers: string[]) {
		const artifacts = vi.fn(async (_opts?: { session?: number }) => [artifact]);
		const picks: { title: string; hint: string | undefined; keys: string[] | undefined }[] = [];
		const app = {
			session: { target },
			api: () => ({ artifacts }),
			pick: vi.fn(async (title: string, items: { value: ArtifactSummary }[], options: { hint?: string; keys?: string[] }): Promise<Picked<ArtifactSummary> | undefined> => {
				picks.push({ title, hint: options.hint, keys: options.keys });
				const key = answers.shift();
				return key ? { key, value: items[0]?.value } : undefined;
			}),
		} as unknown as App;
		return { app, artifacts, picks };
	}

	it("inside a session requests ?session=<id> and offers the all toggle", async () => {
		const { app, artifacts, picks } = fake({ id: 7, title: "t" }, []);
		await showArtifacts(app);
		expect(artifacts).toHaveBeenCalledTimes(1);
		expect(artifacts).toHaveBeenCalledWith({ session: 7 });
		expect(picks[0]?.title).toBe("artifacts · #7");
		expect(picks[0]?.hint).toContain("a: all artifacts");
		expect(picks[0]?.keys).toContain("a");
	});

	it("uses the parent session when a worker is open", async () => {
		const { app, artifacts } = fake({ id: 9, title: "w", worker: { name: "w", parent: { id: 7, title: "t" } } }, []);
		await showArtifacts(app);
		expect(artifacts).toHaveBeenCalledWith({ session: 7 });
	});

	it("`a` re-opens with the unfiltered list, and `s` goes back", async () => {
		const { app, artifacts, picks } = fake({ id: 7, title: "t" }, ["a", "s"]);
		await showArtifacts(app);
		expect(artifacts.mock.calls.map((call) => call[0])).toEqual([{ session: 7 }, {}, { session: 7 }]);
		expect(picks.map((p) => p.title)).toEqual(["artifacts · #7", "artifacts · all", "artifacts · #7"]);
		expect(picks[1]?.hint).toContain("s: this session");
	});

	it("`all` requests the unfiltered list even inside a session", async () => {
		const { app, artifacts, picks } = fake({ id: 7, title: "t" }, []);
		await showArtifacts(app, "all");
		expect(artifacts).toHaveBeenCalledWith({});
		expect(picks[0]?.title).toBe("artifacts · all");
	});

	it("falls back to all, without a toggle, when no session is open", async () => {
		for (const scope of [undefined, "session" as const]) {
			const { app, artifacts, picks } = fake(undefined, []);
			await showArtifacts(app, scope);
			expect(artifacts).toHaveBeenCalledWith({});
			expect(picks[0]?.title).toBe("artifacts · all");
			expect(picks[0]?.keys).toEqual(["p", "v"]);
		}
	});
});

describe("slash command chosen from the sessions list", () => {
	/** A fake App whose sessions picker answers with `/model`, then closes. */
	function fake(flowActive: boolean) {
		const picks = [{ command: "model" }, undefined];
		const calls: string[] = [];
		const app = {
			session: { target: undefined },
			sessions: [],
			workspace: undefined,
			api: () => ({ sessions: async () => [] }),
			now: () => 0,
			lastSessionId: () => undefined,
			flash: vi.fn(),
			pick: vi.fn(async () => picks.shift()),
			flowActive,
			runCommand: async (line: string) => void calls.push(`run ${line}`),
			command: async (line: string) => void calls.push(`command ${line}`),
		};
		return { app, calls };
	}

	it("runs inside the open flow instead of being dropped by command()", async () => {
		const { app, calls } = fake(true);
		// Same body as the real `command`: exclusive() returns early while a flow is active.
		app.command = async (line) => void (app.flowActive || calls.push(`command ${line}`));
		(app as unknown as { continueCommand: unknown }).continueCommand = (line: string) => AppClass.prototype.continueCommand.call(app, line);
		await showSessions(app as unknown as App);
		expect(calls).toEqual(["run /model"]);
	});

	it("falls back to the guarded command() when no flow is active", async () => {
		const { app, calls } = fake(false);
		(app as unknown as { continueCommand: unknown }).continueCommand = (line: string) => AppClass.prototype.continueCommand.call(app, line);
		await showSessions(app as unknown as App);
		expect(calls).toEqual(["command /model"]);
	});
});
