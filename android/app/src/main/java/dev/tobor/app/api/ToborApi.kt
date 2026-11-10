package dev.tobor.app.api

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
 * REST + socket factory for one tobor node. [baseUrl] may be changed at runtime (e.g. from settings); every call reads
 * it fresh. Mutations send `Content-Type: application/json`; no `Origin` header is ever added (OkHttp adds none).
 */
class ToborApi(baseUrl: String) {
    @Volatile
    var baseUrl: String = normalize(baseUrl)
        set(value) {
            field = normalize(value)
        }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Same pool/dispatcher, but no read/call timeouts: sockets are long-lived and we send our own pings. */
    internal val wsClient: OkHttpClient = client.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    // ─── REST ────────────────────────────────────────────────────────────────────────────────────────────────────

    suspend fun whoami(): Whoami = get("/api/whoami").decode()

    suspend fun sessions(archived: Boolean = false): List<SessionSummary> =
        get("/api/sessions", if (archived) mapOf("archived" to "1") else emptyMap())
            .decode(ListSerializer(SessionSummary.serializer()))

    /** Creates a session and returns its id. */
    suspend fun createSession(
        cwd: String,
        prompt: String,
        model: String? = null,
        thinking: String? = null,
        approvalMode: String? = null,
        mode: String? = null,
    ): Long {
        val body = toborJson.encodeToString(CreateSessionRequest(cwd, prompt, model, thinking, approvalMode, mode))
        return send("POST", "/api/sessions", body).decode<CreateSessionResponse>().id
    }

    suspend fun session(id: Long): SessionDetail = get("/api/sessions/$id").decode()

    suspend fun patchSession(id: Long, patch: PatchSessionRequest): SessionDetail =
        send("PATCH", "/api/sessions/$id", toborJson.encodeToString(patch)).decode()

    suspend fun deleteSession(id: Long) {
        send("DELETE", "/api/sessions/$id", null)
    }

    /** [mode]: prompt | steer | follow_up. Returns the submission id. */
    suspend fun input(id: Long, content: String, mode: String, requestId: String): Long =
        send("POST", "/api/sessions/$id/input", toborJson.encodeToString(InputRequest(content, mode, requestId)))
            .decode<InputResponse>().submissionId

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

    /** Raw `{models, providers, defaults}`. */
    suspend fun models(): JsonObject = get("/api/models").decode<JsonElement>().jsonObject

    /**
     * `"provider/modelId"` strings plus the default model, parsed tolerantly from [models]: each entry may be a string
     * or an object with `ref`, or `provider`+`id`/`modelId`; the default is `defaults.model`.
     */
    suspend fun modelIds(): Pair<List<String>, String?> = parseModelIds(models())

    suspend fun cwds(): CwdsResponse = get("/api/cwds").decode()

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
        val builder = (baseUrl + path).toHttpUrl().newBuilder()
        for ((k, v) in query) builder.addQueryParameter(k, v)
        return builder.build()
    }

    private suspend fun get(path: String, query: Map<String, String> = emptyMap()): String =
        execute(Request.Builder().url(urlFor(path, query)).get().build())

    private suspend fun send(method: String, path: String, json: String?): String {
        val body: RequestBody? = json?.toByteArray(Charsets.UTF_8)?.toRequestBody(jsonType)
        val builder = Request.Builder().url(urlFor(path, emptyMap()))
        when (method) {
            "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
            else -> builder.method(method, body ?: ByteArray(0).toRequestBody(jsonType))
        }
        return execute(builder.build())
    }

    private suspend fun execute(request: Request): String = suspendCancellableCoroutine { cont ->
        val call = client.newCall(request)
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
    }
}
