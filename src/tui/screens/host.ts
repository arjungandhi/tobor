import type { WhoamiResponse } from "../../api/types.js";
import type { App } from "../app.js";
import { ApiClient } from "../client.js";
import { addOrSelect, baseUrl, removeContext, selectContext } from "../contexts.js";
import { c } from "../theme.js";

function whoamiLines(w: WhoamiResponse | undefined, host: string): string[] {
	if (!w) return [c.warning(`${host}: not reachable`)];
	return [
		`${c.accent(w.host)} ${c.dim(`tobor ${w.version} · pi-durable ${w.pi_durable} · node ${w.node}`)}`,
		c.dim(`api ${w.public_url} · artifacts ${w.artifacts_url}${w.ntfy_topic ? ` · ntfy ${w.ntfy_topic}` : ""}`),
		w.chrome.found ? c.success(`chrome ${w.chrome.version ?? "found"} (PDF export)`) : c.warning("chrome not found: PDF export unavailable"),
	];
}

/** Ctrl+T: saved contexts with the active node's whoami; Enter switches, a adds, d removes. */
export async function showHosts(app: App): Promise<void> {
	const config = app.config;
	const active = app.context;
	const items = config.contexts.map((ctx) => ({
		value: ctx.name,
		label: `${ctx.name === config.active ? c.accent("● ") : "  "}${ctx.name}`,
		description: ctx.host,
	}));
	const picked = await app.pick("hosts", items, {
		lines: active ? whoamiLines(app.whoami, active.host) : [c.dim("no host selected")],
		hint: "Enter switch · a add · d remove · Esc close",
		keys: ["a", "d"],
		selected: Math.max(0, config.contexts.findIndex((x) => x.name === config.active)),
	});
	if (!picked) return;
	if (picked.key === "a") return addHost(app);
	const name = picked.value;
	if (!name) return;
	if (picked.key === "d") {
		if (!(await app.confirm(`remove ${name}`, [`Forget ${name}? The node is not touched.`]))) return showHosts(app);
		const next = removeContext(config, name);
		if (name === config.active) app.switchContext(next);
		else {
			app.config = next;
			app.saveConfig();
		}
		return showHosts(app);
	}
	if (name !== config.active) app.switchContext(selectContext(config, name));
}

async function addHost(app: App): Promise<void> {
	const host = await app.ask("add host", { placeholder: "host:port (default port 7879)", lines: [c.dim("the node's API address, e.g. a tailnet name")] });
	if (!host?.trim()) return showHosts(app);
	const next = addOrSelect(app.config, host);
	const name = next.active ?? host;
	const context = next.contexts.find((x) => x.name === name);
	if (context) {
		try {
			const who = await new ApiClient(baseUrl(context.host)).whoami();
			app.flash(`${context.host}: ${who.host} · tobor ${who.version}`);
		} catch (err) {
			if (!(await app.confirm(`${context.host} not reachable`, [(err as Error).message, "", "Save it anyway?"]))) return showHosts(app);
		}
	}
	app.switchContext(next);
}
