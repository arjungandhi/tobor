import type { ProviderAuth } from "../../api/types.js";
import type { App } from "../app.js";
import { type NavOutcome, navigate } from "../nav.js";
import { c } from "../theme.js";

function authLine(auth: ProviderAuth): string {
	const expires = auth.expiresAt ? ` · expires ${new Date(auth.expiresAt).toLocaleString()}` : "";
	return `${auth.source === "none" ? "not logged in" : auth.source}${expires}${auth.oauth ? "" : " · no OAuth login"}`;
}

/** Login: pick a provider, start the OAuth flow on the node, show the URL, then send the code the provider displays. The picker stays open after every outcome. */
export async function showLogin(app: App): Promise<void> {
	const client = app.api();
	let auth: Awaited<ReturnType<typeof client.auth>> = {};
	await navigate<string>(app, {
		view: async () => {
			auth = await client.auth();
			const providers = Object.entries(auth).sort(([a], [b]) => Number(auth[b]?.oauth ?? false) - Number(auth[a]?.oauth ?? false) || a.localeCompare(b));
			return {
				title: "login",
				items: providers.map(([name, status]) => ({
					value: name,
					label: `${status.source === "none" ? c.dim("○") : c.success("●")} ${name}`,
					description: authLine(status),
				})),
				lines: [c.dim(`credentials are stored on ${app.workspace?.name ?? "the node"}, never in this terminal`)],
				hint: "Enter log in · Esc back",
			};
		},
		key: (name) => name,
		onPick: async (picked): Promise<NavOutcome> => {
			const provider = picked.value;
			if (!provider) return "stay";
			if (!auth[provider]?.oauth) {
				await app.info(`login · ${provider}`, [`${provider} has no OAuth login.`, "", "Set its API key in the node's env file."]);
				return "stay";
			}
			const { url, instructions } = await client.loginStart(provider);
			let problem: string | undefined;
			for (;;) {
				const code = await app.ask(`login · ${provider}`, {
					lines: [
						"Open this URL on any device and approve:",
						"",
						c.accent(url),
						"",
						...(instructions ? [c.dim(instructions), ""] : []),
						...(problem ? [c.error(`✗ ${problem}`), ""] : []),
						"Then paste the code it shows:",
					],
					placeholder: "code",
					hint: "Enter submit · Esc back · select the URL with the mouse to copy",
				});
				if (code === undefined) {
					app.flash(`${provider}: login abandoned; the started OAuth flow was not completed`);
					return "stay";
				}
				if (!code.trim()) continue;
				try {
					const result = await client.loginCode(provider, code.trim());
					app.flash(`${provider}: ${authLine(result.auth)}`);
					return "refresh";
				} catch (err) {
					problem = (err as Error).message ?? String(err);
				}
			}
		},
	});
}
