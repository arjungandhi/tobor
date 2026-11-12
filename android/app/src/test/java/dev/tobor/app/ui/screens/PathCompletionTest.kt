package dev.tobor.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PathCompletionTest {
    @Test fun triggersAtStartAndAfterWhitespace() {
        assertEquals(0, typedAtTrigger("", "@", 1))
        assertEquals(4, typedAtTrigger("see ", "see @", 5))
        assertEquals(4, typedAtTrigger("see\n", "see\n@", 5))
        assertEquals(2, typedAtTrigger("a b", "a @b", 3))
    }

    @Test fun noTriggerMidWordOrForOtherEdits() {
        assertNull(typedAtTrigger("foo", "foo@", 4))
        assertNull(typedAtTrigger("a@", "a@@", 3))
        assertNull(typedAtTrigger("", "x", 1))
        assertNull(typedAtTrigger("abc", "@", 1)) // deletion/replacement, not a single insert
        assertNull(typedAtTrigger("", "@", 0)) // cursor not after the @
        assertNull(typedAtTrigger("ab", "a@c", 2)) // paste/replace, old text not preserved
    }

    @Test fun findsAtTokenEndingAtCursor() {
        assertEquals(0, findAtToken("@", 1))
        assertEquals(4, findAtToken("see @src/ma", 11))
        assertNull(findAtToken("see src", 7))
        assertNull(findAtToken("foo@bar", 7))
        assertNull(findAtToken("@ ", 2))
    }

    @Test fun replacesTokenAndPlacesCursor() {
        assertEquals(TextAndCursor("src/", 4), replaceAtToken("@", 1, "src/"))
        assertEquals(TextAndCursor("see src/a.kt", 12), replaceAtToken("see @", 5, "src/a.kt"))
        // text after the cursor is preserved
        assertEquals(TextAndCursor("see ~/x/ now", 8), replaceAtToken("see @ now", 5, "~/x/"))
        assertEquals(TextAndCursor("a\nb.txt", 7), replaceAtToken("a\n@", 3, "b.txt"))
    }

    @Test fun insertsAtCursorWithoutToken() {
        assertEquals(TextAndCursor("abXc", 3), replaceAtToken("abc", 2, "X"))
    }

    @Test fun splitsPrefix() {
        assertEquals("" to "", splitPrefix(""))
        assertEquals("" to "sr", splitPrefix("sr"))
        assertEquals("src/" to "ma", splitPrefix("src/ma"))
        assertEquals("src/" to "", splitPrefix("src/"))
        assertEquals("/etc/" to "h", splitPrefix("/etc/h"))
        assertEquals("~/" to "", splitPrefix("~/"))
    }

    @Test fun computesParentPrefix() {
        assertNull(parentPrefix(""))
        assertNull(parentPrefix("sr"))
        assertEquals("", parentPrefix("src/"))
        assertEquals("", parentPrefix("src/ma"))
        assertEquals("src/", parentPrefix("src/main/"))
        assertEquals("/", parentPrefix("/etc/"))
        assertEquals("/etc/", parentPrefix("/etc/x/y"))
        assertNull(parentPrefix("/"))
        assertNull(parentPrefix("~/"))
        assertEquals("~/", parentPrefix("~/src/"))
        assertEquals("../", parentPrefix("./"))
        assertEquals("../../", parentPrefix("../"))
        assertEquals("a/", parentPrefix("a/b/"))
    }

    @Test fun buildsDescendAndEntryPaths() {
        assertEquals("src/", descendPrefix("", "src"))
        assertEquals("src/main/", descendPrefix("src/ma", "main"))
        assertEquals("~/code/", descendPrefix("~/", "code"))
        assertEquals("src/main/", entryPath("src/ma", "main", isDir = true))
        assertEquals("src/a.kt", entryPath("src/a", "a.kt", isDir = false))
        assertEquals("a.kt", entryPath("", "a.kt", isDir = false))
    }
}
