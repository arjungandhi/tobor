import type { ProviderAuth } from "../../api/types.js";
import type { App } from "../app.js";
import { c } from "../theme.js";

function authLine(auth: ProviderAuth): string {
	const expires = auth.expiresAt ? ` · expires ${new Date(auth.expiresAt).toLocaleString()}` : "";
	return `${auth.source === "none" ? "not logged in" : auth.source}${expires}${auth.oauth ? "" : " · no OAuth login"}`;
}

/** Login: pick a provider, start the OAuth flow on the node, show the URL, then send the code the provider displays. */
export async function showLogin(app: App): Promise<void> {
	const client = app.api();
	const auth = await client.auth();
	const providers = Object.entries(auth).sort(([a], [b]) => Number(auth[b]?.oauth ?? false) - Number(auth[a]?.oauth ?? false) || a.localeCompare(b));
	const picked = await app.pick(
		"login",
		providers.map(([name, status]) => ({
			value: name,
			label: `${status.source === "none" ? c.dim("○") : c.success("●")} ${name}`,
			description: authLine(status),
		})),
		{ lines: [c.dim(`credentials are stored on ${app.workspace?.name ?? "the node"}, never in this terminal`)] },
	);
	if (!picked?.value) return;
	const provider = picked.value;
	if (!auth[provider]?.oauth) throw new Error(`${provider} has no OAuth login; set its API key in the node's env file`);
	const { url, instructions } = await client.loginStart(provider);
	const code = await app.ask(`login · ${provider}`, {
		lines: [
			"Open this URL on any device and approve:",
			"",
			c.accent(url),
			"",
			...(instructions ? [c.dim(instructions), ""] : []),
			"Then paste the code it shows:",
		],
		placeholder: "code",
		hint: "Enter submit · Esc cancel · select the URL with the mouse to copy",
	});
	if (!code?.trim()) return;
	const result = await client.loginCode(provider, code.trim());
	app.flash(`${provider}: ${authLine(result.auth)}`);
}
