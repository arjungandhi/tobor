// Experiment 4 driver: crash, resume, restart-limit, in-process abort, and approval of a `beforeTool` hook that awaits a
// human. Runs spike/hook-child.ts as `node --import tsx` (one process, so SIGKILL hits the Harness itself).
//   npx tsx spike/hook-parent.ts
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync, writeFileSync } from "node:fs";
import { OUT } from "./common.ts";

const approveFile = `${OUT}/approve`;

function clean() {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${OUT}/hook.sqlite${suffix}`, { force: true });
	rmSync(`${OUT}/hook.state.json`, { force: true });
	rmSync(approveFile, { force: true });
}

type Run = { child: ChildProcess; lines: string[]; exited: Promise<{ code: number | null; signal: string | null }> };

function start(label: string, mode: string): Run {
	console.log(`\n### ${label}: hook-child ${mode}`);
	const child = spawn(process.execPath, ["--import", "tsx", "spike/hook-child.ts", mode], {
		stdio: ["ignore", "pipe", "inherit"],
		env: process.env,
	});
	const lines: string[] = [];
	createInterface({ input: child.stdout! }).on("line", (line) => {
		lines.push(line);
		console.log(`  [${label}] ${line.length > 1500 ? `${line.slice(0, 1500)}…` : line}`);
	});
	const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
	child.on("exit", (code, signal) => exit.resolve({ code, signal }));
	return { child, lines, exited: exit.promise };
}

/** Resolves `matched` once a stdout line starts with `prefix`, `exited` if the child exits first, `timeout` otherwise. */
async function waitFor(run: Run, prefix: string, ms: number): Promise<"matched" | "exited" | "timeout"> {
	const deadline = Date.now() + ms;
	let exited = false;
	void run.exited.then(() => (exited = true));
	while (Date.now() < deadline) {
		if (run.lines.some((l) => l.startsWith(prefix))) return "matched";
		if (exited) return "exited";
		await sleep(100);
	}
	return "timeout";
}

async function kill(run: Run, label: string) {
	run.child.kill("SIGKILL");
	console.log(`  [${label}] SIGKILL -> ${JSON.stringify(await run.exited)}`);
}

// (a) submit, wait for PENDING, SIGKILL. (b)/(c) resume repeatedly until the child stops printing PENDING.
clean();
const a = start("a", "submit");
console.log("  (a) PENDING:", await waitFor(a, "PENDING", 60_000));
await kill(a, "a");
for (let i = 1; i <= 4; i++) {
	const label = `b${i}`;
	const run = start(label, "resume");
	const outcome = await waitFor(run, "PENDING", 20_000);
	console.log(`  (${label}) PENDING again:`, outcome);
	if (outcome === "matched") {
		await kill(run, label);
		continue;
	}
	console.log(`  (${label}) SETTLED:`, await waitFor(run, "CLOSED", 60_000));
	if (run.child.exitCode === null) await kill(run, label);
	break;
}

// (d) fresh run; the child aborts in-process while the hook awaits.
clean();
const d = start("d", "abort");
console.log("  (d) CLOSED:", await waitFor(d, "CLOSED", 90_000));
if (d.child.exitCode === null) await kill(d, "d");

// (e) fresh run; approve while pending.
clean();
const e = start("e", "submit");
console.log("  (e) PENDING:", await waitFor(e, "PENDING", 60_000));
writeFileSync(approveFile, "");
console.log("  (e) CLOSED:", await waitFor(e, "CLOSED", 60_000));
if (e.child.exitCode === null) await kill(e, "e");
rmSync(approveFile, { force: true });
