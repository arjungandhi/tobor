import { createHash } from "node:crypto";
import { normalizedText, type TextFile } from "./lineio.js";

/** A file version: the full SHA-256 (hex) and its 4-hex-digit tag. */
export interface FileHash {
	fullHash: string;
	tag: string;
}

/** Hash LF-normalised text; the tag is the first 2 bytes as uppercase hex. */
export function hashText(normalized: string): FileHash {
	const fullHash = createHash("sha256").update(normalized, "utf8").digest("hex");
	return { fullHash, tag: fullHash.slice(0, 4).toUpperCase() };
}

/** Hash of a decoded file. */
export function hashFile(file: TextFile): FileHash {
	return hashText(normalizedText(file));
}

/** Whether `tag` has the shape of a real tag (4 hex digits, any case). */
export function isTag(tag: string): boolean {
	return /^[0-9A-Fa-f]{4}$/.test(tag);
}
