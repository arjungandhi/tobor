import { defineTool, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { QuestionsDoc } from "../../../docs.js";
import type { QuestionService } from "../../../host.js";
import type { ToolModule } from "../../../tools/registry.js";

/** Name of the tool; withheld from workers and unattended (scheduled) sessions. */
export const ASK_USER = "ask_user";

const guidance = `## Asking the operator
- \`ask_user\` blocks until the operator replies: use it when the request is ambiguous, a decision has materially different options, or you need feedback before proceeding. Offer \`options\` when the answers are a short list.
- Do not ask what you can find out by reading files or running commands, and do not ask for confirmation of routine steps. Batch related questions into one call.`;

const TIMEOUT_TEXT =
	"No answer arrived from the operator before the wait timed out. Proceed on your best judgment and state the assumptions you made.";

/**
 * The `ask_user` tool over `service`. Replay-safe: `QuestionService.ask` is idempotent per call id, so a rerun after a
 * restart finds the stored record and keeps waiting (or returns the stored answer).
 */
export function questionsModule(service: () => QuestionService): ToolModule {
	const askUser = defineTool({
		name: ASK_USER,
		description:
			"Ask the operator a question and wait for their reply. Use when the request is ambiguous, a decision has " +
			"materially different options, or you need feedback before proceeding. Blocks until answered.",
		parameters: obj({
			question: str({ description: "The question, self-contained" }),
			options: opt(arr(str(), { description: "Suggested answers the operator may pick from; free text is always allowed" })),
		}),
		async execute(args, api, context) {
			const result = await service().ask(
				api.conversationId,
				{ callId: api.callId, question: args.question, ...(args.options?.length ? { options: args.options } : {}) },
				context,
			);
			if (result.kind === "answered") return { output: [{ type: "text", text: `User replied:\n${result.text}` }] };
			if (result.kind === "timeout") return { output: [{ type: "text", text: TIMEOUT_TEXT }] };
			return { output: [{ type: "text", text: "Cancelled while waiting for the operator's reply" }], isError: true };
		},
	});
	return { tools: [askUser], sections: [section("questions", (input) => (input.agent.tools.some((t) => t.name === ASK_USER) ? guidance : undefined))], docs: [QuestionsDoc] };
}
