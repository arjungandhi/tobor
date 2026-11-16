package dev.tobor.app.api

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class BearerTokenTest {
    /** Minimal one-response-per-connection HTTP server on a raw socket; records each request's Authorization header. */
    private fun withServer(status: Int, block: (port: Int, seen: List<String?>) -> Unit) {
        val seen = CopyOnWriteArrayList<String?>()
        val server = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val thread = thread(isDaemon = true) {
            while (!server.isClosed) {
                try {
                    server.accept().use { sock ->
                        val reader = sock.getInputStream().bufferedReader()
                        var auth: String? = null
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            if (line.startsWith("Authorization:", ignoreCase = true)) auth = line.substringAfter(':').trim()
                        }
                        seen += auth
                        sock.getOutputStream().write(
                            "HTTP/1.1 $status X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".toByteArray(),
                        )
                    }
                } catch (_: Exception) {
                    // socket closed
                }
            }
        }
        try {
            block(server.localPort, seen)
        } finally {
            server.close()
            thread.join(2000)
        }
    }

    private fun ToborApi.callQuietly() = runBlocking { runCatching { whoami() } }

    @Test
    fun sendsBearerHeaderToConfiguredNode() = withServer(200) { port, seen ->
        ToborApi("http://127.0.0.1:$port", "abc123").callQuietly()
        assertEquals(listOf<String?>("Bearer abc123"), seen)
    }

    @Test
    fun noHeaderWithoutToken() = withServer(200) { port, seen ->
        ToborApi("http://127.0.0.1:$port").callQuietly()
        assertEquals(listOf<String?>(null), seen)
    }

    @Test
    fun neverSentToAnotherHost() = withServer(200) { port, seen ->
        // Token is configured for a different host than the one the request goes to.
        val api = ToborApi("http://127.0.0.1:$port", "abc123")
        val other = okhttp3.Request.Builder().url("http://localhost:$port/api/whoami").build()
        api.wsClient.newCall(other).execute().close()
        assertEquals(listOf<String?>(null), seen)
    }

    @Test
    fun unauthorizedRaisesPromptOnceUntilDismissed() = withServer(401) { port, _ ->
        val api = ToborApi("http://127.0.0.1:$port")
        assertFalse(api.authRequired.value)
        api.callQuietly()
        assertTrue(api.authRequired.value)
        api.dismissAuthPrompt()
        api.callQuietly()
        assertFalse(api.authRequired.value)
        api.token = "x"
        api.callQuietly()
        assertTrue(api.authRequired.value)
    }

    @Test
    fun tokenIsReducedToVisibleAscii() {
        assertEquals("abc-1.2_3", ToborApi.normalizeToken(" abc-1.2_3\n"))
    }
}
