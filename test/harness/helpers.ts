import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { defineTool, type EntryRecord } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { ToolModule } from "../../src/tools/registry.js";

/** A temp `$TOBOR_HOME` whose config allows sessions under `root` (also a temp dir, realpath'd). */
export async function tempHome(): Promise<{ home: string; root: string }> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "tobor-harness-")));
	const home = join(base, "home");
	const root = join(base, "work");
	await mkdir(join(home, ".tobor"), { recursive: true });
	await mkdir(root, { recursive: true });
	await writeFile(join(home, ".tobor", "config.yml"), `roots: [${JSON.stringify(root)}]\ndefaults:\n  model: faux/m\n  title_model: faux-title/t\n  thinking: off\n  mode: solo\n`);
	return { home, root };
}

/**
 * Models with a faux provider `faux` serving model `m` (scripted by `script`) and a second, `faux-title`/`t`, that
 * `tempHome` configures as `defaults.title_model` (scripted by `scriptTitle`; unscripted it errors, so titling fails).
 */
export function fauxModels(): {
	models: MutableModels;
	script(responses: FauxResponseStep[]): void;
	scriptTitle(responses: FauxResponseStep[]): void;
} {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const title = fauxProvider({ provider: "faux-title", models: [{ id: "t" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	models.setProvider(title.provider);
	return { models, script: (responses) => faux.setResponses(responses), scriptTitle: (responses) => title.setResponses(responses) };
}

/** A fake `bash` tool that records the commands it ran. */
export function fakeBash(): { module: ToolModule; ran: string[] } {
	const ran: string[] = [];
	const bash = defineTool({
		name: "bash",
		description: "Run a shell command.",
		parameters: obj({ command: str() }),
		async execute(args) {
			ran.push(args.command);
			return { output: [{ type: "text", text: `ran: ${args.command}` }] };
		},
	});
	return { module: { tools: [bash] }, ran };
}

/** Concatenated text blocks of an entry's first model message. */
export function entryText(entry: EntryRecord | undefined): string {
	const content = entry?.model?.[0]?.content ?? [];
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
