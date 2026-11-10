package dev.tobor.app.ui.screens.session

import dev.tobor.app.api.toborJson
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QueuedItemsTest {
    private fun docs(json: String): JsonObject = toborJson.parseToJsonElement(json) as JsonObject

    @Test fun keepsSteerAndFollowUpWithStringAndPartsContent() {
        val d = docs(
            """{"pi.inbox":{"items":[
                {"id":"a","mode":"steer","content":"hello"},
                {"id":"b","mode":"followUp","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}
            ]}}""",
        )
        assertEquals(
            listOf(Item.Queued("q:a", "steer", "hello"), Item.Queued("q:b", "followUp", "one\ntwo")),
            queuedItems(d),
        )
    }

    @Test fun dropsWriteItems() {
        val d = docs("""{"pi.inbox":{"items":[{"id":"w","mode":"write","content":"x"},{"id":"s","mode":"steer","content":"y"}]}}""")
        assertEquals(listOf(Item.Queued("q:s", "steer", "y")), queuedItems(d))
    }

    @Test fun skipsItemsWithoutStringId() {
        val d = docs("""{"pi.inbox":{"items":[{"mode":"steer","content":"x"},{"id":null,"mode":"followUp","content":"y"},{"id":"ok","mode":"steer","content":"z"}]}}""")
        assertEquals(listOf(Item.Queued("q:ok", "steer", "z")), queuedItems(d))
    }

    @Test fun absentOrNullInboxIsEmpty() {
        assertTrue(queuedItems(null).isEmpty())
        assertTrue(queuedItems(docs("{}")).isEmpty())
        assertTrue(queuedItems(docs("""{"pi.inbox":null}""")).isEmpty())
        assertTrue(queuedItems(docs("""{"pi.inbox":{}}""")).isEmpty())
    }
}
