package dev.tobor.app.ui.markdown

// Tiny, pure, total markdown parser for assistant chat messages.
//
// Supported: bold (double star/underscore), italic (single), `code`, [text](url) links and bare http(s) URLs;
// # ## ### headings, dash/star and "1." lists (one nesting level), fenced code blocks, paragraphs.
// Anything else - and any unclosed marker while a message is still streaming - stays literal text.
// Never throws and never drops content.
sealed interface MdBlock {
    data class Paragraph(val inlines: List<Inline>) : MdBlock
    data class Heading(val level: Int, val inlines: List<Inline>) : MdBlock

    /** [level] is 0 or 1 (one nesting level); [number] is the source number for ordered items. */
    data class ListItem(val ordered: Boolean, val number: Int, val level: Int, val inlines: List<Inline>) : MdBlock

    /** [closed] is false while the closing fence has not streamed in yet. */
    data class CodeBlock(val code: String, val lang: String, val closed: Boolean) : MdBlock
}

sealed interface Inline {
    data class Text(val text: String) : Inline
    data class Bold(val children: List<Inline>) : Inline
    data class Italic(val children: List<Inline>) : Inline
    data class Code(val text: String) : Inline
    data class Link(val children: List<Inline>, val url: String) : Inline
}

private val HEADING = Regex("""^ {0,3}(#{1,3})[ \t]+(\S.*)$""")
private val LIST_ITEM = Regex("""^([ \t]*)(?:([-*])|(\d{1,9})\.)[ \t]+(.*)$""")
private const val MAX_INLINE_DEPTH = 6

fun parseMarkdown(src: String): List<MdBlock> {
    val lines = src.replace("\r\n", "\n").replace('\r', '\n').split('\n')
    val out = mutableListOf<MdBlock>()

    // Pending paragraph or list item; continuation lines are appended until a block boundary.
    var pendingItem: MdBlock.ListItem? = null
    val pendingLines = mutableListOf<String>()
    var pendingIsPara = false

    fun flush() {
        if (pendingLines.isNotEmpty()) {
            val text = pendingLines.joinToString("\n")
            val item = pendingItem
            out += when {
                item != null -> item.copy(inlines = parseInline(text))
                pendingIsPara -> MdBlock.Paragraph(parseInline(text))
                else -> MdBlock.Paragraph(listOf(Inline.Text(text)))
            }
        }
        pendingLines.clear()
        pendingItem = null
        pendingIsPara = false
    }

    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()

        if (trimmed.startsWith("```") && !trimmed.substring(3).contains("```")) {
            flush()
            val lang = trimmed.substring(3).trim()
            val code = mutableListOf<String>()
            var closed = false
            i++
            while (i < lines.size) {
                val l = lines[i].trim()
                if (l.length >= 3 && l.all { it == '`' }) {
                    closed = true
                    break
                }
                code += lines[i]
                i++
            }
            out += MdBlock.CodeBlock(code.joinToString("\n"), lang, closed)
            i++
            continue
        }

        if (trimmed.isEmpty()) {
            flush()
            i++
            continue
        }

        val heading = HEADING.matchEntire(line)
        if (heading != null) {
            flush()
            out += MdBlock.Heading(heading.groupValues[1].length, parseInline(heading.groupValues[2].trim()))
            i++
            continue
        }

        val li = LIST_ITEM.matchEntire(line)
        if (li != null) {
            flush()
            val indent = li.groupValues[1].fold(0) { n, ch -> n + if (ch == '\t') 4 else 1 }
            val ordered = li.groupValues[3].isNotEmpty()
            val number = li.groupValues[3].toIntOrNull() ?: 0
            pendingItem = MdBlock.ListItem(ordered, number, if (indent >= 2) 1 else 0, emptyList())
            pendingLines += li.groupValues[4].trim()
            i++
            continue
        }

        // Plain text: continues the current item/paragraph, or starts a paragraph.
        if (pendingLines.isEmpty()) pendingIsPara = true
        pendingLines += trimmed
        i++
    }
    flush()
    return out
}

fun parseInline(s: String): List<Inline> = parseInlineRec(s, 0, true)

private class Parsed(val node: Inline, val next: Int)

private fun parseInlineRec(s: String, depth: Int, allowLinks: Boolean): List<Inline> {
    if (s.isEmpty()) return emptyList()
    if (depth > MAX_INLINE_DEPTH) return listOf(Inline.Text(s))
    val out = mutableListOf<Inline>()
    val sb = StringBuilder()
    fun flush() {
        if (sb.isNotEmpty()) {
            out += Inline.Text(sb.toString())
            sb.setLength(0)
        }
    }

    var i = 0
    while (i < s.length) {
        val c = s[i]
        val parsed: Parsed? = when (c) {
            '`' -> tryCode(s, i)
            '[' -> if (allowLinks) tryLink(s, i, depth) else null
            'h', 'H' -> if (allowLinks) tryBareUrl(s, i) else null
            '*', '_' -> if (s.startsWith("$c$c", i)) tryBold(s, i, depth, allowLinks) else tryItalic(s, i, depth, allowLinks)
            else -> null
        }
        if (parsed != null) {
            flush()
            out += parsed.node
            i = parsed.next
        } else {
            // Unmatched marker: emit the whole run literally so it is not re-tried as a nested opener.
            val run = if (c == '`' || c == '*' || c == '_') runLength(s, i) else 1
            sb.append(s, i, i + run)
            i += run
        }
    }
    flush()
    return out
}

private fun runLength(s: String, i: Int): Int {
    var j = i
    while (j < s.length && s[j] == s[i]) j++
    return j - i
}

private fun tryCode(s: String, i: Int): Parsed? {
    val n = runLength(s, i)
    var j = i + n
    while (j < s.length) {
        if (s[j] == '`') {
            val m = runLength(s, j)
            if (m == n) {
                val content = s.substring(i + n, j)
                return if (content.isEmpty()) null else Parsed(Inline.Code(content), j + m)
            }
            j += m
        } else {
            j++
        }
    }
    return null
}

/** Index just past a code span starting at [j] (which must be a backtick), or j+1 when unclosed. */
private fun skipCode(s: String, j: Int): Int = tryCode(s, j)?.next ?: (j + runLength(s, j))

private fun isWord(c: Char) = c.isLetterOrDigit()

private fun tryBold(s: String, i: Int, depth: Int, allowLinks: Boolean): Parsed? {
    val c = s[i]
    val delim = "$c$c"
    if (c == '_' && i > 0 && isWord(s[i - 1])) return null
    val start = i + 2
    if (start >= s.length || s[start].isWhitespace()) return null
    var j = start
    while (j < s.length) {
        when {
            s[j] == '`' -> j = skipCode(s, j)
            s.startsWith(delim, j) -> {
                var k = j // closer is the last two chars of a longer run (***x***)
                while (k + 2 < s.length && s[k + 2] == c) k++
                val after = k + 2
                val ok = j > start && !s[j - 1].isWhitespace() &&
                    !(c == '_' && after < s.length && isWord(s[after]))
                if (ok) {
                    val inner = parseInlineRec(s.substring(start, k), depth + 1, allowLinks)
                    return Parsed(Inline.Bold(inner), after)
                }
                j = k + 2
            }
            else -> j++
        }
    }
    return null
}

private fun tryItalic(s: String, i: Int, depth: Int, allowLinks: Boolean): Parsed? {
    val c = s[i]
    if (c == '_' && i > 0 && isWord(s[i - 1])) return null
    val start = i + 1
    if (start >= s.length || s[start].isWhitespace() || s[start] == c) return null
    var j = start
    while (j < s.length) {
        when {
            s[j] == '`' -> j = skipCode(s, j)
            s[j] == c -> {
                val run = runLength(s, j)
                if (run == 1) {
                    val after = j + 1
                    val ok = j > start && !s[j - 1].isWhitespace() &&
                        !(c == '_' && after < s.length && isWord(s[after]))
                    if (ok) {
                        val inner = parseInlineRec(s.substring(start, j), depth + 1, allowLinks)
                        return Parsed(Inline.Italic(inner), after)
                    }
                }
                j += run
            }
            else -> j++
        }
    }
    return null
}

private fun tryLink(s: String, i: Int, depth: Int): Parsed? {
    var j = i + 1
    var level = 1
    while (j < s.length) {
        if (s[j] == '[') level++
        else if (s[j] == ']' && --level == 0) break
        j++
    }
    if (j >= s.length || j + 1 >= s.length || s[j + 1] != '(') return null
    val label = s.substring(i + 1, j)
    var k = j + 2
    level = 1
    while (k < s.length) {
        if (s[k] == '(') level++
        else if (s[k] == ')' && --level == 0) break
        k++
    }
    if (k >= s.length) return null
    val url = s.substring(j + 2, k).trim()
    if (label.isBlank() || !isSafeUrl(url)) return null
    return Parsed(Inline.Link(parseInlineRec(label, depth + 1, false), url), k + 1)
}

/** Characters trimmed from the end of a bare URL (sentence punctuation, closing paren, quotes). */
private const val URL_TRAILING = ").,;:!?'\""

/**
 * Trims trailing punctuation from a candidate bare URL. Returns null when no usable URL
 * (scheme plus at least one more character) remains.
 */
internal fun trimBareUrl(candidate: String): String? {
    val url = candidate.trimEnd { it in URL_TRAILING }
    val schemeEnd = url.indexOf("://")
    if (schemeEnd < 0 || url.length <= schemeEnd + 3) return null
    return url
}

/** Bare http(s) URL at [i]: needs a non-alphanumeric char (or text start) before it; runs to whitespace. */
private fun tryBareUrl(s: String, i: Int): Parsed? {
    if (i > 0 && s[i - 1].isLetterOrDigit()) return null
    if (!s.regionMatches(i, "http://", 0, 7, ignoreCase = true) &&
        !s.regionMatches(i, "https://", 0, 8, ignoreCase = true)
    ) return null
    var end = i
    while (end < s.length && !s[end].isWhitespace()) end++
    val url = trimBareUrl(s.substring(i, end)) ?: return null
    return Parsed(Inline.Link(listOf(Inline.Text(url)), url), i + url.length)
}

private fun isSafeUrl(url: String): Boolean {
    if (url.isEmpty() || url.any { it.isWhitespace() }) return false
    val lower = url.lowercase()
    return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")
}
