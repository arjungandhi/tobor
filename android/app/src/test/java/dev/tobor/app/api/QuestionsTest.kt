package dev.tobor.app.api

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuestionsTest {
    @Test fun parsesPendingQuestions() {
        val raw = """[
            {"conversationId":7,"sessionId":3,"worker":"scout","callId":"c1","question":"Which db?",
             "options":["pg","sqlite"],"createdAt":100,"expiresAt":200,"extra":true},
            {"conversationId":3,"sessionId":3,"callId":"c2","question":"Name?","createdAt":1,"expiresAt":2}
        ]"""
        val qs = toborJson.decodeFromString(ListSerializer(PendingQuestion.serializer()), raw)
        assertEquals(2, qs.size)
        assertEquals(PendingQuestion(7, 3, "scout", "c1", "Which db?", listOf("pg", "sqlite"), 100, 200), qs[0])
        assertNull(qs[1].worker)
        assertNull(qs[1].options)
    }

    @Test fun answerRequestOmitsAbsentConversationId() {
        assertEquals("""{"answer":"pg"}""", toborJson.encodeToString(AnswerQuestionRequest("pg")))
        assertEquals(
            """{"answer":"pg","conversationId":7}""",
            toborJson.encodeToString(AnswerQuestionRequest("pg", 7)),
        )
    }
}
