package dev.tobor.app.api

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

sealed interface WatchStatus {
    data object Connecting : WatchStatus
    data object Open : WatchStatus
    data class Ended(val reason: String) : WatchStatus
    data object Closed : WatchStatus
}

/**
 * Live replica of one session's ConversationView over `ws://…/api/sessions/<id>/watch`.
 *
 * [view] is the current ConversationView (`{conversation, entries, before?, docs}`) or null before the first
 * snapshot. A snapshot replaces it; `ops` frames are applied with [ChordDelta]; if applying fails the socket is
 * closed and reopened to obtain a fresh snapshot. The old [view] is kept while reconnecting.
 */
class WatchClient(
    private val api: ToborApi,
    private val conversationId: Long,
    scope: CoroutineScope,
) {
    private val _view = MutableStateFlow<JsonObject?>(null)
    val view: StateFlow<JsonObject?> = _view.asStateFlow()

    private val _status = MutableStateFlow<WatchStatus>(WatchStatus.Closed)
    val status: StateFlow<WatchStatus> = _status.asStateFlow()

    private val loop = SocketLoop(
        api, scope,
        urlProvider = { api.wsUrl("/api/sessions/$conversationId/watch") },
        listener = object : SocketListener {
            override fun onConnecting() {
                _status.value = WatchStatus.Connecting
            }

            override fun onOpen() {
                _status.value = WatchStatus.Open
            }

            override fun onDown() {
                if (_status.value !is WatchStatus.Ended) _status.value = WatchStatus.Closed
            }

            override fun onStopped() {
                _status.value = WatchStatus.Closed
            }

            override fun onFrame(frame: JsonObject): SocketAction {
                when ((frame["t"] as? JsonPrimitive)?.contentOrNull) {
                    "snapshot" -> {
                        val value = frame["value"] as? JsonObject ?: return SocketAction.RESYNC
                        _view.value = value
                    }
                    "ops" -> {
                        val ops = frame["ops"] as? JsonArray ?: return SocketAction.RESYNC
                        val next = ChordDelta.apply(_view.value, ops) as? JsonObject ?: return SocketAction.RESYNC
                        _view.value = next
                    }
                    "end" -> {
                        val reason = (frame["reason"] as? JsonPrimitive)?.contentOrNull ?: ""
                        _status.value = WatchStatus.Ended(reason)
                        return if (reason == "not_found") SocketAction.END_FINAL else SocketAction.END
                    }
                }
                return SocketAction.CONTINUE
            }
        },
    )

    /** Open the socket (idempotent). */
    fun start() = loop.start()

    /** Close cleanly and stop reconnecting. [view] keeps its last value. */
    fun stop() = loop.stop()
}
