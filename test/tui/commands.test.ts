import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSummary, SessionSummary } from "../../src/api/types.js";
import { type CommandFrom, App as AppClass, type App, type Picked } from "../../src/tui/app.js";
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
	/** A fake App whose sessions picker answers with `/model`, then opens session #7 (Esc would now go up to the workspaces). */
	function fake(flowActive: boolean) {
		const picks = [{ command: "model" }, { key: "enter", value: { id: 7 } }];
		const calls: string[] = [];
		const froms: (CommandFrom | undefined)[] = [];
		const app = {
			session: { target: undefined },
			sessions: [],
			workspace: undefined,
			api: () => ({ sessions: async () => [] }),
			now: () => 0,
			lastSessionId: () => undefined,
			flash: vi.fn(),
			openSession: vi.fn(),
			pick: vi.fn(async () => picks.shift()),
			flowActive,
			runCommand: async (line: string, from?: CommandFrom) => void (calls.push(`run ${line}`), froms.push(from)),
			command: async (line: string, from?: CommandFrom) => void (calls.push(`command ${line}`), froms.push(from)),
		};
		return { app, calls, froms };
	}

	/** The real `continueCommand`, forwarding the line and the list's `from` target like the bound method does. */
	const bindContinue = (app: object): void => {
		(app as { continueCommand: unknown }).continueCommand = (line: string, from?: CommandFrom) => AppClass.prototype.continueCommand.call(app, line, from);
	};

	it("runs inside the open flow instead of being dropped by command()", async () => {
		const { app, calls } = fake(true);
		// Same body as the real `command`: exclusive() returns early while a flow is active.
		app.command = async (line) => void (app.flowActive || calls.push(`command ${line}`));
		bindContinue(app);
		await showSessions(app as unknown as App);
		expect(calls).toEqual(["run /model"]);
	});

	it("falls back to the guarded command() when no flow is active", async () => {
		const { app, calls, froms } = fake(false);
		bindContinue(app);
		await showSessions(app as unknown as App);
		expect(calls).toEqual(["command /model"]);
		expect(froms).toEqual([{ sessionId: undefined }]); // the list's target survives the fallback
	});
});

describe("session-scoped commands from the sessions list", () => {
	const row = (id: number, title: string, approval_mode = "ask") => ({ id, title, approval_mode, state: "idle", cwd: "/w", mode: "chat", kind: "session", usage: { cost: 0 }, updatedAt: 0 }) as unknown as SessionSummary;

	/**
	 * A fake App running the real command path over a sessions list of #3 and #5, with #3 open. Each `steps` entry answers one
	 * sessions picker: a slash command chosen on `rowIndex` (-1: no row, as on an empty list). When steps run out the list opens session #7 (Esc would go up to the workspaces).
	 */
	function fake(steps: { command: string; rowIndex: number }[], rows = [row(3, "three"), row(5, "five", "auto")], answers: { ask?: string; pick?: string } = {}) {
		const flashes: string[] = [];
		const patched: { id: number; req: unknown }[] = [];
		const asked: { title: string; initial: string | undefined }[] = [];
		const picked: string[] = [];
		const closed = vi.fn();
		const proto = AppClass.prototype as unknown as Record<string, unknown>;
		const app = {
			session: { target: { id: 3, title: "three" }, close: closed },
			sessions: [] as SessionSummary[],
			workspace: undefined,
			api: () => ({
				sessions: async () => rows,
				patchSession: async (id: number, req: unknown) => void patched.push({ id, req }),
			}),
			now: () => 0,
			lastSessionId: () => undefined,
			flash: (text: string) => void flashes.push(text),
			refreshSessions: async () => {},
			openSession: vi.fn(),
			flowActive: true,
			config: { prefs: { confirm_auto: false } },
			confirmAuto: async () => true,
			ask: async (title: string, options: { initial?: string } = {}) => {
				asked.push({ title, initial: options.initial });
				return answers.ask;
			},
			pick: vi.fn(async (title: string, items: { value: unknown }[]) => {
				const step = steps.shift();
				if (title.startsWith("sessions")) return step ? { key: "enter", command: step.command, value: items[step.rowIndex]?.value } : { key: "enter", value: { id: 7 } };
				picked.push(title);
				return answers.pick === undefined ? undefined : { key: "enter", value: answers.pick };
			}),
			continueCommand: undefined as unknown,
		};
		for (const name of ["continueCommand", "runCommand", "commandOnListed", "editSession"]) {
			(app as Record<string, unknown>)[name] = (...args: unknown[]) => (proto[name] as (...a: unknown[]) => unknown).apply(app, args);
		}
		const show = () => showSessions(app as unknown as App);
		return { show, flashes, patched, asked, picked, closed };
	}

	it("/archive patches the highlighted session, not the open one", async () => {
		const { show, patched, closed } = fake([{ command: "archive", rowIndex: 1 }]);
		await show();
		expect(patched).toEqual([{ id: 5, req: { archived: true } }]);
		expect(closed).not.toHaveBeenCalled(); // #3 stays open
	});

	it("/model and /workers are rejected: they work on the open session", async () => {
		const { show, flashes, patched } = fake([
			{ command: "model", rowIndex: 1 },
			{ command: "workers", rowIndex: 1 },
		]);
		await show();
		expect(flashes).toEqual(["✗ /model works on the open session: open the session first", "✗ /workers works on the open session: open the session first"]);
		expect(patched).toEqual([]);
	});

	it("a command from an empty list flashes 'no session highlighted'", async () => {
		const { show, flashes, patched } = fake([{ command: "archive", rowIndex: -1 }], []);
		await show();
		expect(flashes).toEqual(["✗ /archive: no session highlighted"]);
		expect(patched).toEqual([]);
	});

	it("/title with no argument prompts, pre-filled with the highlighted title, and patches that session", async () => {
		const { show, asked, patched } = fake([{ command: "title", rowIndex: 1 }], undefined, { ask: " renamed " });
		await show();
		expect(asked).toEqual([{ title: "rename #5", initial: "five" }]);
		expect(patched).toEqual([{ id: 5, req: { title: "renamed" } }]);
	});

	it("/title cancelled in the prompt patches nothing", async () => {
		const { show, patched, flashes } = fake([{ command: "title", rowIndex: 1 }]);
		await show();
		expect(patched).toEqual([]);
		expect(flashes).toEqual([]);
	});

	it("/approval with no argument picks the mode and patches the highlighted session", async () => {
		const { show, picked, patched } = fake([{ command: "approval", rowIndex: 0 }], undefined, { pick: "auto" });
		await show();
		expect(picked).toEqual(["#3 · approval mode"]);
		expect(patched).toEqual([{ id: 3, req: { approval_mode: "auto" } }]);
	});
});
