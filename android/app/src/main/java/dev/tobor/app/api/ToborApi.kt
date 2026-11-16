package dev.tobor.app.api

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Non-2xx response. [code] is the node's machine-readable error code when the body carried one. */
class ToborApiException(
    val status: Int,
    val code: String?,
    message: String,
) : IOException(message)

/**
 * REST + socket factory for one tobor node. [baseUrl] and [token] may be changed at runtime (e.g. from settings); every
 * call reads them fresh. Mutations send `Content-Type: application/json`; no `Origin` header is ever added (OkHttp adds
 * none). A non-empty [token] is sent as `Authorization: Bearer …` on every REST call and WebSocket upgrade to the node
 * (one application interceptor, inherited by all derived clients) and never to any other host.
 */
class ToborApi(baseUrl: String, token: String = "") {
    /** Node address and its token as one immutable value, so readers never see a new host with the old token. */
    private class Config(val baseUrl: String, val token: String)

    @Volatile
    private var config = Config(normalize(baseUrl), normalizeToken(token))

    var baseUrl: String
        get() = config.baseUrl
        set(value) = configure(value, config.token)

    var token: String
        get() = config.token
        set(value) = configure(config.baseUrl, value)

    /** Points the api at one workspace's node; host and token switch together in a single reference swap. */
    @Synchronized
    fun configure(baseUrl: String, token: String) {
        val next = Config(normalize(baseUrl), normalizeToken(token))
        val prev = config
        config = next
        if (next.baseUrl != prev.baseUrl || next.token != prev.token) resetAuthPrompt()
    }

    private val _authRequired = MutableStateFlow(false)

    /** True once the node answered 401 (missing/wrong [token]) and the user has not dismissed the prompt for it. */
    val authRequired: StateFlow<Boolean> = _authRequired.asStateFlow()

    @Volatile
    private var authPromptMuted = false

    /** User declined to enter a token: stay quiet (no re-prompt from polling/reconnects) until the node/token changes or a call succeeds. */
    fun dismissAuthPrompt() {
        authPromptMuted = true
        _authRequired.value = false
    }

    /** Clears the 401 state and un-mutes the prompt (call after the user saved a token, even an unchanged one, so a retry can re-prompt). */
    fun resetAuthPrompt() {
        authPromptMuted = false
        _authRequired.value = false
    }

    private val authInterceptor = Interceptor { chain ->
        val request = chain.request()
        val cfg = config // one read: host and token always belong together
        val node = cfg.baseUrl.toHttpUrlOrNull()
        val toNode = node != null && request.url.scheme == node.scheme &&
            request.url.host == node.host && request.url.port == node.port
        val t = cfg.token
        val outgoing = if (toNode && t.isNotEmpty()) request.newBuilder().header("Authorization", "Bearer $t").build() else request
        val response = chain.proceed(outgoing)
        if (toNode) {
            if (response.code == 401) {
                if (!authPromptMuted) _authRequired.value = true
            } else if (response.code < 400) {
                authPromptMuted = false
            }
        }
        response
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(authInterceptor)
        .build()

    /** Same pool/dispatcher, but no read/call timeouts: sockets are long-lived and we send our own pings. */
    internal val wsClient: OkHttpClient = client.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Same pool/dispatcher, but a longer whole-request timeout for bodies that carry image attachments. */
    private val uploadClient: OkHttpClient = client.newBuilder()
        .callTimeout(120, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    // ─── REST ────────────────────────────────────────────────────────────────────────────────────────────────────

    suspend fun whoami(): Whoami = get("/api/whoami").decode()

    /** Throws [ToborApiException] with code `unsupported` (400) when the node runs from source. */
    suspend fun upgrade(): UpgradeResponse = send("POST", "/api/upgrade", "{}").decode()

    suspend fun restart(): RestartResponse = send("POST", "/api/restart", "{}").decode()

    suspend fun sessions(archived: Boolean = false): List<SessionSummary> =
        get("/api/sessions", if (archived) mapOf("archived" to "1") else emptyMap())
            .decode(ListSerializer(SessionSummary.serializer()))

    /** Artifact feed, newest first; optionally limited to one project id. */
    suspend fun artifacts(project: String? = null): List<ArtifactSummary> =
        get("/api/artifacts", if (project != null) mapOf("project" to project) else emptyMap())
            .decode(ListSerializer(ArtifactSummary.serializer()))

    /** Creates a session and returns its id. */
    suspend fun createSession(
        cwd: String,
        prompt: String,
        model: String? = null,
        thinking: String? = null,
        approvalMode: String? = null,
        mode: String? = null,
        attachments: List<ImageAttachment> = emptyList(),
    ): Long {
        val body = toborJson.encodeToString(
            CreateSessionRequest(cwd, prompt, model, thinking, approvalMode, mode, attachments.ifEmpty { null }),
        )
        return send("POST", "/api/sessions", body, upload = attachments.isNotEmpty()).decode<CreateSessionResponse>().id
    }

    suspend fun session(id: Long): SessionDetail = get("/api/sessions/$id").decode()

    suspend fun patchSession(id: Long, patch: PatchSessionRequest): SessionDetail =
        send("PATCH", "/api/sessions/$id", toborJson.encodeToString(patch)).decode()

    suspend fun deleteSession(id: Long) {
        send("DELETE", "/api/sessions/$id", null)
    }

    /** [mode]: prompt | steer | follow_up. Returns the submission id. */
    suspend fun input(
        id: Long,
        content: String,
        mode: String,
        requestId: String,
        attachments: List<ImageAttachment> = emptyList(),
    ): Long =
        send(
            "POST",
            "/api/sessions/$id/input",
            toborJson.encodeToString(InputRequest(content, mode, requestId, attachments.ifEmpty { null })),
            upload = attachments.isNotEmpty(),
        ).decode<InputResponse>().submissionId

    suspend fun abort(id: Long) {
        send("POST", "/api/sessions/$id/abort", "{}")
    }

    /** [order]: asc | desc. [limit] 1..500. */
    suspend fun entries(
        id: Long,
        order: String = "desc",
        limit: Int = 50,
        minEntryId: Long? = null,
        maxEntryId: Long? = null,
    ): EntriesResponse {
        val q = linkedMapOf("order" to order, "limit" to limit.toString())
        if (minEntryId != null) q["minEntryId"] = minEntryId.toString()
        if (maxEntryId != null) q["maxEntryId"] = maxEntryId.toString()
        return get("/api/sessions/$id/entries", q).decode()
    }

    suspend fun workers(id: Long): List<WorkerSummary> =
        get("/api/sessions/$id/workers").decode(ListSerializer(WorkerSummary.serializer()))

    suspend fun approvals(): List<PendingApproval> =
        get("/api/approvals").decode(ListSerializer(PendingApproval.serializer()))

    /** [decision]: approve | approve_session | deny. Throws [ToborApiException] with status 409 if already decided. */
    suspend fun decide(callId: String, decision: String, conversationId: Long? = null) {
        val body = toborJson.encodeToString(DecideRequest(decision, conversationId))
        send("POST", "/api/approvals/${encodeSegment(callId)}", body)
    }

    suspend fun questions(): List<PendingQuestion> =
        get("/api/questions").decode(ListSerializer(PendingQuestion.serializer()))

    /** Throws [ToborApiException]: 400 blank answer, 404 unknown question, 409 already answered. */
    suspend fun answerQuestion(callId: String, answer: String, conversationId: Long? = null) {
        val body = toborJson.encodeToString(AnswerQuestionRequest(answer, conversationId))
        send("POST", "/api/questions/${encodeSegment(callId)}", body)
    }

    /** Raw `{models, providers, defaults}`. */
    suspend fun models(): JsonObject = get("/api/models").decode<JsonElement>().jsonObject

    suspend fun cwds(): CwdsResponse = get("/api/cwds").decode()

    /** Path completion for [prefix] (raw token: empty, relative to the session cwd, absolute or `~/…`). Never errors outside the roots; entries are just empty. */
    suspend fun complete(sessionId: Long, prefix: String): PathCompleteResponse =
        get("/api/sessions/$sessionId/complete", mapOf("prefix" to prefix)).decode()

    /** Session-less path completion for the New Session page: [cwd] (blank/null = the node's default new-session cwd) resolves relative prefixes. */
    suspend fun completeAt(cwd: String?, prefix: String): PathCompleteResponse =
        get("/api/complete", buildMap {
            put("prefix", prefix)
            if (!cwd.isNullOrBlank()) put("cwd", cwd)
        }).decode()

    suspend fun schedules(): List<Schedule> =
        get("/api/schedules").decode(ListSerializer(Schedule.serializer()))

    suspend fun schedule(id: String): Schedule = get("/api/schedules/${encodeSegment(id)}").decode()

    /** Creates a schedule and returns its id (the node answers `{id}`, not the schedule). */
    suspend fun createSchedule(request: CreateScheduleRequest): String =
        send("POST", "/api/schedules", toborJson.encodeToString(request)).decode<CreateScheduleResponse>().id

    suspend fun updateSchedule(id: String, patch: UpdateScheduleRequest): Schedule =
        send("PUT", "/api/schedules/${encodeSegment(id)}", toborJson.encodeToString(patch)).decode()

    suspend fun deleteSchedule(id: String) {
        send("DELETE", "/api/schedules/${encodeSegment(id)}", null)
    }

    // ─── Socket plumbing (used by WatchClient / EventsClient) ────────────────────────────────────────────────────

    /** `ws(s)://host:port<path>` derived from [baseUrl], with optional query parameters. */
    internal fun wsUrl(path: String, query: Map<String, String> = emptyMap()): String {
        val url = urlFor(path, query)
        val scheme = if (url.isHttps) "wss" else "ws"
        return scheme + url.toString().removePrefix(url.scheme)
    }

    internal fun openSocket(url: String, listener: WebSocketListener): WebSocket =
        wsClient.newWebSocket(Request.Builder().url(url).build(), listener)

    // ─── Internals ───────────────────────────────────────────────────────────────────────────────────────────────

    private fun urlFor(path: String, query: Map<String, String>): HttpUrl {
        val builder = (config.baseUrl + path).toHttpUrl().newBuilder()
        for ((k, v) in query) builder.addQueryParameter(k, v)
        return builder.build()
    }

    private suspend fun get(path: String, query: Map<String, String> = emptyMap()): String =
        execute(Request.Builder().url(urlFor(path, query)).get().build())

    private suspend fun send(method: String, path: String, json: String?, upload: Boolean = false): String {
        val body: RequestBody? = json?.toByteArray(Charsets.UTF_8)?.toRequestBody(jsonType)
        val builder = Request.Builder().url(urlFor(path, emptyMap()))
        when (method) {
            "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
            else -> builder.method(method, body ?: ByteArray(0).toRequestBody(jsonType))
        }
        return execute(builder.build(), if (upload) uploadClient else client)
    }

    private suspend fun execute(request: Request, http: OkHttpClient = client): String = suspendCancellableCoroutine { cont ->
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { r ->
                    try {
                        val text = r.body?.string().orEmpty()
                        if (r.isSuccessful) {
                            cont.resume(text)
                        } else {
                            cont.resumeWithException(errorFrom(r.code, r.message, text))
                        }
                    } catch (e: IOException) {
                        if (cont.isActive) cont.resumeWithException(e)
                    }
                }
            }
        })
    }

    private fun errorFrom(status: Int, statusMessage: String, body: String): ToborApiException {
        val parsed = runCatching { toborJson.decodeFromString<ApiError>(body) }.getOrNull()
        val message = parsed?.error?.takeIf { it.isNotEmpty() }
            ?: body.takeIf { it.isNotBlank() && it.length < 300 }
            ?: statusMessage.ifEmpty { "HTTP $status" }
        return ToborApiException(status, parsed?.code, message)
    }

    private inline fun <reified T> String.decode(): T = toborJson.decodeFromString<T>(this)

    private fun <T> String.decode(serializer: kotlinx.serialization.KSerializer<T>): T =
        toborJson.decodeFromString(serializer, this)

    private fun encodeSegment(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    companion object {
        /** Trim whitespace and trailing slashes. */
        fun normalize(url: String): String = url.trim().trimEnd('/')

        /** Bearer tokens are visible ASCII; dropping everything else (spaces, newlines from a paste) keeps the header valid. */
        fun normalizeToken(token: String): String = token.filter { it.code in 33..126 }

        internal fun parseModelIds(raw: JsonObject): Pair<List<String>, String?> {
            val ids = (raw["models"] as? JsonArray).orEmpty().mapNotNull { e ->
                when (e) {
                    is JsonPrimitive -> e.contentOrNull
                    is JsonObject -> {
                        val ref = (e["ref"] as? JsonPrimitive)?.contentOrNull
                        if (ref != null) {
                            ref
                        } else {
                            val provider = (e["provider"] as? JsonPrimitive)?.contentOrNull
                            val id = (e["modelId"] as? JsonPrimitive)?.contentOrNull
                                ?: (e["id"] as? JsonPrimitive)?.contentOrNull
                            when {
                                id == null -> null
                                provider != null && !id.startsWith("$provider/") -> "$provider/$id"
                                else -> id
                            }
                        }
                    }
                    else -> null
                }
            }.distinct()
            val defaults = raw["defaults"] as? JsonObject
            val def = (defaults?.get("model") as? JsonPrimitive)?.contentOrNull
            return ids to def
        }

        internal fun parseSessionDefaults(raw: JsonObject): Pair<String?, String?> {
            val defaults = raw["defaults"] as? JsonObject
            val approval = (defaults?.get("approval_mode") as? JsonPrimitive)?.contentOrNull
            val mode = (defaults?.get("mode") as? JsonPrimitive)?.contentOrNull
            return approval to mode
        }
    }
}
