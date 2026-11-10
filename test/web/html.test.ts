import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "../../src/tools/web/html.js";

describe("htmlToText", () => {
	it("keeps the title and renders headings as #", () => {
		const { title, text } = htmlToText(
			"<html><head><title>My &amp; Page</title></head><body><h1>Top</h1><p>Intro text.</p><h3>Sub <em>part</em></h3></body></html>",
		);
		expect(title).toBe("My & Page");
		expect(text).toBe("# Top\n\nIntro text.\n\n### Sub part");
	});

	it("renders links as [text](absolute url) and drops javascript: and fragment hrefs", () => {
		const { text } = htmlToText(
			'<p>See <a href="/docs/x?a=1&amp;b=2">the docs</a>, <a href="https://e.org">e</a>, <a href="#top">top</a> and <a href="javascript:void(0)">js</a>.</p>',
			"https://example.com/base/page",
		);
		expect(text).toBe("See [the docs](https://example.com/docs/x?a=1&b=2), [e](https://e.org/), top and js.");
	});

	it("renders nested ordered and unordered lists", () => {
		const { text } = htmlToText("<ul><li>one<li>two<ul><li>two.a</li></ul></li></ul><ol start=3><li>three</li><li>four</li></ol>");
		expect(text).toBe("- one\n- two\n  - two.a\n\n3. three\n4. four");
	});

	it("renders pre blocks as fenced code with the language and inline code with backticks", () => {
		const { text } = htmlToText(
			'<p>Run <code>npm i</code>:</p><pre><code class="language-ts">const x = 1;\n  if (x &lt; 2) {}\n</code></pre>',
		);
		expect(text).toBe("Run `npm i`:\n\n```ts\nconst x = 1;\n  if (x < 2) {}\n```");
	});

	it("strips script, style, nav, footer, hidden and comments", () => {
		const { text } = htmlToText(
			"<body><nav><a href='/'>Home</a></nav><script>var a = '<p>no</p>';</script><style>p{}</style><!-- c --><p>Body</p><div hidden>secret</div><footer>(c) me</footer></body>",
		);
		expect(text).toBe("Body");
	});

	it("renders tables as rows with a header separator", () => {
		const { text } = htmlToText(
			"<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1 | 2</td></tr><tr><td>b<td>3</tr></tbody></table>",
		);
		expect(text).toBe("| Name | Value |\n| --- | --- |\n| a | 1 \\| 2 |\n| b | 3 |");
	});

	it("handles br, blockquote and implied paragraph ends", () => {
		const { text } = htmlToText("<p>line one<br>line two<p>next<blockquote><p>quoted</p></blockquote>");
		expect(text).toBe("line one\nline two\n\nnext\n\n> quoted");
	});
	it("prefers <main> content and drops chrome roles, classes and language lists", () => {
		const filler = "Article body sentence. ".repeat(12).trim();
		const { text } = htmlToText(
			`<body><div role="banner">Site</div><a class="skip-link" href="#c">Skip</a><main><h1>Title</h1><span class="sr-only">Jump</span><ul><li><a hreflang="de" href="/de">Deutsch</a><li><a hreflang="fr" href="/fr">Français</a><li><a hreflang="es" href="/es">Español</a></ul><p>${filler}</p><div class="post-header">Kept</div></main><aside>Related</aside></body>`,
		);
		expect(text).toBe(`# Title\n\n${filler}\n\nKept`);
	});

	it("falls back to the body when <main> is an empty app shell", () => {
		const { text } = htmlToText("<body><main><div id=app></div></main><p>Outside text</p></body>");
		expect(text).toBe("Outside text");
	});
});

describe("decodeEntities", () => {
	it("decodes named and numeric references and leaves unknown ones", () => {
		expect(decodeEntities("&lt;a&gt; &#65;&#x42; &mdash; &bogus; &nbsp;x")).toBe("<a> AB — &bogus;  x");
	});
});
