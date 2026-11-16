import type { WhoamiResponse } from "../../api/types.js";
import type { App } from "../app.js";
import { showSessions } from "./sessions.js";
import { ApiRequestError } from "../client.js";
import { c } from "../theme.js";
import {
	type Address,
	checkName,
	checkToken,
	type Endpoint,
	DEFAULT_PORT,
	findWorkspace,
	formatAddress,
	parseAddress,
	probe,
	putWorkspace,
	removeWorkspace,
	renameWorkspace,
	setDefault,
	setToken,
	type Workspace,
} from "../workspaces.js";

/** `probe` result for display: the node's whoami, `"token"` when it answered 401, undefined when unreachable. */
type Reach = WhoamiResponse | "token" | undefined;

async function reach(target: Endpoint): Promise<Reach> {
	try {
		return await probe(target);
	} catch (err) {
		if (err instanceof ApiRequestError && err.status === 401) return "token";
		throw err;
	}
}

function reachability(who: Reach): string {
	if (who === "token") return c.warning("○ needs a token");
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

/**
 * The workspace list with reachability (each probed via `/api/whoami`, 1.5 s timeout). `switch` (startup picker,
 * Ctrl+T): Enter connects. `manage` (settings): Enter opens the edit menu. Both: a add, e edit.
 * `hierarchy` (startup, or one level up from the sessions list): Enter goes on to that workspace's sessions list, and Esc
 * leaves the workspace level with no session open.
 */
export async function showWorkspaces(app: App, mode: "switch" | "manage" = "switch", focus?: string, hierarchy = false): Promise<void> {
	const config = app.config;
	if (config.workspaces.length === 0) {
		const added = await addWorkspace(app);
		return added ? showWorkspaces(app, mode, added.name, hierarchy) : undefined;
	}
	app.flash("probing workspaces…");
	const probes = await Promise.all(config.workspaces.map((ws) => reach(ws)));
	const current = app.workspace;
	const items = config.workspaces.map((ws, i) => ({
		value: ws.name,
		label: `${ws.name === current?.name ? c.accent("● ") : "  "}${ws.name}${ws.name === config.default ? c.dim(" (default)") : ""}`,
		description: `${formatAddress(ws).padEnd(22)} ${reachability(probes[i])}`,
	}));
	const preselect = focus ?? current?.name ?? config.default;
	const lines = mode === "switch" && current ? whoamiLines(app.whoami, current) : [c.dim(`${config.workspaces.length} workspace(s) · ${app.configPath}`)];
	const picked = await app.pick(mode === "switch" ? "workspaces" : "manage workspaces", items, {
		lines,
		hint: mode === "switch" ? "Enter open · a add · e edit · Esc close" : "Enter edit · a add · Esc back",
		keys: ["a", "e"],
		selected: Math.max(0, config.workspaces.findIndex((w) => w.name === preselect)),
	});
	if (!picked) {
		if (hierarchy && app.session.target) {
			app.session.close();
			app.changed();
		}
		return;
	}
	if (picked.key === "a") {
		const added = await addWorkspace(app);
		return showWorkspaces(app, mode, added?.name, hierarchy);
	}
	const name = picked.value;
	if (!name) return;
	if (picked.key === "e" || mode === "manage") {
		const next = await editWorkspace(app, name);
		return showWorkspaces(app, mode, next, hierarchy);
	}
	const ws = findWorkspace(config, name);
	if (!ws) return;
	if (ws.name !== current?.name || (hierarchy && !app.whoami)) app.connect(ws);
	else if (hierarchy) return showSessions(app, false, undefined, "up");
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

/**
 * Ask for a node's bearer token (the node answered 401; `rejected`: the token it was given was refused). Resolves with the
 * validated token, or undefined on Esc.
 */
export async function askToken(app: App, name: string, rejected: boolean): Promise<string | undefined> {
	for (let problem = ""; ; ) {
		const input = await app.ask(`${name} · token`, {
			placeholder: "token",
			lines: [
				rejected ? c.error(`${name} rejected the token (HTTP 401).`) : c.warning(`${name} requires a token (HTTP 401).`),
				c.dim("Enter the bearer token the node's proxy expects; it is saved in config.yml (0600). Esc cancels."),
				...(problem ? [c.error(problem)] : []),
			],
		});
		if (input === undefined) return undefined;
		try {
			return checkToken(input);
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

/** Probe `address` (asking for a token if the node wants one), confirm, save. `token`: the workspace's current one, if any. */
async function testAndSave(app: App, name: string, address: Address, token?: string): Promise<Workspace | undefined> {
	app.flash(`testing ${formatAddress(address)}…`);
	let who = await reach({ ...address, ...(token ? { token } : {}) });
	while (who === "token") {
		const given = await askToken(app, name, token !== undefined);
		if (given === undefined) break;
		token = given;
		who = await reach({ ...address, token });
	}
	const save = await app.confirm(`save ${name}?`, [`${name}  ${formatAddress(address)}  ${reachability(who)}`]);
	if (!save) return undefined;
	app.updateConfig(putWorkspace(app.config, name, address, token));
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
		{ value: "token", label: "set token", description: ws.token ? "bearer token for this node's proxy (one is set; empty clears it)" : "bearer token for this node's proxy" },
		{ value: "rename", label: "rename" },
		{ value: "default", label: isDefault ? "unset default" : "set as default", description: "preselected in the picker" },
		{ value: "remove", label: "remove", description: "forget it; the node is not touched" },
	], { hint: "Enter choose · Esc back" });
	switch (action?.value) {
		case "address": {
			const address = await askAddress(app, `${name} · host:port`, ws);
			const saved = address ? await testAndSave(app, name, address, ws.token) : undefined;
			// Reconnect only when a new address was actually saved; Esc or declining keeps the open session.
			if (saved && app.workspace?.name === name) app.connect(saved);
			return name;
		}
		case "token": {
			const input = await app.ask(`${name} · token`, {
				placeholder: ws.token ? "(set)" : "token",
				lines: [c.dim("Bearer token sent on every request to this node; empty clears it. Esc cancels.")],
			});
			if (input === undefined) return name;
			try {
				app.updateConfig(setToken(app.config, name, input.trim() === "" ? undefined : input));
			} catch (err) {
				app.flash(`✗ ${(err as Error).message}`);
				return name;
			}
			const updated = findWorkspace(app.config, name);
			if (updated && app.workspace?.name === name) app.connect(updated);
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
			if (!(await app.confirm(`remove ${name}`, [`Forget ${name} (${formatAddress(ws)})? The node is not touched.`]))) return name;
			app.updateConfig(removeWorkspace(app.config, name));
			app.flash(`removed workspace ${name}`);
			return undefined;
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
	app.updateConfig(putWorkspace(app.config, name, address, app.workspace?.token));
	if (hadLast && from !== name) app.renamedWorkspace(from, name);
	app.flash(`saved workspace ${name}`);
}
