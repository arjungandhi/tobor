import { defineTool, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { QuestionsDoc } from "../../../docs.js";
import type { QuestionService } from "../../../host.js";
import type { ToolModule } from "../../../tools/registry.js";

/** Name of the tool; withheld from workers and unattended (scheduled) sessions. */
export const ASK_USER = "ask_user";

const guidance = `## Asking the operator
- \`ask_user\` blocks until the operator replies: use it when the request is ambiguous, a decision has materially different options, or you need feedback before proceeding.
- One concern per field: when you have several related questions, send ONE call with a \`fields\` entry per question so the operator sees a single form; \`question\` then introduces the form. Give a field \`options\` when its answers are a short list; free text is always allowed.
- Do not ask what you can find out by reading files or running commands, and do not ask for confirmation of routine steps.`;

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
			"materially different options, or you need feedback before proceeding. Blocks until answered. For several related " +
			"questions, pass `fields` (one per question) to show the operator a single form.",
		parameters: obj({
			question: str({ description: "The question, self-contained" }),
			options: opt(arr(str(), { description: "Suggested answers the operator may pick from; free text is always allowed" })),
			fields: opt(
				arr(
					obj({
						prompt: str({ description: "One question of the form, self-contained" }),
						options: opt(arr(str(), { description: "Suggested answers for this field; free text is always allowed" })),
					}),
					{ description: "Form fields: one per related question; `question` introduces the form" },
				),
			),
		}),
		async execute(args, api, context) {
			const result = await service().ask(
				api.conversationId,
				{
					callId: api.callId,
					question: args.question,
					...(args.options?.length ? { options: args.options } : {}),
					...(args.fields?.length
						? { fields: args.fields.map((f) => ({ prompt: f.prompt, ...(f.options?.length ? { options: f.options } : {}) })) }
						: {}),
				},
				context,
			);
			if (result.kind === "answered") return { output: [{ type: "text", text: `User replied:\n${result.text}` }] };
			if (result.kind === "timeout") return { output: [{ type: "text", text: TIMEOUT_TEXT }] };
			return { output: [{ type: "text", text: "Cancelled while waiting for the operator's reply" }], isError: true };
		},
	});
	return { tools: [askUser], sections: [section("questions", (input) => (input.agent.tools.some((t) => t.name === ASK_USER) ? guidance : undefined))], docs: [QuestionsDoc] };
}
