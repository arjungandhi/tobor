import { type Component, Input, matchesKey, type SettingItem, SettingsList, SelectList } from "@earendil-works/pi-tui";
import type { Document } from "yaml";
import type { ModelInfo } from "../../api/types.js";
import type { App } from "../app.js";
import { Panel } from "../app.js";
import { ApiRequestError } from "../client.js";
import { type Prefs, setPref } from "../workspaces.js";
import { addWorkspace, showWorkspaces } from "./workspaces.js";
import { type ConfigPath, editConfig, getField, modelOverrides, parseNodeConfig } from "../node-config.js";
import { c, selectListTheme } from "../theme.js";

const UNSET = "(unset)";
const CONFIG = "config.yml";

/** How a node setting is edited. */
type Kind = { type: "model"; unset: string } | { type: "enum"; values: string[] } | { type: "int" } | { type: "text" };

/** One editable key of config.yml. */
type Field = { path: ConfigPath; label: string; description: string; kind: Kind };

function nodeFields(agents: string[]): Field[] {
	return [
		{ path: ["defaults", "model"], label: "model", description: "Model of new sessions (provider/modelId).", kind: { type: "model", unset: "built-in default" } },
		{ path: ["defaults", "thinking"], label: "thinking", description: "Thinking level of new sessions.", kind: { type: "enum", values: ["off", "low", "medium", "high"] } },
		{ path: ["defaults", "approval_mode"], label: "approval mode", description: "ask: gated tools wait for you. auto: tools run without asking.", kind: { type: "enum", values: ["ask", "auto"] } },
		{ path: ["defaults", "mode"], label: "mode", description: "director plans and dispatches workers; solo does the work itself.", kind: { type: "enum", values: ["director", "solo"] } },
		{ path: ["defaults", "worker_model"], label: "worker model", description: "Model of workers whose agent file sets none; unset, workers use the director's.", kind: { type: "model", unset: "director's model" } },
		{ path: ["defaults", "title_model"], label: "title model", description: "Model that titles sessions after their first exchange; unset, a cheap built-in model, else the session's own.", kind: { type: "model", unset: "cheap built-in" } },
		...agents.map((agent): Field => ({
			path: ["agents", "model_overrides", agent],
			label: `agent ${agent}`,
			description: `Model override for the ${agent} agent; beats its agent file, not a task item's model.`,
			kind: { type: "model", unset: "agent file" },
		})),
		{ path: ["defaults", "max_workers"], label: "max workers", description: "Live workers per session.", kind: { type: "int" } },
		{ path: ["defaults", "max_turns"], label: "max turns", description: "Turn limit of a run.", kind: { type: "int" } },
		{ path: ["notify", "ntfy", "url"], label: "ntfy url", description: "ntfy server, e.g. https://ntfy.sh (set together with the topic).", kind: { type: "text" } },
		{ path: ["notify", "ntfy", "topic"], label: "ntfy topic", description: "ntfy topic notifications are posted to.", kind: { type: "text" } },
	];
}

/** A labelled one-line input used as a SettingsList submenu. */
class TextSubmenu implements Component {
	readonly input = new Input();

	constructor(
		private readonly label: string,
		initial: string,
		done: (value?: string) => void,
	) {
		this.input.focused = true;
		this.input.setValue(initial);
		this.input.onSubmit = (value) => done(value.trim() === "" ? UNSET : value.trim());
		this.input.onEscape = () => done();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		return [c.bold(this.label), ...this.input.render(width), c.dim("Enter set (empty: unset) · Esc back")];
	}
}

function modelSubmenu(models: ModelInfo[], unset: string, rows: number) {
	return (current: string, done: (value?: string) => void): Component => {
		const items = [
			{ value: UNSET, label: UNSET, description: unset },
			...models.map((m) => ({ value: m.ref, label: m.ref, description: `${m.name}${m.available ? "" : " · no credential"}` })),
		].map((item) => ({ ...item, label: `${item.value === current ? c.accent("● ") : "  "}${item.label}` }));
		const list = new SelectList(items, rows, selectListTheme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 48 });
		const index = items.findIndex((item) => item.value === current);
		if (index >= 0) list.setSelectedIndex(index);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return list;
	};
}

/** `Ctrl+,` / `/settings`: node defaults from `.tobor/config.yml` (saved with a commit), workspaces and preferences (client config.yml). */
export async function showSettings(app: App): Promise<void> {
	const client = app.api();
	const [file, models, agents] = await Promise.all([client.file(CONFIG), client.models(), client.agents()]);
	if (file.type !== "file") throw new Error(`${CONFIG} is a directory`);
	let text = file.content;
	let doc: Document = parseNodeConfig(text);
	let sha = file.sha;
	const agentNames = [...new Set([...agents.map((a) => a.name), ...Object.keys(modelOverrides(doc))])].sort();
	const fields = nodeFields(agentNames);
	const byId = new Map(fields.map((f) => [f.path.join("."), f]));
	/** Unsaved node changes by dotted path; re-applied after a reload on conflict. */
	const pending = new Map<string, string | number | undefined>();
	/** Committed values by dotted path, to tell a change from a change back. */
	let baseline = new Map(fields.map((f) => [f.path.join("."), getField(doc, f.path)]));
	const load = (content: string, fileSha: string | undefined): void => {
		text = content;
		doc = parseNodeConfig(content);
		sha = fileSha;
		baseline = new Map(fields.map((f) => [f.path.join("."), getField(doc, f.path)]));
	};
	let problems: string[] = [];
	let note = "";

	const display = (f: Field): string => getField(doc, f.path) ?? (f.kind.type === "model" ? UNSET : f.kind.type === "enum" ? c.dim("(default)") : UNSET);
	const rows = app.listRows(8);
	const nodeItems: SettingItem[] = fields.map((f) => {
		const id = f.path.join(".");
		const item: SettingItem = { id, label: f.label, description: `${id} · ${f.description}`, currentValue: display(f) };
		if (f.kind.type === "enum") item.values = f.kind.values;
		else if (f.kind.type === "model") item.submenu = modelSubmenu(models.models, f.kind.unset, Math.max(3, rows - 2));
		else item.submenu = (current, done) => new TextSubmenu(id, current === UNSET ? "" : current, done);
		return item;
	});
	const prefs = (): Prefs => app.config.prefs;
	const prefItems: SettingItem[] = [
		{ id: "pref.confirm_auto", label: "confirm auto", description: "Ask before switching to auto approval (new sessions, /approval, node default).", currentValue: prefs().confirm_auto === false ? "off" : "on", values: ["on", "off"] },
		{
			id: "pref.editor",
			label: "editor",
			description: "Editor command for /files; unset uses $VISUAL, then $EDITOR, then vi.",
			currentValue: prefs().editor ?? UNSET,
			submenu: (current, done) => new TextSubmenu("editor", current === UNSET ? "" : current, done),
		},
		{
			id: "pref.pdf_dir",
			label: "pdf dir",
			description: "Where artifact PDFs are saved; unset is ~/Downloads.",
			currentValue: prefs().pdf_dir ?? UNSET,
			submenu: (current, done) => new TextSubmenu("pdf dir", current === UNSET ? "" : current, done),
		},
	];
	const saveItem: SettingItem = { id: "§save", label: c.accent("save node defaults"), currentValue: "Ctrl+S", values: ["Ctrl+S"] };
	const wsSummary = (): string => {
		const { workspaces, default: def } = app.config;
		return workspaces.length === 0 ? "none" : `${workspaces.map((w) => w.name).join(", ")}${def ? ` · default ${def}` : ""}`;
	};
	const items: SettingItem[] = [
		{ id: "§node", label: c.bold("Node defaults"), currentValue: c.dim(`${app.workspace?.name ?? ""} · .tobor/${CONFIG}`) },
		...nodeItems,
		saveItem,
		{ id: "§ws", label: c.bold("Workspaces"), currentValue: c.dim(`${app.configPath}, saved on change`) },
		{ id: "ws.manage", label: "workspaces", description: "Enter: list with reachability; rename, change host/port, set default, remove.", currentValue: wsSummary(), values: [wsSummary()] },
		{ id: "ws.add", label: "add workspace", description: "Name, host:port, connection test, save.", currentValue: "Enter", values: ["Enter"] },
		{ id: "§tui", label: c.bold("TUI preferences"), currentValue: c.dim(`${app.configPath}, saved on change`) },
		...prefItems,
	];

	const { promise, resolve } = Promise.withResolvers<void>();
	let close = (): void => {};
	let closing = false;
	const panelLines = (): string[] => {
		const changes = [...pending].map(([id, value]) => `${id} → ${value ?? UNSET}`);
		return [
			changes.length > 0 ? c.warning(`unsaved: ${changes.join(", ")}`) : c.dim(note || `node sha ${sha?.slice(0, 8) ?? "?"} · no unsaved changes`),
			...problems.map((p) => c.error(p)),
		];
	};
	const refresh = (): void => {
		panel.setLines(panelLines());
		app.tui.requestRender();
	};

	const reload = async (): Promise<void> => {
		const fresh = await client.file(CONFIG);
		if (fresh.type !== "file") throw new Error(`${CONFIG} is a directory`);
		load(fresh.content, fresh.sha);
		for (const [id, value] of pending) text = editConfig(text, byId.get(id)!.path, value);
		doc = parseNodeConfig(text);
		for (const f of fields) list.updateValue(f.path.join("."), display(f));
	};

	const save = async (): Promise<void> => {
		if (pending.size === 0) {
			note = "nothing to save";
			return refresh();
		}
		try {
			const keys = [...pending.keys()].join(", ");
			const { commit } = await client.putFile(CONFIG, { content: text, ...(sha ? { sha } : {}), message: `operator: settings (${keys})` });
			pending.clear();
			problems = [];
			const fresh = await client.file(CONFIG);
			if (fresh.type === "file") load(fresh.content, fresh.sha);
			note = `saved · ${commit.slice(0, 8)}`;
			app.flash(`${CONFIG} saved · ${commit.slice(0, 8)}`);
			refresh();
		} catch (err) {
			if (!(err instanceof ApiRequestError) || (err.status !== 422 && err.status !== 409)) {
				problems = [(err as Error).message];
				return refresh();
			}
			if (err.status === 422) {
				problems = err.body?.errors?.map((e) => `${e.path}: ${e.message}`) ?? [err.body?.error ?? err.message];
				return refresh();
			}
			await reload();
			problems = [];
			refresh();
			const again = await app.confirm(`${CONFIG} changed on the node`, [
				"Someone committed config.yml since it was loaded. Reloaded it and re-applied your changes:",
				...[...pending].map(([id, value]) => `  ${id} → ${value ?? UNSET}`),
				"",
				"Save again?",
			]);
			if (again) await save();
		}
	};

	const setNode = async (f: Field, raw: string): Promise<void> => {
		const id = f.path.join(".");
		let value: string | number | undefined = raw === UNSET ? undefined : raw;
		if (f.kind.type === "int" && value !== undefined) {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) {
				list.updateValue(id, display(f));
				problems = [`${id}: expected a positive integer`];
				return refresh();
			}
			value = n;
		}
		if (id === "defaults.approval_mode" && value === "auto") {
			const ok = await app.confirmAuto("node default approval mode", "New sessions will default to auto: tools run without asking, with full filesystem and shell access. Continue?");
			if (!ok) {
				list.updateValue(id, display(f));
				return refresh();
			}
		}
		text = editConfig(text, f.path, value);
		doc = parseNodeConfig(text);
		list.updateValue(id, display(f));
		if (String(value ?? "") === (baseline.get(id) ?? "")) pending.delete(id);
		else pending.set(id, value);
		problems = [];
		note = "";
		refresh();
	};

	const setPreference = (key: keyof Prefs, raw: string): void => {
		const value = key === "confirm_auto" ? raw === "on" : raw === UNSET ? undefined : raw;
		app.updateConfig(setPref(app.config, key, value as never));
		note = `${key} saved`;
		refresh();
	};

	const workspaces = async (id: string): Promise<void> => {
		if (id === "ws.add") {
			const added = await addWorkspace(app);
			if (added) await showWorkspaces(app, "manage", added.name);
		} else await showWorkspaces(app, "manage");
		list.updateValue("ws.manage", wsSummary());
		list.updateValue("ws.add", "Enter");
		refresh();
	};

	const onChange = (id: string, value: string): void => {
		if (id === "§save") {
			list.updateValue(id, "Ctrl+S");
			app.guard(save);
			return;
		}
		if (id.startsWith("ws.")) return app.guard(() => workspaces(id));
		if (id.startsWith("pref.")) return setPreference(id.slice(5) as keyof Prefs, value);
		const f = byId.get(id);
		if (f) app.guard(() => setNode(f, value));
	};

	const requestClose = async (): Promise<void> => {
		if (closing) return;
		if (pending.size > 0) {
			closing = true;
			const discard = await app.confirm("unsaved node settings", [`Discard ${pending.size} unsaved change${pending.size === 1 ? "" : "s"}?`]);
			closing = false;
			if (!discard) return;
		}
		close();
		resolve();
	};

	const list = new SettingsList(
		items,
		rows,
		{
			label: (text, selected) => (selected ? c.bold(c.accent(text)) : text),
			value: (text, selected) => (selected ? c.accent(text) : c.dim(text)),
			description: c.dim,
			cursor: c.accent("› "),
			hint: c.dim,
		},
		onChange,
		() => {
			// Esc layers: clear the search first, then the unsaved-changes close.
			const search = (list as unknown as { searchInput?: Input }).searchInput;
			if (search && search.getValue().length > 0) return list.handleInput("\x15"); // Ctrl+U: delete to line start, refilters
			app.guard(requestClose);
		},
		{ enableSearch: true },
	);
	list.selectItem("defaults.model");
	// SettingsList always appends its own hint line ("Type to search · Enter/Space to change · Esc to cancel") and has no option to
	// hide it; drop it so the Panel hint is the single hint line.
	const body: Component = {
		capturesViewportInput: list.capturesViewportInput,
		handleInput: (data) => list.handleInput(data),
		invalidate: () => list.invalidate(),
		render: (width) => {
			const lines = list.render(width);
			if (lines.at(-1)?.includes("Esc to cancel")) lines.splice(-2, 2);
			return lines;
		},
	};
	const panel = new Panel("settings", {
		lines: panelLines(),
		child: body,
		hint: "type to search · Enter/Space change · Ctrl+S save node defaults · Esc clear/close",
		onKey: (data) => {
			if (!matchesKey(data, "ctrl+s")) return false;
			app.guard(save);
			return true;
		},
	});
	close = app.openModal(panel, () => app.guard(requestClose));
	return promise;
}
