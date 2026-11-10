import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkerState, WorkerSummary } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

const MAX_ROWS = 3;

const STATE: Record<WorkerState, (text: string) => string> = {
	starting: c.dim,
	running: c.accent,
	done: c.success,
	failed: c.error,
	aborted: c.warning,
};

function lastLine(text: string): string {
	return text.trim().split("\n").at(-1) ?? "";
}

/** The workers strip under the transcript: one row per worker (newest active first), plus todo progress. */
export class WorkersStrip implements Component {
	private workers: WorkerSummary[] = [];
	private todo: { done: number; total: number } | undefined;
	private cache: { width: number; lines: string[] } | undefined;

	/** Replace the rows. */
	update(workers: WorkerSummary[], todo: { done: number; total: number } | undefined): void {
		if (workers === this.workers && todo?.done === this.todo?.done && todo?.total === this.todo?.total) return;
		this.workers = workers;
		this.todo = todo;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines: string[] = [];
		if (this.workers.length > 0 || this.todo) {
			const active = this.workers.filter((w) => w.state === "running" || w.state === "starting").length;
			const todo = this.todo ? c.dim(` · todo ${this.todo.done}/${this.todo.total}`) : "";
			const head = this.workers.length > 0 ? `workers ${active}/${this.workers.length} running` : "";
			lines.push(truncateToWidth(` ${c.accent(head)}${todo}${c.dim(" · Ctrl+W list · Ctrl+O open")}`, width));
			const rows = [...this.workers].sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.createdAt - a.createdAt);
			for (const w of rows.slice(0, MAX_ROWS)) {
				const row = ` ${STATE[w.state]("◆")} ${w.name} ${c.dim(w.agent)} ${STATE[w.state](w.state)} ${c.dim(`$${w.usage.cost.toFixed(3)}`)} ${c.dim(lastLine(w.lastText))}`;
				lines.push(truncateToWidth(row, width));
			}
			if (rows.length > MAX_ROWS) lines.push(c.dim(` … ${rows.length - MAX_ROWS} more`));
		}
		this.cache = { width, lines };
		return lines;
	}
}

function workerItems(workers: WorkerSummary[]): { value: WorkerSummary; label: string; description: string }[] {
	return workers.map((w) => ({
		value: w,
		label: `${STATE[w.state]("◆")} ${w.name}`,
		description: `${w.agent} · ${w.state} · $${w.usage.cost.toFixed(3)} · ${lastLine(w.lastText)}`,
	}));
}

/** Ctrl+W: the workers of the open session; Enter opens a worker's transcript. */
export async function showWorkers(app: App): Promise<void> {
	const s = app.session;
	const parent = s.target?.worker?.parent ?? s.target;
	if (!parent) throw new Error("open a session first");
	if (s.target?.worker) {
		app.openSession(parent.id);
	}
	await app.session.refreshWorkers();
	const picked = await app.pick(`workers of #${parent.id}`, workerItems(app.session.workers), {
		hint: "Enter open transcript · r refresh · Esc close",
		keys: ["r"],
	});
	if (!picked) return;
	if (picked.key === "r") return showWorkers(app);
	if (picked.value) openWorker(app, picked.value);
}

function openWorker(app: App, worker: WorkerSummary): void {
	const s = app.session;
	const parent = s.target?.worker?.parent ?? s.target;
	if (!parent) return;
	if (worker.conversationId === undefined) throw new Error(`${worker.name} has not started yet`);
	s.open({ id: worker.conversationId, title: worker.name, worker: { name: worker.name, parent } });
}

/** Ctrl+O: open a worker's transcript (the only one directly), or go back to the director when in one. */
export async function openWorkerTranscript(app: App): Promise<void> {
	const s = app.session;
	if (s.target?.worker) {
		app.openSession(s.target.worker.parent.id);
		return;
	}
	if (!s.target) throw new Error("open a session first");
	await s.refreshWorkers();
	const started = s.workers.filter((w) => w.conversationId !== undefined);
	if (started.length === 0) throw new Error("this session has no workers");
	if (started.length === 1 && started[0]) {
		openWorker(app, started[0]);
		return;
	}
	const picked = await app.pick("open worker transcript", workerItems(started));
	if (picked?.value) openWorker(app, picked.value);
}
