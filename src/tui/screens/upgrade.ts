import type { App } from "../app.js";
import { mismatchHint, upgradeErrorMessage, waitForNode } from "../node-upgrade.js";
import { probe } from "../workspaces.js";
import { BUILD, VERSION } from "../../version.js";
import { c } from "../theme.js";

/** `/upgrade`: confirm, have the connected node download the latest release and restart, then wait for it to come back. */
export async function upgradeNode(app: App): Promise<void> {
	const client = app.api();
	const who = app.whoami;
	if (who?.build === "dev") throw new Error("the node runs from source; upgrading is not supported");
	const lines = who?.update_available
		? [`${c.accent(`tobor ${who.version} → ${who.latest_version}`)} is available on ${app.workspace?.name}.`]
		: [`${app.workspace?.name} runs tobor ${who?.version ?? "?"}; the node checks for a newer release first.`];
	lines.push("The node replaces its binary and restarts; this terminal reconnects when it is back.");
	if (!(await app.confirm("upgrade node", lines))) return;
	app.flash("upgrading node…");
	let res;
	try {
		res = await client.upgrade();
	} catch (err) {
		throw new Error(upgradeErrorMessage(err));
	}
	if (res.status === "current") return app.flash(`node is up to date (tobor ${res.version})`);
	await reconnect(app, client, `${res.version} → ${res.latest}`);
}

/** `/restart`: confirm, restart the connected node and wait for it to come back. */
export async function restartNode(app: App): Promise<void> {
	const client = app.api();
	if (!(await app.confirm("restart node", [`Restart ${app.workspace?.name}? This terminal reconnects when it is back.`]))) return;
	try {
		await client.restart();
	} catch (err) {
		throw new Error(upgradeErrorMessage(err));
	}
	await reconnect(app, client, undefined);
}

/**
 * After the node accepted an upgrade/restart: show "node restarting…" in the status line until it answers again (the events
 * socket reconnects by itself and refetches; this waits only to report), then flag a client/node build mismatch.
 */
async function reconnect(app: App, client: NonNullable<App["client"]>, change: string | undefined): Promise<void> {
	const workspace = app.workspace;
	if (!workspace) return;
	app.restarting = true;
	app.flash(`node restarting…${change ? ` (tobor ${change})` : ""}`);
	app.changed();
	try {
		const before = app.whoami;
		const result = await waitForNode({ probe: () => probe(workspace), ...(before ? { before } : {}) });
		if (client !== app.client) return;
		if (result.status === "timeout") return app.flash(`✗ ${workspace.name} did not come back within 60 s; the TUI keeps retrying`);
		await app.refresh();
		if (client !== app.client) return;
		const node = app.whoami;
		const hint = mismatchHint({ version: VERSION, build: BUILD }, node);
		app.flash(
			result.status === "unconfirmed"
				? `${workspace.name} kept answering; could not confirm the restart`
				: `node restarted: tobor ${node?.version ?? result.whoami.version}${hint ? ` · ${hint}` : ""}`,
		);
	} finally {
		app.restarting = false;
		app.changed();
	}
}
