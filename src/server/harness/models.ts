import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthContext, CredentialStore } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export { builtinModels };

/** Inputs for `createModels`. */
export type CreateModelsOptions = {
	/** tobor's file-backed store; a stored OAuth credential wins over an env key. */
	credentials: CredentialStore;
	/** `env_file` variables, consulted before `process.env` for provider API keys. */
	env?: Readonly<Record<string, string>>;
};

/** Every built-in pi-ai provider over tobor's credential store, with `env_file` keys as the API-key fallback. */
export function createModels(options: CreateModelsOptions): MutableModels {
	const env = options.env ?? {};
	const authContext: AuthContext = {
		env: async (name) => env[name] ?? process.env[name],
		fileExists: async (path) => {
			const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
			return access(expanded).then(
				() => true,
				() => false,
			);
		},
	};
	return builtinModels({ credentials: options.credentials, authContext });
}
