// Replays a recorded watch fixture: initial view + every listener call's ops through chord's `applyImmutable`,
// checking after each call that the replica equals the `value` pi-durable delivered with it, and at the end the final view.
// `npx tsx spike/replay-fixture.ts [name]`
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { OUT } from "./common.ts";

const name = process.argv[2] ?? "bash-run";
const dir = `${OUT}/fixtures`;
let replica: unknown = JSON.parse(readFileSync(`${dir}/${name}.initial.json`, "utf8"));
const calls = readFileSync(`${dir}/${name}.ops.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
let mismatches = 0;
for (const [i, call] of calls.entries()) {
	if (call.kind !== "value") continue;
	replica = applyImmutable(replica, call.ops as Op[]);
	if (!isDeepStrictEqual(replica, call.value)) {
		mismatches++;
		console.log(`call #${i}: replica differs from delivered value`);
	}
}
const finalView = JSON.parse(readFileSync(`${dir}/${name}.view.json`, "utf8"));
console.log(`${name}: ${calls.length} calls replayed, ${mismatches} mismatches, final equal: ${isDeepStrictEqual(replica, finalView)}`);
