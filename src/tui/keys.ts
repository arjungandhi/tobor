import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Global key bindings of the Session view (intercepted before the composer sees them); mirrors omp's defaults. */
export const KEYS = {
	followUp: ["ctrl+q", "ctrl+enter"],
	abort: "escape",
	approvals: "alt+shift+a",
	questions: "alt+shift+u",
	workers: ["alt+a", "ctrl+s"],
	workerTranscript: "ctrl+o",
	model: "alt+m",
	modelCycle: "ctrl+p",
	newSession: "ctrl+n",
	sessions: "ctrl+l",
	workspaces: "ctrl+t",
	settings: "ctrl+,",
	quit: "ctrl+c",
	exit: "ctrl+d",
	help: "?",
	navigate: "up",
} as const satisfies Record<string, KeyId | readonly KeyId[]>;

/** Whether `data` is the key (or any of the keys) of a binding. */
export function matchesBinding(data: string, binding: KeyId | readonly KeyId[]): boolean {
	return typeof binding === "string" ? matchesKey(data, binding) : binding.some((key) => matchesKey(data, key));
}

/** Two `Ctrl+C` presses at most this far apart quit the TUI. */
export const QUIT_WINDOW_MS = 500;

/** Two bare `Left` presses on an empty composer at most this far apart open the sessions list. */
export const DOUBLE_LEFT_WINDOW_MS = 500;

/**
 * Double-press detector for `Ctrl+C`: `press` returns true when it is the second press within `QUIT_WINDOW_MS`.
 * A press that already did something (closed a dialog, cleared the composer) passes `arm = false` and does not start the window.
 */
export class QuitGate {
	private armedAt = Number.NEGATIVE_INFINITY;

	press(now: number, arm = true): boolean {
		if (now - this.armedAt < QUIT_WINDOW_MS) return true;
		if (arm) this.armedAt = now;
		return false;
	}
}

/** Rows of the help overlay: key, then what it does. */
export const HELP: readonly (readonly [string, string])[] = [
	["Enter", "send prompt (while a run is going: steer the running agent)"],
	["Ctrl+Q / Ctrl+Enter", "queue a follow-up for after the current turn"],
	["Esc", "abort the run · worker view: back to the director · idle: sessions list (then workspaces)"],
	["Shift+Enter / Alt+Enter", "new line in the composer"],
	["Alt+Shift+A", "pending approvals: approve / approve for session / deny"],
	["Alt+Shift+U", "pending questions from the agent (ask_user): answer or pick an option"],
	["Alt+A", "workers of this session (Ctrl+S also works)"],
	["Ctrl+O", "open a worker's transcript (again: back)"],
	["Alt+M", "change the session's model"],
	["Ctrl+P", "cycle to the next model"],
	["Ctrl+N", "new session"],
	["Ctrl+L", "sessions"],
	["←← (empty composer)", "sessions list"],
	["Ctrl+T", "switch workspace (saved nodes, with reachability)"],
	["Ctrl+,", "settings: node defaults, workspaces and TUI preferences"],
	["↑ (empty composer)", "select transcript blocks: Enter expands a tool, loads earlier history"],
	["PgUp/PgDn, wheel", "scroll the transcript; Ctrl+Shift+F searches it"],
	["?", "this help (empty composer)"],
	["Ctrl+C", "clear the composer or close the dialog; twice within 0.5 s to quit"],
	["Ctrl+D", "quit (when the composer is empty)"],
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
	{ name: "approval", description: "approval mode of this session", argumentHint: "ask|auto" },
	{ name: "archive", description: "archive this session (archived sessions: h in the sessions list)" },
	{ name: "complete", description: "archive this session (alias of /archive; archived sessions: h)" },
	{ name: "help", description: "keys and commands" },
	{ name: "quit", description: "exit the TUI" },
];
