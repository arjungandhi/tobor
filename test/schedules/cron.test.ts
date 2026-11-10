import { describe, expect, it } from "vitest";
import {
	cronError,
	fireDecision,
	graceMs,
	isValidZone,
	nextCronFire,
	nextFireAt,
	parseAt,
	zoneOffsetMs,
} from "../../src/server/harness/schedules/cron.js";
import { MAX_RUNS, pushRun, runPrompt, runRequestId } from "../../src/server/harness/schedules/task.js";
import { displayNextFire, validateSchedule } from "../../src/server/harness/schedules/service.js";
import type { ScheduleRecord } from "../../src/docs.js";

const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());

describe("cron", () => {
	it("validates 5-field expressions", () => {
		expect(cronError("0 9 * * 1-5")).toBeUndefined();
		expect(cronError("0 0 9 * * 1")).toContain("5 fields");
		expect(cronError("61 * * * *")).toContain("invalid cron");
	});

	it("computes the next fire in the schedule's zone", () => {
		const after = Date.parse("2026-01-15T12:00:00Z");
		expect(iso(nextCronFire("0 9 * * *", "UTC", after))).toBe("2026-01-16T09:00:00.000Z");
		expect(iso(nextCronFire("0 9 * * *", "America/New_York", after))).toBe("2026-01-15T14:00:00.000Z");
		expect(iso(nextCronFire("0 9 * * *", "Asia/Tokyo", after))).toBe("2026-01-16T00:00:00.000Z");
	});

	it("is strictly after the given instant", () => {
		const at = Date.parse("2026-01-15T09:00:00Z");
		expect(iso(nextCronFire("0 9 * * *", "UTC", at))).toBe("2026-01-16T09:00:00.000Z");
	});

	it("keeps wall time across DST changes", () => {
		// New York springs forward on 2026-03-08 and falls back on 2026-11-01.
		const before = Date.parse("2026-03-07T15:00:00Z");
		const first = nextCronFire("0 9 * * *", "America/New_York", before);
		const second = nextCronFire("0 9 * * *", "America/New_York", first);
		expect(iso(first)).toBe("2026-03-08T13:00:00.000Z");
		expect(second - first).toBe(24 * 3_600_000);
		const fall = nextCronFire("0 9 * * *", "America/New_York", Date.parse("2026-10-31T14:00:00Z"));
		expect(iso(fall)).toBe("2026-11-01T14:00:00.000Z");
	});

	it("skips a wall time that does not exist on the spring-forward day", () => {
		const fire = nextCronFire("30 2 * * *", "America/New_York", Date.parse("2026-03-08T05:00:00Z"));
		expect(new Date(fire).getTime()).toBeGreaterThan(Date.parse("2026-03-08T06:59:00Z"));
	});
});

describe("at", () => {
	it("treats offsets as absolute and bare times as wall time in tz", () => {
		expect(iso(parseAt("2026-06-01T09:00:00Z", "Asia/Tokyo"))).toBe("2026-06-01T09:00:00.000Z");
		expect(iso(parseAt("2026-06-01T09:00:00+02:00", "UTC"))).toBe("2026-06-01T07:00:00.000Z");
		expect(iso(parseAt("2026-06-01T09:00", "Europe/Berlin"))).toBe("2026-06-01T07:00:00.000Z");
		expect(iso(parseAt("2026-01-01T09:00", "Europe/Berlin"))).toBe("2026-01-01T08:00:00.000Z");
		expect(parseAt("tomorrow", "UTC")).toBeUndefined();
	});

	it("resolves a DST-gap wall time forward", () => {
		expect(iso(parseAt("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
	});

	it("measures zone offsets", () => {
		expect(zoneOffsetMs("Asia/Kolkata", Date.parse("2026-01-01T00:00:00Z"))).toBe(5.5 * 3_600_000);
		expect(isValidZone("Mars/Base")).toBe(false);
	});

	it("nextFireAt dispatches on cron or at", () => {
		expect(iso(nextFireAt({ at: "2026-06-01T09:00:00Z", tz: "UTC" }, 0))).toBe("2026-06-01T09:00:00.000Z");
		expect(iso(nextFireAt({ cron: "0 0 1 1 *", tz: "UTC" }, Date.parse("2026-06-01T00:00:00Z")))).toBe(
			"2027-01-01T00:00:00.000Z",
		);
		expect(nextFireAt({ tz: "UTC" }, 0)).toBeUndefined();
	});
});

describe("fire decisions", () => {
	const h = 3_600_000;
	it("fires within grace, skips misfires past it, then overlaps", () => {
		expect(fireDecision({ now: 10 * h, fireAt: 9 * h, graceMs: 2 * h, previousUnsettled: false })).toBe("fire");
		expect(fireDecision({ now: 10 * h, fireAt: 8 * h, graceMs: 2 * h, previousUnsettled: false })).toBe("fire");
		expect(fireDecision({ now: 10 * h + 1, fireAt: 8 * h, graceMs: 2 * h, previousUnsettled: false })).toBe("skipped_misfire");
		expect(fireDecision({ now: 10 * h + 1, fireAt: 8 * h, graceMs: 2 * h, previousUnsettled: true })).toBe("skipped_misfire");
		expect(fireDecision({ now: 10 * h, fireAt: 10 * h, graceMs: 2 * h, previousUnsettled: true })).toBe("skipped_overlap");
	});

	it("parses grace with a 2h default", () => {
		expect(graceMs(undefined)).toBe(2 * h);
		expect(graceMs("30m")).toBe(h / 2);
		expect(graceMs("garbage")).toBe(2 * h);
	});
});

describe("runs", () => {
	it("caps the run list, dropping the oldest", () => {
		const runs = Array.from({ length: MAX_RUNS }, (_, i) => ({ fireAt: i, status: "done" as const }));
		pushRun(runs, { fireAt: 999, status: "running" });
		expect(runs).toHaveLength(MAX_RUNS);
		expect(runs[0]?.fireAt).toBe(1);
		expect(runs.at(-1)?.fireAt).toBe(999);
	});

	it("prefixes the prompt with the fire time and keys the request by fire time", () => {
		const t = Date.parse("2026-02-03T04:05:06Z");
		expect(runPrompt(t, "check")).toBe("[scheduled run, fired 2026-02-03T04:05:06.000Z]\ncheck");
		expect(runRequestId("s1", t)).toBe(`s1:${t}`);
	});
});

describe("validateSchedule", () => {
	const base = { name: "n", cwd: "/w", prompt: "p" };

	it("requires exactly one of cron and at", () => {
		expect(validateSchedule(base, {}, { defaultTz: "UTC" }).errors[0]?.path).toBe("cron");
		expect(validateSchedule({ ...base, cron: "* * * * *", at: "2026-01-01T00:00Z" }, {}, { defaultTz: "UTC" }).errors[0]?.path).toBe(
			"cron",
		);
	});

	it("fills defaults", () => {
		expect(validateSchedule({ ...base, cron: "0 9 * * *" }, {}, { defaultTz: "Europe/Berlin" }).fields).toEqual({
			...base,
			cron: "0 9 * * *",
			tz: "Europe/Berlin",
			enabled: true,
		});
	});

	it("refuses auto approval from an agent but not from the operator", () => {
		const req = { ...base, cron: "0 9 * * *", approval_mode: "auto" as const };
		expect(validateSchedule(req, {}, { defaultTz: "UTC", fromAgent: true }).errors[0]?.path).toBe("approval_mode");
		expect(validateSchedule(req, {}, { defaultTz: "UTC" }).errors).toEqual([]);
	});

	it("switches timing kind on update", () => {
		const existing = { ...base, cron: "0 9 * * *", tz: "UTC", enabled: true };
		const { fields } = validateSchedule({ at: "2026-01-01T00:00:00Z" }, existing, { defaultTz: "UTC" });
		expect(fields?.at).toBe("2026-01-01T00:00:00Z");
		expect(fields?.cron).toBeUndefined();
	});

	it("reports bad tz, model, grace and at", () => {
		const { errors } = validateSchedule(
			{ ...base, at: "soon", tz: "Nowhere/Land", model: "x", misfire_grace: "forever" },
			{},
			{ defaultTz: "UTC" },
		);
		expect(errors.map((e) => e.path).sort()).toEqual(["misfire_grace", "model", "tz"]);
		expect(validateSchedule({ ...base, at: "soon" }, {}, { defaultTz: "UTC" }).errors[0]?.path).toBe("at");
	});

	it("hides next fire for disabled schedules and fired one-shots", () => {
		const record: ScheduleRecord = {
			id: "s",
			...base,
			at: "2030-01-01T00:00:00Z",
			tz: "UTC",
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
			runs: [],
		};
		expect(iso(displayNextFire(record, 0))).toBe("2030-01-01T00:00:00.000Z");
		expect(displayNextFire({ ...record, runs: [{ fireAt: 1, status: "done" }] }, 0)).toBeUndefined();
		expect(displayNextFire({ ...record, enabled: false }, 0)).toBeUndefined();
	});
});
