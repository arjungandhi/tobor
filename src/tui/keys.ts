import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** One global key of the Session view: the single declaration that the router, the help overlay and hint texts derive from. */
type HotkeyDef = {
	/** Stable name; also the `KEYS` property and (for `flow` entries) the router's `HotkeyName`. */
	name: string;
	/** Key bindings; any one triggers it. The first is the one shown in hints. */
	keys: readonly KeyId[];
	/** Help overlay key column, when the derived `Ctrl+Q / Ctrl+Enter` form is not right. */
	label?: string;
	/** Help overlay text: what it does. */
	help: string;
	/** Short action label for hints and flashes (`Alt+Shift+A approvals`); omit for keys that never appear in a hint. */
	hint?: string;
	/** Dispatched by the router's hotkey loop (any composer state) to a flow-opening screen. The others have bespoke routing in `routeKey` / `App.onInput`. */
	flow?: true;
	/** `false`: opens no dialog, so it runs without the flow lock (and is not refused while a dialog or command flow runs). */
	modal?: false;
};

/**
 * Global key bindings of the Session view (intercepted before the composer sees them); mirrors omp's defaults.
 * Order is the help overlay's and the router's dispatch order. Keys that pi-tui or the terminal own (newline, scrolling,
 * transcript search) are not here: see `HELP_PROVIDED`.
 */
export const HOTKEY_TABLE = [
	{ name: "followUp", keys: ["ctrl+q", "ctrl+enter"], help: "queue a follow-up for after the current turn", hint: "follow-up", flow: true, modal: false },
	{
		name: "abort",
		keys: ["escape"],
		help: "clear the composer; when empty: abort the run · worker view: back · idle: up a tier (sessions list; Esc there: workspaces)",
		hint: "abort",
	},
	{ name: "approvals", keys: ["alt+shift+a"], help: "pending approvals: approve / approve for session / deny", hint: "approvals", flow: true },
	{ name: "questions", keys: ["alt+shift+u"], help: "pending questions from the agent (ask_user): answer or pick an option", hint: "questions", flow: true },
	{ name: "workers", keys: ["alt+a", "ctrl+s"], help: "workers of this session", hint: "workers", flow: true },
	{ name: "workerTranscript", keys: ["ctrl+o"], help: "open a worker's transcript (again: back)", hint: "worker transcript", flow: true },
	{ name: "model", keys: ["alt+m"], help: "change the session's model", hint: "model", flow: true },
	{ name: "modelCycle", keys: ["ctrl+p"], help: "cycle to the next model", hint: "next model", flow: true, modal: false },
	{ name: "pasteImage", keys: ["ctrl+v"], help: "paste from the clipboard: an image becomes an attachment, text is inserted", hint: "paste", flow: true, modal: false },
	{ name: "newSession", keys: ["ctrl+n"], help: "new session", hint: "new session", flow: true },
	{ name: "sessions", keys: ["ctrl+l"], help: "sessions", hint: "sessions", flow: true },
	{ name: "workspaces", keys: ["ctrl+t"], help: "switch workspace (saved nodes, with reachability)", hint: "workspaces", flow: true },
	{ name: "settings", keys: ["ctrl+,"], help: "settings: node defaults, workspaces and TUI preferences", hint: "settings", flow: true },
	{
		name: "navigate",
		keys: ["up"],
		label: "↑ (empty composer)",
		help: "select transcript blocks: Enter expands a tool, loads earlier history",
	},
	{ name: "help", keys: ["?"], help: "this help (empty composer)", hint: "help" },
	{ name: "quit", keys: ["ctrl+c"], help: "close the dialog or clear the composer; with neither to do, twice within 0.5 s quits", hint: "quit" },
	{ name: "exit", keys: ["ctrl+d"], help: "quit (when the composer is empty)" },
] as const satisfies readonly HotkeyDef[];

type HotkeyEntry = (typeof HOTKEY_TABLE)[number];

/** Names of the table entries the router dispatches through its hotkey loop. */
export type FlowHotkeyName = Extract<HotkeyEntry, { flow: true }>["name"];

type BindingOf<Keys> = Keys extends readonly [infer One extends KeyId] ? One : Keys;

/** Key bindings by name: a single key id, or the list when there are several. Derived from `HOTKEY_TABLE`. */
export const KEYS = Object.fromEntries(HOTKEY_TABLE.map((e) => [e.name, e.keys.length === 1 ? e.keys[0] : e.keys])) as {
	readonly [E in HotkeyEntry as E["name"]]: BindingOf<E["keys"]>;
};

const KEY_NAMES: Readonly<Record<string, string>> = { escape: "Esc", up: "↑", down: "↓", left: "←", right: "→" };

/** `alt+shift+a` → `Alt+Shift+A`, `escape` → `Esc`. */
export function formatKey(id: string): string {
	return id
		.split("+")
		.map((part) => KEY_NAMES[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
		.join("+");
}

/** The key as shown in hints: the first binding of the named table entry. */
export function keyLabel(name: HotkeyEntry["name"]): string {
	return formatKey(HOTKEY_TABLE.find((e) => e.name === name)?.keys[0] ?? name);
}

/** Key plus short action, e.g. `Alt+Shift+A approvals`. */
export function hotkeyHint(name: HotkeyEntry["name"]): string {
	const entry: HotkeyDef | undefined = HOTKEY_TABLE.find((e) => e.name === name);
	return entry?.hint ? `${keyLabel(name)} ${entry.hint}` : keyLabel(name);
}

/** Whether `data` is the key (or any of the keys) of a binding. */
export function matchesBinding(data: string, binding: KeyId | readonly KeyId[]): boolean {
	return typeof binding === "string" ? matchesKey(data, binding) : binding.some((key) => matchesKey(data, key));
}

/** Flashed when a key or command needs a flow that cannot start because another one is running, when the running one is unknown. */
export const BUSY_MESSAGE = "busy — finish or cancel the current dialog or command first";

/** `BUSY_MESSAGE` naming the running flow (`label`: a hotkey's short name or a `/command`), if known. */
export function busyMessage(label?: string): string {
	return label ? `busy — finish or cancel ${label} first` : BUSY_MESSAGE;
}

/** Whether the named flow hotkey opens a dialog and so takes the flow lock; false for the ones that act in place (follow-up, next model, paste). */
export function isModalHotkey(name: string): boolean {
	return !HOTKEY_TABLE.some((e) => e.name === name && "modal" in e && e.modal === false);
}

/** Short name of a hotkey's flow for the busy message (`approvals`, `new session`). */
export function flowLabel(name: HotkeyEntry["name"]): string {
	const entry: HotkeyDef | undefined = HOTKEY_TABLE.find((e) => e.name === name);
	return entry?.hint ?? name;
}

/** Two `Ctrl+C` presses at most this far apart quit the TUI. */
export const QUIT_WINDOW_MS = 500;

/** Two bare `Left` presses on an empty composer at most this far apart open the sessions list. */
export const DOUBLE_LEFT_WINDOW_MS = 500;

/**
 * Double-press detector for `Ctrl+C`: `press` returns true when it is the second press within `QUIT_WINDOW_MS`.
 * A press that already did something (closed a dialog, cleared the composer) passes `arm = false`: it never quits and disarms the gate.
 */
export class QuitGate {
	private armedAt = Number.NEGATIVE_INFINITY;

	press(now: number, arm = true): boolean {
		if (!arm) {
			this.armedAt = Number.NEGATIVE_INFINITY;
			return false;
		}
		if (now - this.armedAt < QUIT_WINDOW_MS) return true;
		this.armedAt = now;
		return false;
	}
}

/** Rows of the help overlay owned by tobor: key, then what it does. Derived from `HOTKEY_TABLE` plus the gestures below. */
export const HELP: readonly (readonly [string, string])[] = [
	["Enter", "send prompt (while a run is going: steer the running agent)"],
	...HOTKEY_TABLE.map((e: HotkeyDef): readonly [string, string] => [e.label ?? e.keys.map(formatKey).join(" / "), e.help]),
	["←← (empty composer)", "up a tier: sessions list"],
	["←/→ (in pickers)", "up / down a tier: workspaces ↔ sessions ↔ session"],
];

/** Help rows for keys that pi-tui or the terminal handle (not tobor's table, not remappable here), listed in their own section. */
export const HELP_PROVIDED: readonly (readonly [string, string])[] = [
	["Shift+Enter / Alt+Enter", "new line in the composer"],
	["PgUp/PgDn, wheel", "scroll the transcript"],
	["Ctrl+Shift+F", "search the transcript"],
];

/** Slash commands typed into the composer. */
export const COMMANDS: readonly { name: string; description: string; argumentHint?: string }[] = [
	{ name: "sessions", description: "list sessions" },
	{ name: "new", description: "start a new session" },
	{ name: "approvals", description: "pending approvals" },
	{ name: "questions", description: "questions the agent asked you" },
	{ name: "workers", description: "workers of this session" },
	{ name: "model", description: "change the session's model" },
	{ name: "artifacts", description: "published artifacts (default: this session)", argumentHint: "[all]" },
	{ name: "schedules", description: "scheduled prompts" },
	{ name: "files", description: "edit agent files in .tobor/" },
	{ name: "login", description: "log in to a model provider" },
	{ name: "workspace", description: "switch workspace; node info" },
	{ name: "settings", description: "node defaults, workspaces and TUI preferences" },
	{ name: "upgrade", description: "upgrade the node to the latest release and restart it" },
	{ name: "restart", description: "restart the node" },
	{ name: "attach", description: "attach a local image to the next message (/attach clear drops them)", argumentHint: "<path>|clear" },
	{ name: "title", description: "rename this session", argumentHint: "<title>" },
	{ name: "approval", description: "approval mode of this session", argumentHint: "[ask|auto]" },
	{ name: "archive", description: "archive this session (archived sessions: h in the sessions list)" },
	{ name: "complete", description: "archive this session (alias of /archive; archived sessions: h)" },
	{ name: "help", description: "keys and commands" },
	{ name: "quit", description: "exit the TUI" },
];
