import { CronExpressionParser } from "cron-parser";
import { parseDuration } from "../../../config/load.js";

/** Default `misfire_grace`. */
export const DEFAULT_MISFIRE_GRACE = "2h";
const DEFAULT_GRACE_MS = 2 * 3_600_000;

/** The host's IANA zone. */
export function hostZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Validate a 5-field cron expression; returns an error message or undefined. */
export function cronError(expression: string): string | undefined {
	if (expression.trim().split(/\s+/).length !== 5) return "cron must have 5 fields (minute hour day month weekday)";
	try {
		CronExpressionParser.parse(expression, { tz: "UTC" });
		return undefined;
	} catch (error) {
		return `invalid cron: ${(error as Error).message}`;
	}
}

/** First cron fire strictly after `after` (epoch ms), evaluated in `tz`. */
export function nextCronFire(expression: string, tz: string, after: number): number {
	return CronExpressionParser.parse(expression, { tz, currentDate: new Date(after) }).next().getTime();
}

/** Offset of `tz` from UTC at `epoch`, in ms (positive east of UTC). */
export function zoneOffsetMs(tz: string, epoch: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(epoch));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return wall - Math.floor(epoch / 1000) * 1000;
}

/**
 * Parse an `at` time: ISO 8601 with `Z` or an offset is absolute; without one it is wall time in `tz`. A wall time
 * that falls in a DST gap resolves forward. Undefined when unparseable.
 */
export function parseAt(at: string, tz: string): number | undefined {
	if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at.trim())) {
		const t = Date.parse(at);
		return Number.isNaN(t) ? undefined : t;
	}
	const asUtc = Date.parse(`${at.trim()}Z`);
	if (Number.isNaN(asUtc)) return undefined;
	const first = asUtc - zoneOffsetMs(tz, asUtc);
	const second = asUtc - zoneOffsetMs(tz, first);
	return Math.max(first, second);
}

/** Timing fields of a schedule. */
export type Timing = { cron?: string; at?: string; tz: string };

/** Next fire time after `after` for a cron schedule, or the one-shot `at` time; undefined when unparseable. */
export function nextFireAt(timing: Timing, after: number): number | undefined {
	if (timing.cron !== undefined) return nextCronFire(timing.cron, timing.tz, after);
	if (timing.at !== undefined) return parseAt(timing.at, timing.tz);
	return undefined;
}

/** `misfire_grace` in ms (default 2h). */
export function graceMs(misfireGrace: string | undefined): number {
	return misfireGrace === undefined ? DEFAULT_GRACE_MS : (parseDuration(misfireGrace) ?? DEFAULT_GRACE_MS);
}

/** What the `create` phase does with a due fire. */
export type FireDecision = "fire" | "skipped_misfire" | "skipped_overlap";

/** Misfire beats overlap: a fire past its grace is skipped as a misfire; else one beside an unsettled run is an overlap. */
export function fireDecision(input: { now: number; fireAt: number; graceMs: number; previousUnsettled: boolean }): FireDecision {
	if (input.now - input.fireAt > input.graceMs) return "skipped_misfire";
	if (input.previousUnsettled) return "skipped_overlap";
	return "fire";
}
