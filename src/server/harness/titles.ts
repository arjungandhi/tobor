import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { DEFAULT_CHEAP_MODEL, parseModelRef } from "../../config/schema.js";

/** Longest title kept, as `titleFromPrompt`. */
const MAX_TITLE = 60;
/** Characters of the prompt and of the reply shown to the title model. */
const MAX_PROMPT = 2000;
const MAX_REPLY = 2000;
/** Upper bound on one title call. */
export const TITLE_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = [
	"You name chat sessions. Given the first user message and the start of the assistant's reply, write a title for the session.",
	"Rules: 3 to 8 words; descriptive of the task, not a greeting; no quotes, no markdown, no trailing punctuation.",
	"Reply with the title only.",
].join(" ");

/** Strip list markers, markdown/quote wrappers, a `Title:` label and trailing punctuation until nothing changes. */
function strip(title: string): string {
	let t = title;
	for (;;) {
		const stripped = t
			.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "")
			.replace(/^["'`“”‘’*#\s]+|["'`“”‘’*\s]+$/g, "")
			.replace(/^title\s*:\s*/i, "")
			.replace(/[.:;,!\s]+$/, "");
		if (stripped === t) return t;
		t = stripped;
	}
}

/**
 * A model's raw output as a title: first line, whitespace collapsed, control characters (terminal escapes) removed, list
 * markers, markdown, quotes, a `Title:` label and trailing punctuation stripped, capped at 60 characters.
 */
export function cleanTitle(raw: string): string {
	const line = (raw.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
	return strip(strip(line).slice(0, MAX_TITLE));
}

/**
 * The model that titles a session: `title_model`, then the cheap default, then the session's own model — the first of
 * them that exists in the registry and has auth. Undefined when none does (titling is skipped).
 */
export async function resolveTitleModel(
	models: Models,
	configured: string | undefined,
	sessionModel: { provider: string; modelId: string } | undefined,
): Promise<Model<Api> | undefined> {
	const refs = [configured ? parseModelRef(configured) : undefined, parseModelRef(DEFAULT_CHEAP_MODEL), sessionModel];
	const seen = new Set<string>();
	for (const ref of refs) {
		if (!ref) continue;
		const key = `${ref.provider}/${ref.modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const model = models.getModel(ref.provider, ref.modelId);
		if (!model) continue;
		try {
			if (await models.getAuth(model)) return model;
		} catch {
			// unusable credentials: try the next candidate
		}
	}
	return undefined;
}

/**
 * One cheap completion naming a session from its first prompt and the assistant's first reply. Auth comes from
 * `models` (the node's credential store). Null on any failure or an empty result.
 */
export async function generateTitle(
	models: Models,
	model: Model<Api>,
	exchange: { prompt: string; reply: string },
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
		const message = await models.completeSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `User message:\n${exchange.prompt.slice(0, MAX_PROMPT)}\n\nAssistant reply:\n${exchange.reply.slice(0, MAX_REPLY)}\n\nTitle:`,
						timestamp: Date.now(),
					},
				],
			},
			{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxTokens: 100 },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") return null;
		const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		return cleanTitle(text) || null;
	} catch {
		return null;
	}
}
