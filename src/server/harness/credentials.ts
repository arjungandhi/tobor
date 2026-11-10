import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

/** Options for `FileCredentialStore`. */
export type FileCredentialStoreOptions = {
	/** A lock file older than this is considered abandoned and is taken over. Default 60 s. */
	staleLockMs?: number;
	/** Give up acquiring the lock after this long. Default 30 s. */
	lockTimeoutMs?: number;
};

type CredentialFile = Record<string, Credential>;

/**
 * pi-ai `CredentialStore` over one JSON file (mode 0600). Every call re-reads the file, so a login written by another
 * process is seen at once; mutations run under `<file>.lock` and land with an atomic rename.
 */
export class FileCredentialStore implements CredentialStore {
	private readonly lockPath: string;
	private readonly staleLockMs: number;
	private readonly lockTimeoutMs: number;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly path: string,
		options: FileCredentialStoreOptions = {},
	) {
		this.lockPath = `${path}.lock`;
		this.staleLockMs = options.staleLockMs ?? 60_000;
		this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.locked(async () => {
			const all = await this.load();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			all[providerId] = next;
			await this.save(all);
			return next;
		}, options?.signal);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.locked(async () => {
			const all = await this.load();
			if (!(providerId in all)) return;
			delete all[providerId];
			await this.save(all);
		}, options?.signal);
	}

	private async load(): Promise<CredentialFile> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
		if (text.trim() === "") return {};
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${this.path}: expected a JSON object`);
		}
		return parsed as CredentialFile;
	}

	private async save(all: CredentialFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(all, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(tmp, this.path);
		} catch (err) {
			await unlink(tmp).catch(() => {});
			throw err;
		}
	}

	/** Serialize in-process callers, then hold the cross-process lock file around `fn`. */
	private locked<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		const run = this.chain.then(async () => {
			await this.acquire(signal);
			try {
				return await fn();
			} finally {
				await unlink(this.lockPath).catch(() => {});
			}
		});
		this.chain = run.catch(() => {});
		return run;
	}

	private async acquire(signal: AbortSignal | undefined): Promise<void> {
		await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + this.lockTimeoutMs;
		let delay = 5;
		for (;;) {
			signal?.throwIfAborted();
			try {
				const handle = await open(this.lockPath, "wx", 0o600);
				await handle.writeFile(`${process.pid}\n`);
				await handle.close();
				return;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
			const info = await stat(this.lockPath).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > this.staleLockMs) {
				await unlink(this.lockPath).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) throw new Error(`${this.lockPath}: lock held for over ${this.lockTimeoutMs} ms`);
			await sleep(delay);
			delay = Math.min(delay * 2, 100);
		}
	}
}
