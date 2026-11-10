// Client-side image attachments: `/attach <path>` reads a local file, checks it and stages it on the composer until the
// next message is sent. The node enforces the same limits (8 per message, 5 MB decoded each).
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { ImageAttachment } from "../api/types.js";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** An image waiting to be sent with the next message. */
export type StagedImage = { name: string; bytes: number; attachment: ImageAttachment };

type ImageMime = ImageAttachment["mimeType"];

/** The image type of `head` by magic bytes, or undefined when it is not a PNG, JPEG, GIF or WebP. */
export function sniffImage(head: Uint8Array): ImageMime | undefined {
	const at = (i: number): number => head[i] ?? -1;
	const ascii = (from: number, text: string): boolean => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
	if (at(0) === 0x89 && ascii(1, "PNG") && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	return undefined;
}

/** `~` and `~/…` expand to the home directory; anything else resolves against the TUI's cwd. Surrounding quotes are dropped. */
export function expandPath(input: string): string {
	let path = input.trim();
	if (path.length >= 2 && (path[0] === '"' || path[0] === "'") && path.endsWith(path[0] as string)) path = path.slice(1, -1);
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return resolve(path);
}

/** `120 KB`, `0.9 MB`. */
export function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Read and validate a local image file. Throws an Error with a user-facing message on any problem. */
export async function loadImage(input: string): Promise<StagedImage> {
	const path = expandPath(input);
	const name = basename(path);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new Error(code === "ENOENT" ? `${path}: no such file` : `${path}: ${(err as Error).message}`);
	}
	if (!info.isFile()) throw new Error(`${path}: not a file`);
	if (info.size === 0) throw new Error(`${name}: file is empty`);
	if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name}: ${formatSize(info.size)} is over the ${formatSize(MAX_ATTACHMENT_BYTES)} limit`);
	let data: Buffer;
	try {
		data = await readFile(path);
	} catch (err) {
		throw new Error(`${path}: ${(err as Error).message}`);
	}
	if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name}: ${formatSize(data.length)} is over the ${formatSize(MAX_ATTACHMENT_BYTES)} limit`);
	const mimeType = sniffImage(data.subarray(0, 12));
	if (!mimeType) throw new Error(`${name}: not a PNG, JPEG, GIF or WebP image`);
	return { name, bytes: data.length, attachment: { type: "image", data: data.toString("base64"), mimeType } };
}
