package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.EntryRecord
import dev.tobor.app.api.PendingApproval
import dev.tobor.app.api.SessionDetail
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.WatchClient
import dev.tobor.app.api.WatchStatus
import dev.tobor.app.api.WorkerSummary
import dev.tobor.app.ui.screens.session.Item
import dev.tobor.app.ui.screens.session.RawEntry
import dev.tobor.app.ui.screens.session.TranscriptItem
import dev.tobor.app.ui.screens.session.liveItems
import dev.tobor.app.ui.screens.session.present
import dev.tobor.app.ui.screens.session.toItem
import dev.tobor.app.ui.screens.session.toRaw
import dev.tobor.app.ui.screens.session.toRawOrNull
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.Righteous
import dev.tobor.app.ui.theme.SpecialElite
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import androidx.compose.runtime.snapshotFlow

private val prettyJson = Json { prettyPrint = true }

private fun Throwable.brief(): String =
    if (this is ToborApiException) "${status} ${message ?: code ?: ""}".trim()
    else message ?: this::class.simpleName ?: "error"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    api: ToborApi,
    sessionId: Long,
    onBack: () -> Unit,
    onOpenConversation: (Long) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val client = remember(api, sessionId) { WatchClient(api, sessionId, scope) }
    DisposableEffect(client) {
        client.start()
        onDispose { client.stop() }
    }
    val view by client.view.collectAsState()
    val status by client.status.collectAsState()

    // ── session detail (404 => worker conversation, read-only) ──
    var detail by remember(sessionId) { mutableStateOf<SessionDetail?>(null) }
    var isWorker by remember(sessionId) { mutableStateOf<Boolean?>(null) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }

    LaunchedEffect(api, sessionId) {
        try {
            detail = api.session(sessionId)
            isWorker = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: ToborApiException) {
            if (e.status == 404) isWorker = true else {
                isWorker = false
                error = e.brief()
            }
        } catch (e: Exception) {
            isWorker = false
            error = e.brief()
        }
    }

    // ── derive live state from docs["pi.live"] ──
    val docs = view?.get("docs") as? JsonObject
    val live = docs?.get("pi.live") as? JsonObject
    val failed = live?.get("runFailure").present()
    val running = !failed && live?.get("run").present()

    // ── transcript items: REST-paged earlier + watch view entries + live tail ──
    var earlier by remember(sessionId) { mutableStateOf<List<RawEntry>>(emptyList()) }
    var earlierMore by remember(sessionId) { mutableStateOf<Boolean?>(null) }
    var loadingEarlier by remember(sessionId) { mutableStateOf(false) }

    val merged: List<RawEntry> = remember(earlier, view) {
        val map = LinkedHashMap<Long, RawEntry>()
        earlier.forEach { map[it.id] = it }
        (view?.get("entries") as? JsonArray)?.forEach { el ->
            runCatching { (el as? JsonObject)?.toRawOrNull() }.getOrNull()?.let { map[it.id] = it }
        }
        map.values.sortedBy { it.id }
    }
    val rows: List<Item> = remember(merged, live) { merged.map { it.toItem() } + liveItems(live) }
    val earlierFlag = earlierMore
    val hasEarlier: Boolean = if (earlierFlag != null) earlierFlag else view?.get("before").present()

    fun loadEarlier() {
        if (loadingEarlier) return
        val oldest = merged.firstOrNull()?.id
        scope.launch {
            loadingEarlier = true
            try {
                val resp = api.entries(
                    sessionId,
                    order = "desc",
                    limit = 50,
                    maxEntryId = oldest?.let { it - 1 },
                )
                earlier = earlier + resp.items.map { it.toRaw() }
                earlierMore = resp.more
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.brief()
            } finally {
                loadingEarlier = false
            }
        }
    }

    // ── scroll: stick to bottom if the user was at bottom ──
    val listState = rememberLazyListState()
    var atBottom by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        var prevScrolling = false
        snapshotFlow { listState.isScrollInProgress to !listState.canScrollForward }.collect { (scrolling, bottom) ->
            if (scrolling || prevScrolling) atBottom = bottom
            prevScrolling = scrolling
        }
    }
    val bottomSig = rows.lastOrNull().hashCode()
    LaunchedEffect(bottomSig) {
        if (atBottom && rows.isNotEmpty()) {
            listState.scrollToItem(rows.size - 1 + if (hasEarlier) 1 else 0)
            listState.scrollBy(1_000_000f)
        }
    }

    // ── workers strip ──
    var workers by remember(sessionId) { mutableStateOf<List<WorkerSummary>>(emptyList()) }
    LaunchedEffect(api, sessionId, isWorker) {
        if (isWorker != false) return@LaunchedEffect
        while (true) {
            try {
                workers = api.workers(sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            delay(4000)
        }
    }

    // ── approvals ──
    var approvals by remember(sessionId) { mutableStateOf<List<PendingApproval>>(emptyList()) }
    suspend fun refetchApprovals() {
        try {
            approvals = api.approvals().filter { it.sessionId == sessionId }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
    LaunchedEffect(api, sessionId, isWorker, status) {
        if (isWorker != false) return@LaunchedEffect
        while (true) {
            refetchApprovals()
            delay(3000)
        }
    }

    // ── composer ──
    var draft by remember(sessionId) { mutableStateOf("") }
    var sending by remember(sessionId) { mutableStateOf(false) }
    var composeError by remember(sessionId) { mutableStateOf<String?>(null) }
    var steerMode by remember(sessionId) { mutableStateOf("steer") }

    val title = if (isWorker == true) "worker · $sessionId"
    else (detail?.title?.takeIf { it.isNotBlank() } ?: "session").lowercase()

    Column(
        Modifier
            .fillMaxSize()
            .background(ToborColors.bg)
            .statusBarsPadding()
            .imePadding(),
    ) {
        StripeBand()

        // header
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = ToborColors.fg)
            }
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    color = ToborColors.gold,
                    fontFamily = Righteous,
                    fontSize = 18.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "no. %03d".format(sessionId),
                    color = ToborColors.muted,
                    fontFamily = SpecialElite,
                    fontSize = 11.sp,
                )
            }
            when {
                failed -> Tag("failed", ToborColors.error)
                running -> Tag("running", ToborColors.gold)
                else -> Tag("idle", ToborColors.subtle)
            }
            if (running) {
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            try {
                                api.abort(sessionId)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.brief()
                            }
                        }
                    },
                    border = BorderStroke(1.5.dp, ToborColors.orange),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.orange),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                ) {
                    Text("abort", fontFamily = SpecialElite, fontSize = 12.sp)
                }
            }
            Box(Modifier.padding(end = 4.dp))
        }

        // banners + transcript
        val endedReason = (status as? WatchStatus.Ended)?.reason
        val banner = error ?: endedReason?.let { "watch ended: $it" }
        if (banner != null) {
            Text(
                banner,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { error = null }
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                color = ToborColors.error,
                fontFamily = CourierPrime,
                fontSize = 11.sp,
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            if (hasEarlier) {
                item(key = "load-earlier") {
                    TextButton(onClick = { loadEarlier() }, enabled = !loadingEarlier) {
                        Text(
                            if (loadingEarlier) "loading…" else "load earlier",
                            color = ToborColors.gold,
                            fontFamily = SpecialElite,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
            items(rows, key = { it.key }) { TranscriptItem(it) }
        }

        // approvals
        approvals.forEachIndexed { idx, a ->
            ApprovalCard(
                a,
                primary = idx == 0,
                onDecide = { decision ->
                    scope.launch {
                        try {
                            api.decide(a.callId, decision, if (a.worker != null) a.conversationId else null)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: ToborApiException) {
                            if (e.status != 409) error = e.brief()
                        } catch (e: Exception) {
                            error = e.brief()
                        }
                        refetchApprovals()
                    }
                },
            )
        }

        if (isWorker == false) {
            // workers strip
            if (workers.isNotEmpty()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    workers.forEach { w ->
                        val color = when (w.state.lowercase()) {
                            "running" -> ToborColors.gold
                            "done" -> ToborColors.success
                            "failed", "aborted" -> ToborColors.error
                            else -> ToborColors.subtle
                        }
                        Box(Modifier.clickable { w.conversationId?.let(onOpenConversation) }) {
                            Tag("${w.name} · ${w.state}", color)
                        }
                    }
                }
            }

            // composer
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(ToborColors.sunken)
                    .navigationBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                if (running) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                        ModeChip("steer", steerMode == "steer") { steerMode = "steer" }
                        ModeChip("follow-up", steerMode == "follow_up") { steerMode = "follow_up" }
                    }
                }
                if (composeError != null) {
                    Text(
                        composeError!!,
                        color = ToborColors.error,
                        fontFamily = CourierPrime,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier.weight(1f),
                        textStyle = TextStyle(fontFamily = CourierPrime, fontSize = 14.sp, color = ToborColors.fg),
                        placeholder = {
                            Text("log an instruction…", color = ToborColors.subtle, fontFamily = CourierPrime, fontSize = 14.sp)
                        },
                        minLines = 1,
                        maxLines = 6,
                        keyboardOptions = KeyboardOptions.Default,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = ToborColors.fg,
                            unfocusedTextColor = ToborColors.fg,
                            focusedBorderColor = ToborColors.gold,
                            unfocusedBorderColor = ToborColors.border,
                            cursorColor = ToborColors.gold,
                        ),
                    )
                    // the one filled button on screen is approve when an approval is pending
                    val sendFilled = approvals.isEmpty()
                    val canSend = draft.isNotBlank() && !sending
                    FilledIconButton(
                        onClick = {
                            val text = draft.trim()
                            val mode = if (running) steerMode else "prompt"
                            sending = true
                            composeError = null
                            scope.launch {
                                try {
                                    api.input(sessionId, text, mode, java.util.UUID.randomUUID().toString())
                                    draft = ""
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    composeError = e.brief()
                                } finally {
                                    sending = false
                                }
                            }
                        },
                        enabled = canSend,
                        shape = CircleShape,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = if (sendFilled) ToborColors.gold else Color.Transparent,
                            contentColor = if (sendFilled) ToborColors.bg else ToborColors.gold,
                            disabledContainerColor = if (sendFilled) ToborColors.gold.copy(alpha = 0.35f) else Color.Transparent,
                            disabledContentColor = if (sendFilled) ToborColors.bg else ToborColors.subtle,
                        ),
                        modifier = Modifier
                            .padding(bottom = 4.dp)
                            .let { if (sendFilled) it else it.border(1.5.dp, if (canSend) ToborColors.gold else ToborColors.subtle, CircleShape) },
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "send")
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = if (selected) ToborColors.gold else ToborColors.subtle
    Text(
        label,
        modifier = Modifier
            .border(1.5.dp, c, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 3.dp),
        color = c,
        fontFamily = SpecialElite,
        fontSize = 11.sp,
    )
}

@Composable
private fun ApprovalCard(a: PendingApproval, primary: Boolean, onDecide: (String) -> Unit) {
    val args = remember(a.callId) {
        runCatching { prettyJson.encodeToString(JsonElement.serializer(), a.args) }
            .getOrElse { a.args.toString() }
            .let { if (it.length > 300) it.take(300) + "…" else it }
    }
    val shape = RoundedCornerShape(4.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .border(1.5.dp, ToborColors.warning, shape)
            .background(ToborColors.surface, shape)
            .padding(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("approval · ${a.tool}", color = ToborColors.warning, fontFamily = SpecialElite, fontSize = 12.sp)
            if (!a.worker.isNullOrBlank()) {
                Text(a.worker!!, color = ToborColors.muted, fontFamily = SpecialElite, fontSize = 11.sp)
            }
        }
        Text(
            args,
            color = ToborColors.muted,
            fontFamily = CourierPrime,
            fontSize = 11.sp,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (primary) {
                Button(
                    onClick = { onDecide("approve") },
                    colors = ButtonDefaults.buttonColors(containerColor = ToborColors.gold, contentColor = ToborColors.bg),
                ) { Text("approve", fontFamily = SpecialElite, fontSize = 12.sp) }
            } else {
                OutlinedButton(
                    onClick = { onDecide("approve") },
                    border = BorderStroke(1.5.dp, ToborColors.gold),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.gold),
                ) { Text("approve", fontFamily = SpecialElite, fontSize = 12.sp) }
            }
            OutlinedButton(
                onClick = { onDecide("approve_session") },
                border = BorderStroke(1.5.dp, ToborColors.fg),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.fg),
            ) { Text("session", fontFamily = SpecialElite, fontSize = 12.sp) }
            OutlinedButton(
                onClick = { onDecide("deny") },
                border = BorderStroke(1.5.dp, ToborColors.error),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.error),
            ) { Text("deny", fontFamily = SpecialElite, fontSize = 12.sp) }
        }
    }
}
