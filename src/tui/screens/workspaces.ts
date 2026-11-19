import type { WhoamiResponse } from "../../api/types.js";
import type { App } from "../app.js";
import { navigate } from "../nav.js";
import { showSessions } from "./sessions.js";
import { c } from "../theme.js";
import {
	type Address,
	checkName,
	DEFAULT_PORT,
	findWorkspace,
	formatAddress,
	parseAddress,
	probe,
	putWorkspace,
	removeWorkspace,
	renameWorkspace,
	setDefault,
	type Workspace,
} from "../workspaces.js";

function reachability(who: WhoamiResponse | undefined): string {
	return who ? c.success(`● reachable · ${who.host}`) : c.warning("○ unreachable");
}

function whoamiLines(w: WhoamiResponse | undefined, ws: Workspace): string[] {
	if (!w) return [c.warning(`${ws.name} (${formatAddress(ws)}): not reachable`)];
	return [
		`${c.accent(w.host)} ${c.dim(`tobor ${w.version} · pi-durable ${w.pi_durable} · ${w.runtime}`)}`,
		c.dim(`api ${w.public_url} · artifacts ${w.artifacts_url}${w.ntfy_topic ? ` · ntfy ${w.ntfy_topic}` : ""}`),
		w.chrome.found ? c.success(`chrome ${w.chrome.version ?? "found"} (PDF export)`) : c.warning("chrome not found: PDF export unavailable"),
	];
}

/** How long the first show waits for probes before painting the rows (answers from nodes on this machine arrive well within it). */
const PROBE_HEAD_START_MS = 200;

/**
 * The workspace list with reachability (each probed via `/api/whoami`, 1.5 s timeout). `switch` (startup picker,
 * Ctrl+T): Enter/→ opens the workspace. `manage` (settings): Enter opens the edit menu. Both: a add, e edit, d forget, g re-probe.
 * `switch` is the top tier of the hierarchy workspaces → sessions → session: Enter/→ goes down to that workspace's
 * sessions list (connecting first when it is not the connected one), Esc/← closes the picker (back to the open session, if any).
 *
 * The rows paint at once: probes run in the background and are cached for the life of the picker, so a row still
 * waiting shows "probing…" until the list is next shown (any action, or `g`, which also probes everything again).
 * An empty list is shown as such (`a add`); it never opens the add wizard by itself.
 */
export async function showWorkspaces(app: App, mode: "switch" | "manage" = "switch", focus?: string): Promise<void> {
	const probes = new Map<string, { address: string; settled: boolean; who: WhoamiResponse | undefined }>();
	let pending: Promise<unknown>[] = [];
	/** Start a probe for every workspace without a fresh result (all of them when `force`). */
	const startProbes = (force: boolean): void => {
		for (const ws of app.config.workspaces) {
			const address = formatAddress(ws);
			const known = probes.get(ws.name);
			if (!force && known?.address === address) continue;
			const entry = { address, settled: false, who: undefined as WhoamiResponse | undefined };
			probes.set(ws.name, entry);
			pending.push(
				probe(ws).then((who) => {
					entry.who = who;
					entry.settled = true;
				}),
			);
		}
	};
	const headStart = async (): Promise<void> => {
		if (pending.length === 0) return;
		await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, PROBE_HEAD_START_MS))]);
		pending = [];
	};
	let first = true;
	await navigate<string>(app, {
		view: async () => {
			const config = app.config;
			startProbes(false);
			await headStart();
			const current = app.workspace;
			const view = {
				title: mode === "switch" ? "workspaces" : "manage workspaces",
				items: config.workspaces.map((ws) => {
					const result = probes.get(ws.name);
					return {
						value: ws.name,
						label: `${ws.name === current?.name ? c.accent("● ") : "  "}${ws.name}${ws.name === config.default ? c.dim(" (default)") : ""}`,
						description: `${formatAddress(ws).padEnd(22)} ${result?.settled ? reachability(result.who) : c.dim("◌ probing…")}`,
					};
				}),
				lines: mode === "switch" && current ? whoamiLines(app.whoami, current) : [c.dim(`${config.workspaces.length} workspace(s) · ${app.configPath}`)],
				hint: mode === "switch" ? "→/Enter sessions · a add · e edit · d forget · g refresh · ←/Esc back" : "Enter/e edit · a add · d forget · g refresh · Esc back",
				emptyHint: "a add · Esc back",
				keys: mode === "switch" ? ["a", "e", "d", "g", "left", "right"] : ["a", "e", "d", "g"],
			};
			if (!first) return view;
			first = false;
			// Only the first show: afterwards `navigate` keeps the cursor on the row by name. (`selected` is passed through to `app.pick`.)
			const preselect = focus ?? current?.name ?? config.default;
			return Object.assign(view, { selected: Math.max(0, config.workspaces.findIndex((w) => w.name === preselect)) });
		},
		key: (name) => name,
		onPick: async (picked) => {
			if (picked.key === "left") return "close";
			if (picked.key === "g") {
				startProbes(true);
				return "refresh";
			}
			if (picked.key === "a") {
				await addWorkspace(app);
				return "refresh";
			}
			const name = picked.value;
			if (!name) return "stay";
			if (picked.key === "d") {
				await forgetWorkspace(app, name);
				return "refresh";
			}
			if (picked.key === "e" || mode === "manage") {
				await editWorkspace(app, name);
				return "refresh";
			}
			const ws = findWorkspace(app.config, name);
			if (!ws) return "refresh";
			if (ws.name === app.workspace?.name && app.whoami) await showSessions(app);
			else app.connect(ws);
			return "close";
		},
	});
}

/** Confirm, then forget a workspace (the node is not touched). Resolves whether it was removed. */
async function forgetWorkspace(app: App, name: string): Promise<boolean> {
	const ws = findWorkspace(app.config, name);
	if (!ws) return false;
	if (!(await app.confirm(`remove ${name}`, [`Forget ${name} (${formatAddress(ws)})? The node is not touched.`]))) return false;
	app.updateConfig(removeWorkspace(app.config, name));
	app.flash(`removed workspace ${name}`);
	return true;
}

/** Ask for a host:port; an empty answer keeps `initial` (default 127.0.0.1:7879). */
async function askAddress(app: App, title: string, initial?: Address): Promise<Address | undefined> {
	const fallback = initial ? formatAddress(initial) : `127.0.0.1:${DEFAULT_PORT}`;
	for (let problem = ""; ; ) {
		const input = await app.ask(title, {
			placeholder: fallback,
			lines: [c.dim(`the node's API address, host:port (port defaults to ${DEFAULT_PORT}); empty: ${fallback}`), ...(problem ? [c.error(problem)] : [])],
		});
		if (input === undefined) return undefined;
		try {
			return parseAddress(input.trim() || fallback);
		} catch (err) {
			problem = (err as Error).message;
		}
	}
}

/** Ask for a valid, unused workspace name; an empty answer keeps `current` (when renaming). */
async function askName(app: App, title: string, current = ""): Promise<string | undefined> {
	for (let problem = ""; ; ) {
		const input = await app.ask(title, {
			placeholder: current || "e.g. personal",
			lines: [c.dim("letters a-z, digits, - and _"), ...(problem ? [c.error(problem)] : [])],
		});
		if (input === undefined) return undefined;
		const name = input.trim() || current;
		try {
			checkName(name);
			if (name !== current && findWorkspace(app.config, name)) throw new Error(`workspace ${name} already exists`);
			return name;
		} catch (err) {
			problem = (err as Error).message;
		}
	}
}

/** Wizard: name, address, connection test, save. Resolves with the saved workspace. */
export async function addWorkspace(app: App, address?: Address): Promise<Workspace | undefined> {
	const first = app.config.workspaces.length === 0;
	const name = await askName(app, first ? "new workspace · name" : "add workspace · name");
	if (name === undefined) return undefined;
	const addr = address ?? (await askAddress(app, `${name} · host:port`));
	if (addr === undefined) return undefined;
	return testAndSave(app, name, addr);
}

async function testAndSave(app: App, name: string, address: Address): Promise<Workspace | undefined> {
	app.flash(`testing ${formatAddress(address)}…`);
	const who = await probe(address);
	const save = await app.confirm(`save ${name}?`, [`${name}  ${formatAddress(address)}  ${reachability(who)}`]);
	if (!save) return undefined;
	app.updateConfig(putWorkspace(app.config, name, address));
	app.flash(`saved workspace ${name} · ${app.configPath}`);
	return findWorkspace(app.config, name);
}

/** Edit menu for one workspace; resolves with its (possibly new) name, or undefined when removed. */
async function editWorkspace(app: App, name: string): Promise<string | undefined> {
	const ws = findWorkspace(app.config, name);
	if (!ws) return undefined;
	const isDefault = app.config.default === name;
	const action = await app.pick(`${name} · ${formatAddress(ws)}`, [
		{ value: "address", label: "change host/port" },
		{ value: "rename", label: "rename" },
		{ value: "default", label: isDefault ? "unset default" : "set as default", description: "preselected in the picker" },
		{ value: "remove", label: "remove", description: "forget it; the node is not touched" },
	], { hint: "Enter choose · Esc back" });
	switch (action?.value) {
		case "address": {
			const address = await askAddress(app, `${name} · host:port`, ws);
			const saved = address ? await testAndSave(app, name, address) : undefined;
			// Reconnect only when a new address was actually saved; Esc or declining keeps the open session.
			if (saved && app.workspace?.name === name) app.connect(saved);
			return name;
		}
		case "rename": {
			const to = await askName(app, `rename ${name}`, name);
			if (to === undefined || to === name) return name;
			app.updateConfig(renameWorkspace(app.config, name, to));
			app.renamedWorkspace(name, to);
			return to;
		}
		case "default":
			app.updateConfig(setDefault(app.config, isDefault ? undefined : name));
			return name;
		case "remove":
			return (await forgetWorkspace(app, name)) ? undefined : name;
		default:
			return name;
	}
}

/** `tobor host:port` for an unsaved address: offer to save it under a name. */
export async function offerSave(app: App, address: Address): Promise<void> {
	const save = await app.confirm(`save ${formatAddress(address)}?`, ["Save this address as a named workspace?"]);
	if (!save) return;
	const name = await askName(app, `name for ${formatAddress(address)}`);
	if (name === undefined) return;
	// updateConfig relabels the connection, so capture the old (address-derived) name and its last session first.
	const from = app.workspace?.name ?? "";
	const hadLast = from !== "" && app.lastSessionId() !== undefined;
	app.updateConfig(putWorkspace(app.config, name, address));
	if (hadLast && from !== name) app.renamedWorkspace(from, name);
	app.flash(`saved workspace ${name}`);
}
