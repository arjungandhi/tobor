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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.EntryRecord
import dev.tobor.app.api.PatchSessionRequest
import dev.tobor.app.api.PendingApproval
import dev.tobor.app.api.PendingQuestion
import dev.tobor.app.api.SessionDetail
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.WatchClient
import dev.tobor.app.api.WatchStatus
import dev.tobor.app.api.WorkerSummary
import dev.tobor.app.ui.screens.session.AttachImageButton
import dev.tobor.app.ui.screens.session.Item
import dev.tobor.app.ui.screens.session.PendingImages
import dev.tobor.app.ui.screens.session.PendingImagesRow
import dev.tobor.app.ui.screens.session.RawEntry
import dev.tobor.app.ui.screens.session.TranscriptItem
import dev.tobor.app.ui.screens.session.liveItems
import dev.tobor.app.ui.screens.session.queuedItems
import dev.tobor.app.ui.screens.session.present
import dev.tobor.app.ui.screens.session.toItem
import dev.tobor.app.ui.screens.session.toRaw
import dev.tobor.app.ui.screens.session.toRawOrNull
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.fieldTextStyle
import dev.tobor.app.ui.theme.Righteous
import dev.tobor.app.ui.theme.SpecialElite
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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

    // ── transcript items: REST-paged earlier + watch view entries + live tail + queued inbox ──
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
    val rows: List<Item> = remember(merged, live, docs) { merged.map { it.toItem() } + liveItems(live) + queuedItems(docs) }
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

    // ── approvals + questions (polled while this is a live session) ──
    val pending = rememberPending(api, sessionId, isWorker, status)

    var confirmDelete by remember(sessionId) { mutableStateOf(false) }

    val title = if (isWorker == true) "worker · $sessionId"
    else (detail?.title?.takeIf { it.isNotBlank() } ?: "session").lowercase()

    if (confirmDelete) {
        DeleteSessionDialog(
            api = api,
            sessionId = sessionId,
            title = title,
            scope = scope,
            onDismiss = { confirmDelete = false },
            onBack = onBack,
            onError = { error = it },
        )
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(ToborColors.bg)
            .statusBarsPadding()
            .imePadding(),
    ) {
        StripeBand()

        SessionHeader(
            api = api,
            sessionId = sessionId,
            scope = scope,
            title = title,
            failed = failed,
            running = running,
            working = workers.any { it.state.lowercase() in setOf("starting", "running") },
            isWorker = isWorker,
            archived = detail?.archived == true,
            onBack = onBack,
            onRequestDelete = { confirmDelete = true },
            onError = { error = it },
        )

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
        TranscriptList(
            listState = listState,
            rows = rows,
            hasEarlier = hasEarlier,
            loadingEarlier = loadingEarlier,
            onLoadEarlier = { loadEarlier() },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )

        ApprovalCards(api, scope, pending, onError = { error = it })
        QuestionCards(api, scope, pending)

        if (isWorker == false) {
            WorkersStrip(workers, onOpenConversation)
            Composer(
                api = api,
                sessionId = sessionId,
                scope = scope,
                running = running,
                // the one filled button on screen is approve when an approval is pending
                sendFilled = pending.approvals.isEmpty() && pending.questions.isEmpty(),
            )
        }
    }
}

// ── pending approvals / questions state ──

@Stable
private class PendingState(private val api: ToborApi, private val sessionId: Long) {
    var approvals by mutableStateOf<List<PendingApproval>>(emptyList())
    var questions by mutableStateOf<List<PendingQuestion>>(emptyList())
    var questionErrors by mutableStateOf<Map<String, String>>(emptyMap())
    var busyQuestions by mutableStateOf<Set<String>>(emptySet())

    suspend fun refetchApprovals() {
        try {
            approvals = api.approvals().filter { it.sessionId == sessionId }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    suspend fun refetchQuestions() {
        try {
            questions = api.questions().filter { it.sessionId == sessionId }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }
}

@Composable
private fun rememberPending(api: ToborApi, sessionId: Long, isWorker: Boolean?, status: WatchStatus): PendingState {
    val pending = remember(api, sessionId) { PendingState(api, sessionId) }
    LaunchedEffect(api, sessionId, isWorker, status) {
        if (isWorker != false) return@LaunchedEffect
        while (true) {
            pending.refetchApprovals()
            pending.refetchQuestions()
            delay(3000)
        }
    }
    return pending
}

@Composable
private fun ApprovalCards(
    api: ToborApi,
    scope: CoroutineScope,
    pending: PendingState,
    onError: (String) -> Unit,
) {
    pending.approvals.forEachIndexed { idx, a ->
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
                        if (e.status != 409) onError(e.brief())
                    } catch (e: Exception) {
                        onError(e.brief())
                    }
                    pending.refetchApprovals()
                }
            },
        )
    }
}

@Composable
private fun QuestionCards(api: ToborApi, scope: CoroutineScope, pending: PendingState) {
    // questions (ask_user)
    pending.questions.forEach { q ->
        QuestionCard(
            q,
            busy = q.callId in pending.busyQuestions,
            error = pending.questionErrors[q.callId],
            showSession = false,
            onAnswer = { text ->
                pending.busyQuestions = pending.busyQuestions + q.callId
                pending.questionErrors = pending.questionErrors - q.callId
                scope.launch {
                    try {
                        api.answerQuestion(q.callId, text, q.conversationId)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // 409/404 are non-fatal: show on the card; the refetch drops it if it is gone
                        pending.questionErrors = pending.questionErrors + (q.callId to e.brief())
                    }
                    pending.refetchQuestions()
                    pending.busyQuestions = pending.busyQuestions - q.callId
                }
            },
        )
    }
}

// ── delete dialog ──

@Composable
private fun DeleteSessionDialog(
    api: ToborApi,
    sessionId: Long,
    title: String,
    scope: CoroutineScope,
    onDismiss: () -> Unit,
    onBack: () -> Unit,
    onError: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ToborColors.raised,
        title = {
            Text("delete session", fontFamily = Righteous, fontSize = 18.sp, color = ToborColors.gold)
        },
        text = {
            Text(
                "Delete session %03d “%s”? This cannot be undone.".format(sessionId, title),
                fontFamily = CourierPrime,
                fontSize = 13.sp,
                color = ToborColors.fg,
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    scope.launch {
                        try {
                            api.deleteSession(sessionId)
                            onBack()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            onError(e.brief())
                        }
                    }
                },
            ) { Text("delete", fontFamily = Righteous, color = ToborColors.error) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("cancel", fontFamily = Righteous, color = ToborColors.muted)
            }
        },
    )
}

// ── header ──

@Composable
private fun SessionHeader(
    api: ToborApi,
    sessionId: Long,
    scope: CoroutineScope,
    title: String,
    failed: Boolean,
    running: Boolean,
    working: Boolean,
    isWorker: Boolean?,
    archived: Boolean,
    onBack: () -> Unit,
    onRequestDelete: () -> Unit,
    onError: (String) -> Unit,
) {
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
            working -> Tag("working", ToborColors.teal)
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
                            onError(e.brief())
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
        if (isWorker == false) {
            SessionMenu(api, sessionId, scope, archived, onBack, onRequestDelete, onError)
        }
        Box(Modifier.padding(end = 4.dp))
    }
}

@Composable
private fun SessionMenu(
    api: ToborApi,
    sessionId: Long,
    scope: CoroutineScope,
    archived: Boolean,
    onBack: () -> Unit,
    onRequestDelete: () -> Unit,
    onError: (String) -> Unit,
) {
    var showMenu by remember(sessionId) { mutableStateOf(false) }
    Box {
        IconButton(onClick = { showMenu = true }) {
            Icon(Icons.Default.MoreVert, contentDescription = "more", tint = ToborColors.muted)
        }
        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
            DropdownMenuItem(
                text = {
                    Text(
                        if (archived) "unarchive" else "archive",
                        fontFamily = SpecialElite,
                        fontSize = 13.sp,
                        color = ToborColors.fg,
                    )
                },
                onClick = {
                    showMenu = false
                    val archive = !archived
                    scope.launch {
                        try {
                            api.patchSession(sessionId, PatchSessionRequest(archived = archive))
                            onBack()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            onError(e.brief())
                        }
                    }
                },
            )
            DropdownMenuItem(
                text = {
                    Text("delete", fontFamily = SpecialElite, fontSize = 13.sp, color = ToborColors.error)
                },
                onClick = {
                    showMenu = false
                    onRequestDelete()
                },
            )
        }
    }
}

// ── transcript ──

@Composable
private fun TranscriptList(
    listState: LazyListState,
    rows: List<Item>,
    hasEarlier: Boolean,
    loadingEarlier: Boolean,
    onLoadEarlier: () -> Unit,
    modifier: Modifier,
) {
    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    ) {
        if (hasEarlier) {
            item(key = "load-earlier") {
                TextButton(onClick = onLoadEarlier, enabled = !loadingEarlier) {
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
}

// ── workers strip ──

@Composable
private fun WorkersStrip(workers: List<WorkerSummary>, onOpenConversation: (Long) -> Unit) {
    if (workers.isEmpty()) return
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

// ── composer ──

@Composable
private fun Composer(
    api: ToborApi,
    sessionId: Long,
    scope: CoroutineScope,
    running: Boolean,
    sendFilled: Boolean,
) {
    var draft by remember(sessionId) { mutableStateOf(TextFieldValue("")) }
    var pathPickerOpen by remember(sessionId) { mutableStateOf(false) }
    val draftFocus = remember { FocusRequester() }
    var refocus by remember { mutableIntStateOf(0) }
    LaunchedEffect(refocus) {
        if (refocus > 0) {
            delay(50) // let the sheet's window release focus first
            try {
                draftFocus.requestFocus()
            } catch (_: IllegalStateException) {
            }
        }
    }
    var sending by remember(sessionId) { mutableStateOf(false) }
    var composeError by remember(sessionId) { mutableStateOf<String?>(null) }
    var steerMode by remember(sessionId) { mutableStateOf("steer") }
    val pendingImages = remember(sessionId) { PendingImages() }

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
        PendingImagesRow(pendingImages, Modifier.padding(bottom = 6.dp))
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AttachImageButton(pendingImages, onProblem = { composeError = it }, modifier = Modifier.padding(bottom = 2.dp))
            OutlinedTextField(
                value = draft,
                onValueChange = { next ->
                    // `@` typed at a token boundary opens the path picker; the typed `@` stays until a path replaces it.
                    if (typedAtTrigger(draft.text, next.text, next.selection.end) != null && next.selection.collapsed) {
                        pathPickerOpen = true
                    }
                    draft = next
                },
                modifier = Modifier.weight(1f).focusRequester(draftFocus),
                textStyle = fieldTextStyle(color = ToborColors.fg),
                placeholder = {
                    Text("log an instruction…", color = ToborColors.subtle, style = fieldTextStyle())
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
            val canSend = (draft.text.isNotBlank() || pendingImages.items.isNotEmpty()) && !sending && !pendingImages.loading
            FilledIconButton(
                onClick = {
                    val text = draft.text.trim()
                    val mode = if (running) steerMode else "prompt"
                    val attachments = pendingImages.attachments
                    sending = true
                    composeError = null
                    scope.launch {
                        try {
                            api.input(sessionId, text, mode, java.util.UUID.randomUUID().toString(), attachments)
                            draft = TextFieldValue("")
                            pendingImages.clear()
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
    if (pathPickerOpen) {
        PathPickerSheet(
            api = api,
            sessionId = sessionId,
            onInsert = { path ->
                val r = replaceAtToken(draft.text, draft.selection.end, path)
                draft = TextFieldValue(r.text, TextRange(r.cursor))
                pathPickerOpen = false
                refocus++
            },
            onDismiss = {
                pathPickerOpen = false
                refocus++
            },
        )
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
