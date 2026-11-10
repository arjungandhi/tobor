package dev.tobor.app.api

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** What a frame handler wants the loop to do next. */
internal enum class SocketAction {
    /** Keep reading. */
    CONTINUE,

    /** Protocol/state problem: close this socket and reconnect (fresh snapshot). */
    RESYNC,

    /** Server ended the stream; reconnect after a growing delay. */
    END,

    /** Server ended the stream for good; stop reconnecting. */
    END_FINAL,
}

internal interface SocketListener {
    fun onConnecting()
    fun onOpen()

    /** A socket attempt finished (failed, closed, or ended) and none is connected now. */
    fun onDown()

    /** The loop was stopped or its scope cancelled. */
    fun onStopped()

    /** Called for every frame except `pong`. May throw: treated as [SocketAction.RESYNC]. */
    fun onFrame(frame: JsonObject): SocketAction
}

/**
 * One reconnecting WebSocket: exponential backoff 1s..30s, `{"t":"ping"}` every 25s while open, `pong` swallowed.
 * Sockets are always opened without an Origin header (OkHttp adds none).
 */
internal class SocketLoop(
    private val api: ToborApi,
    private val scope: CoroutineScope,
    private val urlProvider: () -> String,
    private val listener: SocketListener,
) {
    private var job: Job? = null

    @Volatile
    private var stopped = false

    @Volatile
    private var socket: WebSocket? = null

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        stopped = false
        job = scope.launch { loop() }
    }

    @Synchronized
    fun stop() {
        stopped = true
        job?.cancel()
        job = null
        socket?.close(1000, "stop")
        socket = null
        listener.onStopped()
    }

    private enum class Outcome { FAILED, CLOSED, RESYNC, END, END_FINAL }

    private class Result(val outcome: Outcome, val opened: Boolean)

    private suspend fun loop() {
        var failDelay = INITIAL_DELAY_MS
        var endDelay = INITIAL_DELAY_MS
        try {
            while (currentCoroutineContext().isActive && !stopped) {
                listener.onConnecting()
                val result = connectOnce()
                listener.onDown()
                val wait: Long
                when (result.outcome) {
                    Outcome.END_FINAL -> return
                    Outcome.END -> {
                        wait = endDelay
                        endDelay = (endDelay * 2).coerceAtMost(MAX_DELAY_MS)
                    }
                    Outcome.RESYNC -> {
                        wait = INITIAL_DELAY_MS
                    }
                    Outcome.FAILED, Outcome.CLOSED -> {
                        if (result.opened) failDelay = INITIAL_DELAY_MS
                        wait = failDelay
                        failDelay = (failDelay * 2).coerceAtMost(MAX_DELAY_MS)
                        endDelay = INITIAL_DELAY_MS
                    }
                }
                delay(wait)
            }
        } finally {
            listener.onStopped()
        }
    }

    private suspend fun connectOnce(): Result = coroutineScope {
        val done = CompletableDeferred<Outcome>()
        var opened = false
        val ws = api.openSocket(urlProvider(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened = true
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (done.isCompleted) return
                val frame = try {
                    toborJson.parseToJsonElement(text).jsonObject
                } catch (_: Exception) {
                    return // malformed frame: ignore
                }
                val t = (frame["t"] as? JsonPrimitive)?.contentOrNull
                if (t == "pong") return
                val action = try {
                    listener.onFrame(frame)
                } catch (_: Exception) {
                    SocketAction.RESYNC
                }
                when (action) {
                    SocketAction.CONTINUE -> Unit
                    SocketAction.RESYNC -> done.complete(Outcome.RESYNC)
                    SocketAction.END -> done.complete(Outcome.END)
                    SocketAction.END_FINAL -> done.complete(Outcome.END_FINAL)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                done.complete(Outcome.CLOSED)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                done.complete(Outcome.FAILED)
            }
        })
        socket = ws
        val pinger = launch {
            while (true) {
                delay(PING_INTERVAL_MS)
                ws.send("""{"t":"ping"}""")
            }
        }
        try {
            Result(done.await(), opened)
        } catch (e: CancellationException) {
            throw e
        } finally {
            pinger.cancel()
            if (!ws.close(1000, "bye")) ws.cancel()
            if (socket === ws) socket = null
        }
    }

    companion object {
        const val INITIAL_DELAY_MS = 1_000L
        const val MAX_DELAY_MS = 30_000L
        const val PING_INTERVAL_MS = 25_000L
    }
}
