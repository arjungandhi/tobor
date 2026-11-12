import { describe, expect, it } from "vitest";
import { convertLegacy, parseAddress } from "../../src/tui/workspaces.js";

describe("parseAddress", () => {
	it("keeps an explicit scheme-default port", () => {
		expect(parseAddress("host:80")).toEqual({ host: "host", port: 80 });
		expect(parseAddress("http://host:80")).toEqual({ host: "host", port: 80 });
		expect(parseAddress("https://host:443")).toEqual({ host: "https://host", port: 443 });
	});

	it("still accepts the other forms", () => {
		expect(parseAddress("host")).toEqual({ host: "host", port: 7879 });
		expect(parseAddress("host:1234")).toEqual({ host: "host", port: 1234 });
		expect(parseAddress("http://host:1234/")).toEqual({ host: "host", port: 1234 });
		expect(parseAddress("https://host")).toEqual({ host: "https://host", port: 443 });
		expect(parseAddress("https://host:8443")).toEqual({ host: "https://host", port: 8443 });
	});
});

describe("convertLegacy", () => {
	it("skips contexts with an unparseable host", () => {
		const json = JSON.stringify({ contexts: [{ name: "bad", host: "ftp://x" }, { name: "good", host: "h:1" }] });
		const { yaml, skipped } = convertLegacy(json);
		expect(skipped).toEqual(["bad (ftp://x)"]);
		expect(yaml).toContain("good");
	});
});
