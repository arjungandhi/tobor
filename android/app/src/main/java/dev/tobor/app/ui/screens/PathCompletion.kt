package dev.tobor.app.ui.screens

/** Pure helpers for `@` path completion in the composer; no Compose or Android types so they run in plain JVM tests. */

/** A draft after an edit: the new [text] and the [cursor] offset into it. */
data class TextAndCursor(val text: String, val cursor: Int)

/**
 * Index of the `@` that was just typed, or null. True only when [newText] is [oldText] with exactly one `@` inserted
 * ending at [newCursor], and that `@` sits at a token boundary (start of text, or after whitespace/newline).
 */
fun typedAtTrigger(oldText: String, newText: String, newCursor: Int): Int? {
    if (newText.length != oldText.length + 1) return null
    val at = newCursor - 1
    if (at < 0 || at >= newText.length || newText[at] != '@') return null
    if (newText.removeRange(at, at + 1) != oldText) return null
    if (at > 0 && !newText[at - 1].isWhitespace()) return null
    return at
}

/** Start of the `@…` token that ends at [cursor] (the run of non-whitespace before the cursor must begin with `@`), else null. */
fun findAtToken(text: String, cursor: Int): Int? {
    val end = cursor.coerceIn(0, text.length)
    var start = end
    while (start > 0 && !text[start - 1].isWhitespace()) start--
    return if (start < end && text[start] == '@') start else null
}

/**
 * Replaces the `@` token ending at [cursor] (from the `@` to the cursor) with `@` + [path], so the `@` stays as a
 * mention marker, and puts the cursor right after the inserted text. With no `@` token before the cursor, [path] is
 * inserted at the cursor as is.
 */
fun replaceAtToken(text: String, cursor: Int, path: String): TextAndCursor {
    val end = cursor.coerceIn(0, text.length)
    val at = findAtToken(text, end)
    val start = at ?: end
    val inserted = if (at != null) "@$path" else path
    return TextAndCursor(text.substring(0, start) + inserted + text.substring(end), start + inserted.length)
}

/** Splits a raw prefix at its last `/`: the directory part (with trailing slash, possibly empty) and the base being typed. */
fun splitPrefix(prefix: String): Pair<String, String> {
    val i = prefix.lastIndexOf('/')
    return if (i < 0) "" to prefix else prefix.substring(0, i + 1) to prefix.substring(i + 1)
}

/**
 * Prefix one level above the directory part of [prefix] (what a `..` row navigates to), or null when there is no
 * directory part or it cannot go further up (`/`, `~/`).
 */
fun parentPrefix(prefix: String): String? {
    val dir = splitPrefix(prefix).first
    if (dir.isEmpty()) return null
    val trimmed = dir.removeSuffix("/")
    if (trimmed.isEmpty() || trimmed == "~") return null
    val slash = trimmed.lastIndexOf('/')
    val last = trimmed.substring(slash + 1)
    return when (last) {
        "." -> trimmed.substring(0, slash + 1) + "../"
        ".." -> dir + "../"
        else -> trimmed.substring(0, slash + 1)
    }
}

/** Prefix after descending into directory [name] from [prefix]. */
fun descendPrefix(prefix: String, name: String): String = splitPrefix(prefix).first + name + "/"

/** Path to insert for an entry exactly as navigated; directories keep a trailing slash. */
fun entryPath(prefix: String, name: String, isDir: Boolean): String =
    splitPrefix(prefix).first + name + if (isDir) "/" else ""
