package dev.tobor.app.api

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * `ws://…/api/events`. [events] emits the inner `event` object of each `{t:"event"}` frame (`type` is
 * session.state, session.updated, approval.requested, …). The stream is lossy, so refetch lists whenever [connected]
 * turns true (including the first time).
 */
class EventsClient(
    private val api: ToborApi,
    scope: CoroutineScope,
) {
    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<JsonObject> = _events.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val loop = SocketLoop(
        api, scope,
        urlProvider = { api.wsUrl("/api/events") },
        listener = object : SocketListener {
            override fun onConnecting() = Unit
            override fun onOpen() {
                _connected.value = true
            }

            override fun onDown() {
                _connected.value = false
            }

            override fun onStopped() {
                _connected.value = false
            }

            override fun onFrame(frame: JsonObject): SocketAction {
                if ((frame["t"] as? JsonPrimitive)?.contentOrNull == "event") {
                    (frame["event"] as? JsonObject)?.let { _events.tryEmit(it) }
                }
                return SocketAction.CONTINUE
            }
        },
    )

    /** Open the socket (idempotent). */
    fun start() = loop.start()

    /** Close cleanly and stop reconnecting. */
    fun stop() = loop.stop()
}
