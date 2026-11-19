import { describe, expect, it } from "vitest";
import { clipboardImage, MAX_ATTACHMENT_BYTES } from "../../src/tui/attachments.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [..."GIF89a"].map((ch) => ch.charCodeAt(0));
const WEBP = [..."RIFF"].map((ch) => ch.charCodeAt(0)).concat([1, 2, 3, 4], [..."WEBP"].map((ch) => ch.charCodeAt(0)));

const bytes = (head: number[], length = head.length + 16): Uint8Array => {
	const out = new Uint8Array(length);
	out.set(head);
	return out;
};

describe("clipboardImage", () => {
	it("names the image after its type and numbers it", () => {
		expect(clipboardImage(bytes(PNG), 1)).toMatchObject({ name: "pasted-1.png", attachment: { mimeType: "image/png" } });
		expect(clipboardImage(bytes(JPEG), 2)).toMatchObject({ name: "pasted-2.jpg", attachment: { mimeType: "image/jpeg" } });
		expect(clipboardImage(bytes(GIF), 3)).toMatchObject({ name: "pasted-3.gif", attachment: { mimeType: "image/gif" } });
		expect(clipboardImage(bytes(WEBP), 4)).toMatchObject({ name: "pasted-4.webp", attachment: { mimeType: "image/webp" } });
	});

	it("base64-encodes exactly the given bytes, also for a view into a larger buffer", () => {
		const data = bytes(PNG, 40).map((b, i) => (i < PNG.length ? b : i * 7));
		const staged = clipboardImage(data, 1);
		expect(staged.bytes).toBe(40);
		expect(staged.attachment.type).toBe("image");
		expect(new Uint8Array(Buffer.from(staged.attachment.data, "base64"))).toEqual(data);
		const view = new Uint8Array(new Uint8Array([9, 9, ...data, 9]).buffer, 2, data.length);
		expect(new Uint8Array(Buffer.from(clipboardImage(view, 1).attachment.data, "base64"))).toEqual(data);
	});

	it("rejects empty data, non-images and oversize images", () => {
		expect(() => clipboardImage(new Uint8Array(0), 1)).toThrow("clipboard: image is empty");
		expect(() => clipboardImage(new TextEncoder().encode("hello world, not an image"), 1)).toThrow("clipboard: not a PNG, JPEG, GIF or WebP image");
		expect(() => clipboardImage(bytes(PNG, MAX_ATTACHMENT_BYTES + 1), 1)).toThrow("clipboard: 5.0 MB is over the 5.0 MB limit");
	});

	it("accepts an image of exactly the size limit", () => {
		expect(clipboardImage(bytes(PNG, MAX_ATTACHMENT_BYTES), 1).bytes).toBe(MAX_ATTACHMENT_BYTES);
	});
});
