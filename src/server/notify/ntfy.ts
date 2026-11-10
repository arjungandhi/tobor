// ntfy notifications (design: "Approvals", "Security"). One POST per notification to `<url>/<topic>` with the
// metadata in headers. Payloads carry ids and titles only; delivery is best effort and never throws.
import type { Config, NotifyEvent } from "../../config/schema.js";
import type { Notification, Notifier } from "../../host.js";

/** ntfy priority (1–5) and emoji tags per event; approvals are urgent, questions nearly so. */
const STYLE: Record<NotifyEvent, { priority: number; tags: string }> = {
	approval: { priority: 5, tags: "warning,lock" },
	question: { priority: 4, tags: "question" },
	error: { priority: 4, tags: "x" },
	settled: { priority: 3, tags: "white_check_mark" },
};

/** ntfy allows at most three action buttons. */
const MAX_ACTIONS = 3;

export type NtfyNotifierOptions = {
	/** Current node config (read at use). */
	config: () => Config;
	/** Topic used when `notify.ntfy` omits one (the `node.json` topic). */
	topic?: () => string | undefined;
	/** Injected for tests. */
	fetch?: typeof fetch;
	/** Delivery failures; default logs to stderr. */
	log?: (message: string) => void;
	/** Request timeout in ms (default 10 s). */
	timeoutMs?: number;
};

/** `Notifier` posting to ntfy; disabled while `config.notify.ntfy` is unset. */
export class NtfyNotifier implements Notifier {
	constructor(private readonly o: NtfyNotifierOptions) {}

	enabled(event: NotifyEvent): boolean {
		return this.target() !== undefined && this.o.config().notify.on.includes(event);
	}

	async send(notification: Notification): Promise<void> {
		if (!this.enabled(notification.event)) return;
		const target = this.target();
		if (!target) return;
		const style = STYLE[notification.event];
		const headers: Record<string, string> = {
			"Content-Type": "text/plain; charset=utf-8",
			Title: encodeHeader(notification.title),
			Tags: style.tags,
			Priority: String(style.priority),
			Click: notification.url ?? this.o.config().public_url,
		};
		const actions = (notification.actions ?? []).slice(0, MAX_ACTIONS).map((a) => {
			const parts = ["http", quote(a.label), quote(a.url), `method=${a.method ?? "POST"}`, "clear=true"];
			if (a.body !== undefined) parts.push(`body=${quote(a.body)}`);
			return parts.join(", ");
		});
		if (actions.length > 0) headers.Actions = encodeHeader(actions.join("; "));
		const log = this.o.log ?? ((message: string) => console.error(message));
		try {
			const res = await (this.o.fetch ?? fetch)(target, {
				method: "POST",
				headers,
				body: notification.message,
				signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
			});
			if (!res.ok) log(`tobor: ntfy ${notification.event} notification failed: HTTP ${res.status}`);
			await res.body?.cancel();
		} catch (error) {
			log(`tobor: ntfy ${notification.event} notification failed: ${(error as Error).message}`);
		}
	}

	/** `<url>/<topic>`, or undefined when ntfy is not configured. */
	private target(): string | undefined {
		const ntfy = this.o.config().notify.ntfy;
		const topic = ntfy?.topic || this.o.topic?.();
		if (!ntfy || !topic) return undefined;
		return `${ntfy.url.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
	}
}

/** Header values must be ASCII; ntfy decodes RFC 2047 encoded words. */
function encodeHeader(value: string): string {
	const flat = value.replace(/[\r\n]+/g, " ");
	if (/^[\x20-\x7e]*$/.test(flat)) return flat;
	return `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** Quote a value for ntfy's simple action format (commas and semicolons separate fields and actions). */
function quote(value: string): string {
	return value.includes('"') ? `'${value.replace(/'/g, "")}'` : `"${value}"`;
}
