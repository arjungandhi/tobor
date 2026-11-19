import { describe, expect, it } from "vitest";
import type { PendingQuestion } from "../../src/api/types.js";
import { App } from "../../src/tui/app.js";
import { ApiRequestError, type ApiClient } from "../../src/tui/client.js";

type Seq = { fetch: number; event: number };
type Fake = {
	client: ApiClient | undefined;
	questions: PendingQuestion[];
	questionsSeq: Seq;
	questionsFailing: boolean;
	questionsErrorShown: boolean;
	flashes: string[];
	flash(message: string): void;
	latest: unknown;
	fetchQuestions: unknown;
	session: { rebuild(): void };
	changed(): void;
};

const proto = App.prototype as unknown as Record<string, (...args: never[]) => unknown>;

const q = (callId: string): PendingQuestion => ({ callId, conversationId: 1, sessionId: 1, question: callId }) as unknown as PendingQuestion;

function fake(client: unknown, questions: PendingQuestion[] = []): Fake {
	const self: Fake = {
		client: client as ApiClient,
		questions,
		questionsSeq: { fetch: 0, event: 0 },
		questionsFailing: false,
		questionsErrorShown: false,
		flashes: [],
		flash: (m) => void self.flashes.push(m),
		latest: proto.latest,
		fetchQuestions: proto.fetchQuestions,
		session: { rebuild() {} },
		changed() {},
	};
	return self;
}

const refreshQuestions = (self: Fake): Promise<void> => (proto.refreshQuestions as unknown as (this: Fake) => Promise<void>).call(self);

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("latest() staleness guard", () => {
	const latest = <T>(self: Fake, client: ApiClient, fetch: () => Promise<T>, seq: Seq): Promise<T | undefined> =>
		(proto.latest as unknown as (this: Fake, c: ApiClient, f: () => Promise<T>, s: Seq) => Promise<T | undefined>).call(self, client, fetch, seq);

	it("drops a fetch superseded by a newer one", async () => {
		const client = {} as ApiClient;
		const self = fake(client);
		const slow = deferred<string>();
		const first = latest(self, client, () => slow.promise, self.questionsSeq);
		const second = await latest(self, client, async () => "new", self.questionsSeq);
		slow.resolve("old");
		expect(second).toBe("new");
		expect(await first).toBeUndefined();
	});

	it("refetches when an event arrived mid-flight", async () => {
		const client = {} as ApiClient;
		const self = fake(client);
		let calls = 0;
		const result = await latest(
			self,
			client,
			async () => {
				if (++calls === 1) self.questionsSeq.event++;
				return calls;
			},
			self.questionsSeq,
		);
		expect(result).toBe(2);
	});
});

describe("questions never silently clear or resurrect", () => {
	it("a slow fetch cannot resurrect an answered question", async () => {
		const slow = deferred<PendingQuestion[]>();
		let n = 0;
		const client = { questions: () => (++n === 1 ? slow.promise : Promise.resolve([])) } as unknown as ApiClient;
		const self = fake(client, [q("a")]);
		const stale = refreshQuestions(self); // started while "a" was pending
		await refreshQuestions(self); // newer fetch: server says none left
		expect(self.questions).toEqual([]);
		slow.resolve([q("a")]);
		await stale;
		expect(self.questions).toEqual([]);
	});

	it("a failed fetch keeps the previous list and flashes once", async () => {
		const client = { questions: () => Promise.reject(new Error("boom")) } as unknown as ApiClient;
		const self = fake(client, [q("a")]);
		await refreshQuestions(self);
		await refreshQuestions(self);
		expect(self.questions).toEqual([q("a")]);
		expect(self.flashes).toEqual(["✗ questions: boom"]);
		expect(self.questionsFailing).toBe(true);
	});

	it("flashes again after a success ended the outage", async () => {
		let fail = true;
		const client = { questions: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve([q("a")])) } as unknown as ApiClient;
		const self = fake(client);
		await refreshQuestions(self);
		fail = false;
		await refreshQuestions(self);
		expect(self.questions).toEqual([q("a")]);
		expect(self.questionsFailing).toBe(false);
		fail = true;
		await refreshQuestions(self);
		expect(self.flashes).toHaveLength(2);
	});

	it("a 404 (node without ask_user) means no questions", async () => {
		const client = { questions: () => Promise.reject(new ApiRequestError(404, undefined, "nope")) } as unknown as ApiClient;
		const self = fake(client, [q("a")]);
		await refreshQuestions(self);
		expect(self.questions).toEqual([]);
		expect(self.flashes).toEqual([]);
	});
});
