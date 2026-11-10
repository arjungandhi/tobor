import type { AuthInteraction, AuthPrompt, CredentialStore } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type {
	AuthStatusResponse,
	LoginCodeResponse,
	LoginStartResponse,
	ModelInfo,
	ModelsResponse,
	ProviderAuth,
} from "../api/types.js";
import type { Config } from "../config/schema.js";
import { HostError, type AuthService as AuthServiceContract } from "../host.js";

/** Dependencies of `AuthService`. */
export type AuthServiceOptions = {
	models: MutableModels;
	credentials: CredentialStore;
	/** Current node config (defaults for the model picker). */
	config: () => Config;
	/** Abandon a started login after this long. Default 15 min. */
	loginTimeoutMs?: number;
};

type PendingLogin = {
	abort: AbortController;
	code: PromiseWithResolvers<string>;
	done: Promise<unknown>;
};

/** Auth status per provider, the model catalog, and the two-call OAuth login (start → URL, code → credential). */
export class AuthService implements AuthServiceContract {
	private readonly logins = new Map<string, PendingLogin>();

	constructor(private readonly options: AuthServiceOptions) {}

	async status(): Promise<AuthStatusResponse> {
		const out: AuthStatusResponse = {};
		await Promise.all(
			this.options.models.getProviders().map(async (p) => {
				out[p.id] = await this.providerAuth(p.id);
			}),
		);
		return out;
	}

	async models(): Promise<ModelsResponse> {
		const providers = await this.status();
		const models: ModelInfo[] = this.options.models.getModels().map((m) => ({
			ref: `${m.provider}/${m.id}`,
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			cost: { input: m.cost.input, output: m.cost.output },
			available: (providers[m.provider]?.source ?? "none") !== "none",
		}));
		const { model, thinking } = this.options.config().defaults;
		return { models, providers, defaults: { model, thinking } };
	}

	async loginStart(provider: string): Promise<LoginStartResponse> {
		const p = this.options.models.getProvider(provider);
		if (!p) throw new HostError(404, "unknown_provider", `unknown provider ${JSON.stringify(provider)}`);
		if (!p.auth.oauth) throw new HostError(400, "no_oauth", `provider ${provider} has no OAuth login`);
		this.logins.get(provider)?.abort.abort(new Error("superseded by a new login"));

		const abort = new AbortController();
		const code = Promise.withResolvers<string>();
		const url = Promise.withResolvers<LoginStartResponse>();
		const timer = setTimeout(
			() => abort.abort(new Error("login timed out")),
			this.options.loginTimeoutMs ?? 15 * 60_000,
		);
		timer.unref();
		const interaction: AuthInteraction = {
			signal: abort.signal,
			prompt: (prompt) => answerPrompt(prompt, code.promise),
			notify: (event) => {
				if (event.type === "auth_url") {
					url.resolve({ url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) });
				}
			},
		};
		abort.signal.addEventListener("abort", () => code.reject(abort.signal.reason), { once: true });
		const done = this.options.models.login(provider, "oauth", interaction).finally(() => clearTimeout(timer));
		const entry: PendingLogin = { abort, code, done };
		this.logins.set(provider, entry);
		done.catch((err: unknown) => url.reject(err));
		code.promise.catch(() => {});
		try {
			return await url.promise;
		} catch (err) {
			if (this.logins.get(provider) === entry) this.logins.delete(provider);
			throw new HostError(400, "login_failed", errorMessage(err));
		}
	}

	async loginCode(provider: string, code: string): Promise<LoginCodeResponse> {
		const entry = this.logins.get(provider);
		if (!entry) throw new HostError(409, "no_login", `no login in progress for ${provider}`);
		entry.code.resolve(code.trim());
		try {
			await entry.done;
		} catch (err) {
			throw new HostError(400, "login_failed", errorMessage(err));
		} finally {
			if (this.logins.get(provider) === entry) this.logins.delete(provider);
		}
		return { ok: true, auth: await this.providerAuth(provider) };
	}

	/** Abort every login in progress (shutdown). */
	cancelLogins(): void {
		for (const entry of this.logins.values()) entry.abort.abort(new Error("node shutting down"));
		this.logins.clear();
	}

	private async providerAuth(providerId: string): Promise<ProviderAuth> {
		const provider = this.options.models.getProvider(providerId);
		const oauth = provider?.auth.oauth !== undefined;
		const stored = await this.options.credentials.read(providerId).catch(() => undefined);
		if (stored?.type === "oauth") return { source: "oauth", expiresAt: stored.expires, oauth };
		const check = await this.options.models.checkAuth(providerId).catch(() => undefined);
		return { source: check ? "env" : "none", oauth };
	}
}

/** Answer one login prompt: headless method for selects, the operator's code for everything else. */
function answerPrompt(prompt: AuthPrompt, code: Promise<string>): Promise<string> {
	if (prompt.type === "select") {
		const headless =
			prompt.options.find((o) => /copy|code|headless|manual|paste/i.test(`${o.id} ${o.label}`)) ?? prompt.options[0];
		if (!headless) return Promise.reject(new Error(`login prompt has no options: ${prompt.message}`));
		return Promise.resolve(headless.id);
	}
	const signal = prompt.signal;
	if (!signal) return code;
	const answer = Promise.withResolvers<string>();
	const onAbort = () => answer.reject(signal.reason ?? new Error("prompt cancelled"));
	if (signal.aborted) onAbort();
	signal.addEventListener("abort", onAbort, { once: true });
	code.then(answer.resolve, answer.reject).finally(() => signal.removeEventListener("abort", onAbort));
	return answer.promise;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
