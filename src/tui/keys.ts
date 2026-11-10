import type { KeyId } from "@earendil-works/pi-tui";

/** Global key bindings of the Session view (intercepted before the composer sees them). */
export const KEYS = {
	steer: "ctrl+s",
	abort: "escape",
	approvals: "ctrl+a",
	workers: "ctrl+w",
	workerTranscript: "ctrl+o",
	model: "ctrl+p",
	newSession: "ctrl+n",
	sessions: "ctrl+l",
	contexts: "ctrl+t",
	quit: "ctrl+c",
	help: "?",
	navigate: "up",
} as const satisfies Record<string, KeyId>;

/** Two `Ctrl+C` presses at most this far apart quit the TUI. */
export const QUIT_WINDOW_MS = 2000;

/** Double-press detector for `Ctrl+C`: `press` returns true when it is the second press within `QUIT_WINDOW_MS`. */
export class QuitGate {
	private armedAt = Number.NEGATIVE_INFINITY;

	press(now: number): boolean {
		if (now - this.armedAt < QUIT_WINDOW_MS) return true;
		this.armedAt = now;
		return false;
	}
}

/** Rows of the help overlay: key, then what it does. */
export const HELP: readonly (readonly [string, string])[] = [
	["Enter", "send prompt (queued as a follow-up while a run is going)"],
	["Ctrl+S", "steer the running agent with the composer text"],
	["Esc", "abort the run (in a worker view: back to the director)"],
	["Alt+Enter", "new line in the composer"],
	["Ctrl+A", "pending approvals: approve / approve for session / deny"],
	["Ctrl+W", "workers of this session"],
	["Ctrl+O", "open a worker's transcript (again: back)"],
	["Ctrl+P", "change the session's model"],
	["Ctrl+N", "new session"],
	["Ctrl+L", "sessions"],
	["Ctrl+T", "hosts (contexts)"],
	["↑ (empty composer)", "select transcript blocks: Enter expands a tool, loads earlier history"],
	["PgUp/PgDn, wheel", "scroll the transcript; Ctrl+Shift+F searches it"],
	["?", "this help (empty composer)"],
	["Ctrl+C", "clear the composer or close the dialog; twice within 2 s to quit"],
];

/** Slash commands typed into the composer. */
export const COMMANDS: readonly { name: string; description: string; argumentHint?: string }[] = [
	{ name: "sessions", description: "list sessions" },
	{ name: "new", description: "start a new session" },
	{ name: "approvals", description: "pending approvals" },
	{ name: "workers", description: "workers of this session" },
	{ name: "model", description: "change the session's model" },
	{ name: "artifacts", description: "published artifacts" },
	{ name: "schedules", description: "scheduled prompts" },
	{ name: "files", description: "edit agent files in .tobor/" },
	{ name: "login", description: "log in to a model provider" },
	{ name: "host", description: "hosts (contexts) and node info" },
	{ name: "title", description: "rename this session", argumentHint: "<title>" },
	{ name: "approval", description: "approval mode of this session", argumentHint: "ask|auto" },
	{ name: "archive", description: "archive this session" },
	{ name: "help", description: "keys and commands" },
	{ name: "quit", description: "exit the TUI" },
];
