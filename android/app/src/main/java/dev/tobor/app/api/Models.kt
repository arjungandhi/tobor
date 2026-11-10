package dev.tobor.app.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Shared JSON configuration. Tolerant on input (unknown keys ignored, `null` for a non-null defaulted field falls back
 * to the default), compact on output (nulls and defaults are omitted so optional request fields are simply absent).
 */
val toborJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

@Serializable
data class ChromeInfo(
    val found: Boolean = false,
    val version: String? = null,
)

@Serializable
data class Whoami(
    val host: String = "",
    val version: String = "",
    val build: String = "",
    @SerialName("pi_durable") val piDurable: String = "",
    val runtime: String = "",
    @SerialName("public_url") val publicUrl: String = "",
    @SerialName("artifacts_url") val artifactsUrl: String = "",
    @SerialName("ntfy_topic") val ntfyTopic: String? = null,
    val chrome: ChromeInfo = ChromeInfo(),
    val now: Long = 0,
)

@Serializable
data class Usage(
    val input: Long = 0,
    val output: Long = 0,
    val cacheRead: Long = 0,
    val cacheWrite: Long = 0,
    val totalTokens: Long = 0,
    val cost: Double = 0.0,
)

@Serializable
data class Failure(
    val reason: String = "",
    val detail: String? = null,
)

/** `state`: idle | running | waiting | failed. `approvalMode`: ask | auto. `mode`: director | solo. `kind`: session | schedule. */
@Serializable
data class SessionSummary(
    val id: Long,
    val title: String = "",
    val cwd: String = "",
    val model: String = "",
    @SerialName("approval_mode") val approvalMode: String = "ask",
    val mode: String = "director",
    val kind: String = "session",
    val scheduleId: String? = null,
    val state: String = "idle",
    val failure: Failure? = null,
    val pending: Int = 0,
    val usage: Usage = Usage(),
    val archived: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class SessionDetail(
    val id: Long,
    val title: String = "",
    val cwd: String = "",
    val model: String = "",
    @SerialName("approval_mode") val approvalMode: String = "ask",
    val mode: String = "director",
    val kind: String = "session",
    val scheduleId: String? = null,
    val state: String = "idle",
    val failure: Failure? = null,
    val pending: Int = 0,
    val usage: Usage = Usage(),
    val archived: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val thinking: String = "",
    @SerialName("max_turns") val maxTurns: Int = 0,
    val workers: Int = 0,
) {
    fun toSummary(): SessionSummary = SessionSummary(
        id, title, cwd, model, approvalMode, mode, kind, scheduleId, state, failure, pending, usage, archived,
        createdAt, updatedAt,
    )
}

@Serializable
data class CreateSessionRequest(
    val cwd: String,
    val prompt: String,
    val model: String? = null,
    val thinking: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    val mode: String? = null,
)

@Serializable
data class CreateSessionResponse(val id: Long)

@Serializable
data class PatchSessionRequest(
    val title: String? = null,
    val model: String? = null,
    val thinking: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    val mode: String? = null,
    val archived: Boolean? = null,
)

@Serializable
data class InputRequest(
    val content: String,
    val mode: String,
    val requestId: String,
)

@Serializable
data class InputResponse(val submissionId: Long = 0)

@Serializable
data class DecideRequest(
    val decision: String,
    val conversationId: Long? = null,
)

/**
 * One transcript entry. `kind`: pi.user | pi.assistant | pi.system | pi.tool-result | pi.reset | pi.compaction.
 * [model] (the pi messages) and [data] are kept raw; the UI parses them.
 */
@Serializable
data class EntryRecord(
    val id: Long,
    val conversationId: Long = 0,
    val kind: String = "",
    val model: List<JsonElement>? = null,
    val data: JsonElement? = null,
)

@Serializable
data class EntriesResponse(
    val items: List<EntryRecord> = emptyList(),
    val more: Boolean = false,
)

/** `state`: starting | running | done | failed | aborted. */
@Serializable
data class WorkerSummary(
    val id: String,
    val name: String = "",
    val agent: String = "",
    val state: String = "running",
    val usage: Usage = Usage(),
    val lastText: String = "",
    val createdAt: Long = 0,
    val conversationId: Long? = null,
    val finishedAt: Long? = null,
)

@Serializable
data class PendingApproval(
    val conversationId: Long = 0,
    val sessionId: Long = 0,
    val worker: String? = null,
    val callId: String,
    val tool: String = "",
    val args: JsonElement,
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
)

/** An `ask_user` question the agent is waiting on (`GET /api/questions`). [options] are suggestions; free text is always allowed. */
@Serializable
data class PendingQuestion(
    val conversationId: Long = 0,
    val sessionId: Long = 0,
    val worker: String? = null,
    val callId: String,
    val question: String = "",
    val options: List<String>? = null,
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
)

@Serializable
data class AnswerQuestionRequest(
    val answer: String,
    val conversationId: Long? = null,
)

@Serializable
data class CwdsResponse(
    val roots: List<String> = emptyList(),
    val recent: List<String> = emptyList(),
)

/** `status`: running | done | failed | skipped_misfire | skipped_overlap. [notice] is the reason for skips or failures. */
@Serializable
data class ScheduleRun(
    val fireAt: Long = 0,
    val conversationId: Long? = null,
    val submissionId: Long? = null,
    val status: String = "",
    val notice: String? = null,
)

/** Exactly one of [cron] and [at] is set. [nextFireAt] is absent when disabled or a fired one-shot. */
@Serializable
data class Schedule(
    val id: String,
    val name: String = "",
    val cron: String? = null,
    val at: String? = null,
    val tz: String = "",
    val cwd: String = "",
    val prompt: String = "",
    val model: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    @SerialName("misfire_grace") val misfireGrace: String? = null,
    val enabled: Boolean = true,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val nextFireAt: Long? = null,
    val runs: List<ScheduleRun> = emptyList(),
)

@Serializable
data class CreateScheduleRequest(
    val name: String,
    val cwd: String,
    val prompt: String,
    val cron: String? = null,
    val at: String? = null,
    val tz: String? = null,
    val model: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    @SerialName("misfire_grace") val misfireGrace: String? = null,
    val enabled: Boolean? = null,
)

@Serializable
data class CreateScheduleResponse(val id: String)

@Serializable
data class UpdateScheduleRequest(
    val name: String? = null,
    val cwd: String? = null,
    val prompt: String? = null,
    val cron: String? = null,
    val at: String? = null,
    val tz: String? = null,
    val model: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    @SerialName("misfire_grace") val misfireGrace: String? = null,
    val enabled: Boolean? = null,
)

/** Error body: `{error, code?}`. */
@Serializable
data class ApiError(
    val error: String = "",
    val code: String? = null,
)

/** Typed best-effort view of one `GET /api/models` entry; the node sends more fields than these. */
@Serializable
data class ModelInfo(
    val ref: String? = null,
    val provider: String? = null,
    val id: String? = null,
    val modelId: String? = null,
    val name: String? = null,
    val reasoning: Boolean = false,
    val available: Boolean = true,
    val contextWindow: Long? = null,
) {
    /** `provider/modelId`, derived tolerantly. */
    val fullId: String?
        get() = ref ?: run {
            val m = id ?: modelId
            when {
                m == null -> null
                provider != null && !m.startsWith("$provider/") -> "$provider/$m"
                else -> m
            }
        }
}

/** Raw-object helper type for callers that want [JsonObject] semantics with a name. */
typealias RawJson = JsonObject
