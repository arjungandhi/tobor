package dev.tobor.app.ui.markdown

import dev.tobor.app.ui.markdown.Inline.Bold
import dev.tobor.app.ui.markdown.Inline.Code
import dev.tobor.app.ui.markdown.Inline.Italic
import dev.tobor.app.ui.markdown.Inline.Link
import dev.tobor.app.ui.markdown.Inline.Text
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownParserTest {
    private fun t(s: String) = Text(s)

    // ---- inline ----

    @Test fun plainTextPassthrough() {
        assertEquals(listOf(t("hello world, 1 + 1 = 2.")), parseInline("hello world, 1 + 1 = 2."))
    }

    @Test fun bold() {
        assertEquals(listOf(t("a "), Bold(listOf(t("b"))), t(" c")), parseInline("a **b** c"))
        assertEquals(listOf(Bold(listOf(t("b")))), parseInline("__b__"))
    }

    @Test fun italic() {
        assertEquals(listOf(t("a "), Italic(listOf(t("b"))), t(" c")), parseInline("a *b* c"))
        assertEquals(listOf(Italic(listOf(t("b")))), parseInline("_b_"))
    }

    @Test fun boldItalicNesting() {
        assertEquals(listOf(Bold(listOf(Italic(listOf(t("x")))))), parseInline("***x***"))
        assertEquals(
            listOf(Bold(listOf(t("a "), Italic(listOf(t("b"))), t(" c")))),
            parseInline("**a *b* c**"),
        )
    }

    @Test fun inlineCode() {
        assertEquals(listOf(t("run "), Code("ls -la"), t(" now")), parseInline("run `ls -la` now"))
    }

    @Test fun codeSuppressesEmphasis() {
        assertEquals(listOf(Code("**not bold**")), parseInline("`**not bold**`"))
    }

    @Test fun doubleBacktickCode() {
        assertEquals(listOf(Code("a`b")), parseInline("``a`b``"))
    }

    @Test fun links() {
        assertEquals(
            listOf(t("see "), Link(listOf(t("docs")), "https://example.com/a_(b)"), t(".")),
            parseInline("see [docs](https://example.com/a_(b))."),
        )
    }

    @Test fun linkLabelCanBeStyled() {
        assertEquals(
            listOf(Link(listOf(Bold(listOf(t("x")))), "http://a.b")),
            parseInline("[**x**](http://a.b)"),
        )
    }

    @Test fun unsafeOrMalformedLinksStayLiteral() {
        assertEquals(listOf(t("[x](javascript:alert(1))")), parseInline("[x](javascript:alert(1))"))
        assertEquals(listOf(t("[x](")), parseInline("[x]("))
        // not a markdown link, but the bare URL inside is still autolinked
        assertEquals(listOf(t("[x] ("), bare("http://a.b"), t(")")), parseInline("[x] (http://a.b)"))
        assertEquals(listOf(t("[x](not a url)")), parseInline("[x](not a url)"))
    }

    @Test fun unclosedMarkersMidStreamStayLiteral() {
        assertEquals(listOf(t("a **bold")), parseInline("a **bold"))
        assertEquals(listOf(t("a *it")), parseInline("a *it"))
        assertEquals(listOf(t("a `code")), parseInline("a `code"))
        assertEquals(listOf(t("a [lin")), parseInline("a [lin"))
        // partial explicit link: the URL tail is autolinked until the construct closes
        assertEquals(listOf(t("a [link]("), bare("https://exa")), parseInline("a [link](https://exa"))
        assertEquals(listOf(t("__x")), parseInline("__x"))
    }

    @Test fun markersBecomeStyledOnceClosed() {
        assertEquals(listOf(t("a **bold")), parseInline("a **bold"))
        assertEquals(listOf(t("a "), Bold(listOf(t("bold")))), parseInline("a **bold**"))
        assertEquals(listOf(t("a "), Bold(listOf(t("bold"))), t(" *")), parseInline("a **bold** *"))
    }

    @Test fun nonEmphasisStarsAndUnderscores() {
        assertEquals(listOf(t("2 * 3 * 4")), parseInline("2 * 3 * 4"))
        assertEquals(listOf(t("snake_case_name and my_var")), parseInline("snake_case_name and my_var"))
        assertEquals(listOf(t("_private_thing")), parseInline("_private_thing"))
        assertEquals(listOf(t("**")), parseInline("**"))
        assertEquals(listOf(t("* _ * _")), parseInline("* _ * _"))
    }

    // ---- blocks ----

    @Test fun paragraphsSeparatedByBlankLines() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(t("one\ntwo"))), MdBlock.Paragraph(listOf(t("three")))),
            parseMarkdown("one\ntwo\n\n\nthree"),
        )
    }

    @Test fun headings() {
        assertEquals(
            listOf(
                MdBlock.Heading(1, listOf(t("A"))),
                MdBlock.Heading(2, listOf(t("B "), Bold(listOf(t("b"))))),
                MdBlock.Heading(3, listOf(t("C"))),
            ),
            parseMarkdown("# A\n## B **b**\n### C"),
        )
    }

    @Test fun unsupportedHeadingsStayLiteral() {
        assertEquals(listOf(MdBlock.Paragraph(listOf(t("#### deep")))), parseMarkdown("#### deep"))
        assertEquals(listOf(MdBlock.Paragraph(listOf(t("#nospace")))), parseMarkdown("#nospace"))
    }

    @Test fun unorderedAndOrderedLists() {
        assertEquals(
            listOf(
                MdBlock.ListItem(false, 0, 0, listOf(t("a"))),
                MdBlock.ListItem(false, 0, 0, listOf(Bold(listOf(t("b"))))),
                MdBlock.ListItem(true, 1, 0, listOf(t("x"))),
                MdBlock.ListItem(true, 2, 0, listOf(t("y"))),
            ),
            parseMarkdown("- a\n* **b**\n1. x\n2. y"),
        )
    }

    @Test fun nestedListOneLevel() {
        assertEquals(
            listOf(
                MdBlock.ListItem(false, 0, 0, listOf(t("a"))),
                MdBlock.ListItem(false, 0, 1, listOf(t("b"))),
                MdBlock.ListItem(true, 1, 1, listOf(t("c"))),
                MdBlock.ListItem(false, 0, 1, listOf(t("deep"))), // deeper nesting is clamped to level 1
            ),
            parseMarkdown("- a\n  - b\n  1. c\n      - deep"),
        )
    }

    @Test fun listContinuationLineJoinsItem() {
        assertEquals(
            listOf(MdBlock.ListItem(false, 0, 0, listOf(t("a\nmore")))),
            parseMarkdown("- a\n  more"),
        )
    }

    @Test fun boldAtLineStartIsNotAList() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(Bold(listOf(t("x"))), t(" y")))),
            parseMarkdown("**x** y"),
        )
        assertEquals(listOf(MdBlock.Paragraph(listOf(t("---")))), parseMarkdown("---"))
    }

    @Test fun fencedCodeBlockPreservesWhitespaceAndMarkdown() {
        assertEquals(
            listOf(
                MdBlock.Paragraph(listOf(t("before"))),
                MdBlock.CodeBlock("fun x() {\n    **not bold**\n\n# nope\n}", "kotlin", true),
                MdBlock.Paragraph(listOf(t("after"))),
            ),
            parseMarkdown("before\n```kotlin\nfun x() {\n    **not bold**\n\n# nope\n}\n```\nafter"),
        )
    }

    @Test fun unclosedFenceMidStreamIsBestEffortCodeBlock() {
        assertEquals(
            listOf(MdBlock.CodeBlock("a\n  b", "", false)),
            parseMarkdown("```\na\n  b"),
        )
        assertEquals(listOf(MdBlock.CodeBlock("", "", false)), parseMarkdown("```"))
    }

    @Test fun inlineTripleBacktickOnOneLineIsInlineCode() {
        assertEquals(listOf(MdBlock.Paragraph(listOf(Code("x")))), parseMarkdown("```x```"))
    }

    @Test fun unsupportedSyntaxIsKeptLiterally() {
        val src = "> quote\n| a | b |\n|---|---|\n~~gone~~\n<b>html</b>"
        assertEquals(listOf(MdBlock.Paragraph(listOf(t(src)))), parseMarkdown(src))
    }

    @Test fun crlfIsNormalised() {
        assertEquals(
            listOf(MdBlock.Heading(1, listOf(t("A"))), MdBlock.Paragraph(listOf(t("b")))),
            parseMarkdown("# A\r\n\r\nb"),
        )
    }

    @Test fun emptyAndWhitespaceInput() {
        assertEquals(emptyList<MdBlock>(), parseMarkdown(""))
        assertEquals(emptyList<MdBlock>(), parseMarkdown("  \n\n "))
    }

    // ---- bare URL autolinking ----

    private fun bare(url: String) = Link(listOf(t(url)), url)

    @Test fun bareUrlAlone() {
        assertEquals(listOf(bare("https://example.com")), parseInline("https://example.com"))
    }

    @Test fun bareUrlMidSentence() {
        assertEquals(
            listOf(t("open "), bare("http://a.b/x"), t(" now")),
            parseInline("open http://a.b/x now"),
        )
    }

    @Test fun bareUrlWithPortAndArtifactPath() {
        val u = "http://host:7880/art/proj_abc/slug"
        assertEquals(listOf(t("Published: "), bare(u)), parseInline("Published: $u"))
    }

    @Test fun bareUrlTrimsTrailingPunctuation() {
        assertEquals(listOf(t("see "), bare("https://a.b/x"), t(".")), parseInline("see https://a.b/x."))
        assertEquals(listOf(t("("), bare("https://a.b"), t("),")), parseInline("(https://a.b),"))
        assertEquals(listOf(bare("https://a.b/q"), t("?!")), parseInline("https://a.b/q?!"))
    }

    @Test fun bareUrlSchemeOnlyStaysText() {
        assertEquals(listOf(t("go to http:// later")), parseInline("go to http:// later"))
        assertEquals(listOf(t("https://.")), parseInline("https://."))
    }

    @Test fun bareUrlNeedsWordBoundary() {
        assertEquals(listOf(t("xhttp://a.b")), parseInline("xhttp://a.b"))
    }

    @Test fun bareUrlInsideInlineCodeStaysCode() {
        assertEquals(listOf(Code("http://a.b/x")), parseInline("`http://a.b/x`"))
    }

    @Test fun bareUrlInsideFencedBlockUntouched() {
        assertEquals(
            listOf(MdBlock.CodeBlock("curl http://a.b/x", "", true)),
            parseMarkdown("```\ncurl http://a.b/x\n```"),
        )
    }

    @Test fun explicitLinkIsNotDoubleLinked() {
        assertEquals(
            listOf(Link(listOf(t("http://a.b")), "http://a.b")),
            parseInline("[http://a.b](http://a.b)"),
        )
        assertEquals(
            listOf(Link(listOf(t("docs")), "https://a.b/d"), t(" and "), bare("https://c.d")),
            parseInline("[docs](https://a.b/d) and https://c.d"),
        )
    }

    @Test fun bareUrlInsideBoldAndList() {
        assertEquals(
            listOf(Bold(listOf(t("at "), bare("http://a.b")))),
            parseInline("**at http://a.b**"),
        )
        assertEquals(
            listOf(MdBlock.ListItem(false, 0, 0, listOf(bare("http://a.b/x")))),
            parseMarkdown("- http://a.b/x"),
        )
    }

    @Test fun bareUrlPrefixesNeverThrow() {
        val doc = "See http://host:7880/art/proj_abc/slug, `http://x.y` and [l](https://a.b) or (https://c.d/e).\n" +
            "```\nhttps://in.code\n```\n**bold https://b.c**"
        for (n in 0..doc.length) parseMarkdown(doc.substring(0, n))
    }

    @Test fun neverThrowsAndNeverDropsContentOnEveryPrefix() {
        val doc = "# Title\n\nSome **bold**, *it*, `code`, [l](https://a.b) and snake_case.\n" +
            "- item _one_\n  - sub\n1. first\n\n```kotlin\nval x = 1 * 2\n```\n**unclosed [x]( `"
        for (n in 0..doc.length) {
            val blocks = parseMarkdown(doc.substring(0, n))
            // all non-marker letters survive in order
            val got = blocks.joinToString("") { b ->
                when (b) {
                    is MdBlock.Paragraph -> flatten(b.inlines)
                    is MdBlock.Heading -> flatten(b.inlines)
                    is MdBlock.ListItem -> flatten(b.inlines)
                    is MdBlock.CodeBlock -> b.code
                }
            }.filter { it.isLetterOrDigit() }
            val want = doc.substring(0, n).filter { it.isLetterOrDigit() }
            // url text is consumed by links, so compare letters only for prefixes without a complete link
            if (!doc.substring(0, n).contains("](https://a.b)")) assertEquals("prefix $n", want, got)
        }
    }

    @Test fun pathologicalInputsDoNotThrow() {
        val inputs = listOf(
            "*".repeat(5000), "_".repeat(5000), "`".repeat(5000), "[".repeat(2000), "[](".repeat(500),
            "**a ".repeat(500), "*_`[".repeat(500), "\u0000\uFFFF", "(".repeat(3000), "#".repeat(100),
        )
        inputs.forEach { parseMarkdown(it) }
    }

    private fun flatten(inlines: List<Inline>): String = inlines.joinToString("") {
        when (it) {
            is Text -> it.text
            is Bold -> flatten(it.children)
            is Italic -> flatten(it.children)
            is Code -> it.text
            is Link -> flatten(it.children)
        }
    }
}
