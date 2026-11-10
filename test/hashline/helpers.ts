import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, FileError, type FileInfo, ok, type Result } from "@earendil-works/pi-durable/env";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { basename, dirname, join, resolve } from "node:path";
import { createHashlineEditTool } from "../../src/tools/edit.js";
import type { FileToolDeps } from "../../src/tools/filetools.js";
import { SnapshotStore } from "../../src/tools/hashline/snapshots.js";
import { createHashlineReadTool } from "../../src/tools/read.js";
import { writeWrapper } from "../../src/tools/write.js";

const enc = new TextEncoder();
const notFound = (p: string) => err<never, FileError>(new FileError("not_found", `ENOENT: no such file or directory, '${p}'`, p));

/** An in-memory `ExecutionEnv` covering the file operations the hashline tools use; logs mutations in order. */
export class FakeEnv {
	readonly id = "fake";
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>(["/"]);
	readonly log: string[] = [];
	failRename?: (source: string, dest: string) => string | undefined;
	failRemove?: (path: string) => boolean;

	constructor(public cwd = "/work") {
		this.addDir(cwd);
	}

	addDir(p: string): void {
		for (let d = p; !this.dirs.has(d); d = dirname(d)) this.dirs.add(d);
	}

	set(path: string, content: string | Uint8Array): void {
		const abs = resolve(this.cwd, path);
		this.addDir(dirname(abs));
		this.files.set(abs, typeof content === "string" ? enc.encode(content) : content);
	}

	text(path: string): string | undefined {
		const bytes = this.files.get(resolve(this.cwd, path));
		return bytes && new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
	}

	async absolutePath(p: string): Promise<Result<string, FileError>> {
		return ok(resolve(this.cwd, p));
	}
	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}
	async readBinaryFile(p: string): Promise<Result<Uint8Array, FileError>> {
		const abs = resolve(this.cwd, p);
		const bytes = this.files.get(abs);
		if (bytes) return ok(bytes.slice());
		if (this.dirs.has(abs)) return err(new FileError("is_directory", "EISDIR: illegal operation on a directory, read", abs));
		return notFound(abs);
	}
	async readTextFile(p: string): Promise<Result<string, FileError>> {
		const r = await this.readBinaryFile(p);
		return r.ok ? ok(new TextDecoder().decode(r.value)) : r;
	}
	async writeFile(p: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const abs = resolve(this.cwd, p);
		this.addDir(dirname(abs));
		this.files.set(abs, typeof content === "string" ? enc.encode(content) : content);
		this.log.push(`write ${abs}`);
		return ok(undefined);
	}
	async renameFile(s: string, d: string): Promise<Result<void, FileError>> {
		const src = resolve(this.cwd, s);
		const dst = resolve(this.cwd, d);
		const failure = this.failRename?.(src, dst);
		if (failure) return err(new FileError("unknown", failure, src));
		const bytes = this.files.get(src);
		if (!bytes) return notFound(src);
		this.addDir(dirname(dst));
		this.files.set(dst, bytes);
		this.files.delete(src);
		this.log.push(`rename ${src} ${dst}`);
		return ok(undefined);
	}
	async fileInfo(p: string): Promise<Result<FileInfo, FileError>> {
		const abs = resolve(this.cwd, p);
		const bytes = this.files.get(abs);
		if (bytes) return ok({ name: basename(abs), path: abs, kind: "file", size: bytes.length, mtimeMs: 0 });
		if (this.dirs.has(abs)) return ok({ name: basename(abs), path: abs, kind: "directory", size: 0, mtimeMs: 0 });
		return notFound(abs);
	}
	async listDir(p: string): Promise<Result<FileInfo[], FileError>> {
		const abs = resolve(this.cwd, p);
		const out: FileInfo[] = [];
		for (const d of this.dirs) if (d !== abs && dirname(d) === abs) out.push({ name: basename(d), path: d, kind: "directory", size: 0, mtimeMs: 0 });
		for (const [f, b] of this.files) if (dirname(f) === abs) out.push({ name: basename(f), path: f, kind: "file", size: b.length, mtimeMs: 0 });
		return ok(out);
	}
	async canonicalPath(p: string): Promise<Result<string, FileError>> {
		const abs = resolve(this.cwd, p);
		return this.files.has(abs) || this.dirs.has(abs) ? ok(abs) : notFound(abs);
	}
	async exists(p: string): Promise<Result<boolean, FileError>> {
		const abs = resolve(this.cwd, p);
		return ok(this.files.has(abs) || this.dirs.has(abs));
	}
	async remove(p: string, options?: { force?: boolean }): Promise<Result<void, FileError>> {
		const abs = resolve(this.cwd, p);
		if (this.failRemove?.(abs)) return err(new FileError("permission_denied", `EACCES: permission denied, unlink '${abs}'`, abs));
		if (!this.files.delete(abs) && !options?.force) return notFound(abs);
		this.log.push(`remove ${abs}`);
		return ok(undefined);
	}
	async createDir(p: string): Promise<Result<void, FileError>> {
		this.addDir(resolve(this.cwd, p));
		return ok(undefined);
	}
	async exec(): Promise<Result<{ exitCode: number }, never>> {
		return ok({ exitCode: 0 });
	}
}

/** Text, error flag and details of a tool result. */
export interface Reply {
	text: string;
	isError: boolean;
	details: Record<string, unknown>;
	diagnostics: readonly { code?: string }[];
}

const toReply = (r: ToolExecutionResult): Reply => ({
	text: (r.output ?? []).map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n"),
	isError: r.isError === true,
	details: (r.details ?? {}) as Record<string, unknown>,
	diagnostics: r.diagnostics ?? [],
});

/** The three file tools over one fake env and snapshot store, in conversation `conversation`. */
export function setup(home = "/home/u/.local/share/tobor") {
	const env = new FakeEnv();
	const deps: FileToolDeps = { home, store: new SnapshotStore() };
	const readTool = createHashlineReadTool(deps);
	const editTool = createHashlineEditTool(deps);
	const writeTool = writeWrapper(deps)(createWriteTool());
	let conversationId = 1 as unknown as ConversationId;
	const api = () => ({ env: env as unknown as ExecutionEnv, conversationId }) as unknown as ToolExecutionApi;
	return {
		env,
		deps,
		useConversation(id: number) {
			conversationId = id as unknown as ConversationId;
		},
		read: async (path: string) => toReply(await readTool.execute({ path }, api() as never, BACKGROUND_CONTEXT)),
		edit: async (input: string) => toReply(await editTool.execute({ input }, api() as never, BACKGROUND_CONTEXT)),
		write: async (path: string, content: string) => toReply(await writeTool.execute({ path, content }, api() as never, BACKGROUND_CONTEXT)),
	};
}

/** `[path#TAG]` from the first line of a reply. */
export function tagOf(reply: Reply): string {
	const m = /#([0-9A-F]{4})\]/.exec(reply.text);
	if (!m) throw new Error(`no tag in: ${reply.text}`);
	return m[1]!;
}

/** `n` numbered lines `line1..lineN`, LF-terminated. */
export function numbered(n: number, term = "\n"): string {
	return Array.from({ length: n }, (_, i) => `line${i + 1}${term}`).join("");
}
