// System clipboard for Ctrl+V: pi-tui's native helper first, then `wl-paste` on Wayland (the native helper needs an X11 DISPLAY on Linux).
import { execFile } from "node:child_process";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";

/** What the clipboard held. `available` is false when no source could be read at all (no native helper, no wl-paste). `wlPasteMissing` is set on Wayland (WAYLAND_DISPLAY) when `wl-paste` is not installed, even if the native helper ran. */
export type ClipboardContent = { available: boolean; image?: Uint8Array; text?: string; wlPasteMissing?: boolean };

/** Shown when the clipboard cannot be read because `wl-paste` is missing on Wayland. */
export const WL_CLIPBOARD_HINT = "on Wayland install wl-clipboard";

const PASTE_MARKERS = /\x1b\[20[01]~/g;

/** Remove bracketed-paste markers so pasted text cannot end its own paste early (repeats until stable: a removal can splice a new marker together). */
export function stripPasteMarkers(text: string): string {
	let out = text;
	for (let prev = ""; prev !== out; ) {
		prev = out;
		out = out.replace(PASTE_MARKERS, "");
	}
	return out;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_TYPES = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"];

/** The offered MIME type to read an image from (`wl-paste --list-types` output): PNG first, then the other types attachments accept. */
export function pickImageType(listTypes: string): string | undefined {
	const offered = new Set(listTypes.split("\n").map((line) => line.trim().toLowerCase()));
	return IMAGE_TYPES.find((type) => offered.has(type));
}

/** Whether `wl-paste --list-types` output offers any plain-text type. */
export function offersText(listTypes: string): boolean {
	const offered = new Set(listTypes.split("\n").map((line) => line.trim()));
	return TEXT_TYPES.some((type) => offered.has(type));
}

/** Image reads get a generous buffer so an oversized image is read and rejected with the proper over-limit error, not a silent failure. */
const IMAGE_MAX_BUFFER = 64 * 1024 * 1024;
const TEXT_MAX_BUFFER = 2 * MAX_ATTACHMENT_BYTES;

/** Run `wl-paste`; undefined when it is missing (ENOENT), `null` when it ran and failed or timed out (e.g. an empty clipboard). */
function wlPaste(args: string[], maxBuffer: number): Promise<Buffer | null | undefined> {
	return new Promise((resolve) => {
		execFile("wl-paste", args, { encoding: "buffer", maxBuffer, timeout: 3000 }, (err, stdout) => {
			if (!err) resolve(stdout);
			else resolve((err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null);
		});
	});
}

/** Read the Wayland clipboard through `wl-paste`; an image wins over text. */
async function readWayland(): Promise<ClipboardContent> {
	const listed = await wlPaste(["--list-types"], TEXT_MAX_BUFFER);
	if (listed === undefined) return { available: false };
	if (listed === null) return { available: true };
	const types = listed.toString("utf8");
	const imageType = pickImageType(types);
	if (imageType) {
		const image = await wlPaste(["--type", imageType], IMAGE_MAX_BUFFER);
		if (image && image.length > 0) return { available: true, image: new Uint8Array(image.buffer, image.byteOffset, image.length) };
	}
	if (offersText(types)) {
		const text = await wlPaste(["--no-newline", "--type", "text/plain"], TEXT_MAX_BUFFER);
		if (text && text.length > 0) return { available: true, text: text.toString("utf8") };
	}
	return { available: true };
}

/** The clipboard's image, else its text. Never throws: a source that fails counts as having nothing. */
export async function readClipboard(): Promise<ClipboardContent> {
	let available = false;
	const native = getNativeClipboard();
	if (native) {
		available = true;
		try {
			const image = await native.getImage();
			if (image) return { available, image };
			const text = await native.getText();
			if (text) return { available, text };
		} catch {
			// Fall through to wl-paste.
		}
	}
	let wlPasteMissing = false;
	if (process.env.WAYLAND_DISPLAY) {
		const wayland = await readWayland();
		if (wayland.available) return wayland;
		wlPasteMissing = true;
	}
	return { available, ...(wlPasteMissing ? { wlPasteMissing } : {}) };
}
