package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.EventsClient
import dev.tobor.app.api.PatchSessionRequest
import dev.tobor.app.api.PendingApproval
import dev.tobor.app.api.PendingQuestion
import dev.tobor.app.api.SessionSummary
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.Whoami
import dev.tobor.app.data.SettingsStore
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.Locale

private val RefreshEvents = setOf(
    "session.state", "session.updated", "approval.requested", "approval.resolved",
    "question.asked", "question.answered",
)

@Composable
fun SessionsScreen(
    api: ToborApi,
    store: SettingsStore,
    onOpen: (Long) -> Unit,
    onNew: () -> Unit,
    onSettings: () -> Unit,
    onSchedules: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var showWorkspaceMenu by remember { mutableStateOf(false) }
    var sessions by remember { mutableStateOf<List<SessionSummary>?>(null) }
    var approvals by remember { mutableStateOf<List<PendingApproval>>(emptyList()) }
    var questions by remember { mutableStateOf<List<PendingQuestion>>(emptyList()) }
    var questionErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var error by remember { mutableStateOf<String?>(null) }
    var whoami by remember { mutableStateOf<Whoami?>(null) }
    var whoamiFailed by remember { mutableStateOf(false) }
    var busyCalls by remember { mutableStateOf<Set<String>>(emptySet()) }
    var showArchived by remember { mutableStateOf(false) }
    var menuFor by remember { mutableStateOf<SessionSummary?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionSummary?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        try {
            val wantArchived = showArchived
            val s = api.sessions(archived = wantArchived)
            if (wantArchived != showArchived) return // view toggled mid-flight; stale result
            sessions = s
            error = null
            try {
                approvals = api.approvals()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // keep previous approvals
            }
            try {
                questions = api.questions()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // keep previous questions
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        }
    }

    val trigger = remember {
        MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    }
    val eventsClient = remember(api) { EventsClient(api, scope) }
    val connected by eventsClient.connected.collectAsState()

    DisposableEffect(eventsClient) {
        eventsClient.start()
        onDispose { eventsClient.stop() }
    }

    LaunchedEffect(api, showArchived) {
        sessions = null
        load()
    }
    LaunchedEffect(api) {
        while (true) {
            delay(5000)
            load()
        }
    }
    LaunchedEffect(trigger) {
        trigger.collectLatest {
            delay(300)
            load()
        }
    }
    LaunchedEffect(eventsClient) {
        eventsClient.events.collect { ev ->
            val type = (ev["type"] as? JsonPrimitive)?.contentOrNull
            if (type in RefreshEvents) trigger.tryEmit(Unit)
        }
    }
    LaunchedEffect(connected) {
        if (connected) trigger.tryEmit(Unit)
    }
    LaunchedEffect(api) {
        try {
            whoami = api.whoami()
            whoamiFailed = false
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            whoamiFailed = true
        }
    }

    fun decide(p: PendingApproval, decision: String) {
        if (p.callId in busyCalls) return
        busyCalls = busyCalls + p.callId
        scope.launch {
            try {
                api.decide(p.callId, decision, p.conversationId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ToborApiException) {
                // 409 (already resolved) and others: just refetch
            } catch (_: Exception) {
            }
            load()
            busyCalls = busyCalls - p.callId
        }
    }

    fun mutate(action: suspend () -> Unit) {
        scope.launch {
            try {
                action()
                actionError = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = e.message ?: e.toString()
            }
            load()
        }
    }

    confirmDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            containerColor = ToborColors.raised,
            title = {
                Text("delete session", fontFamily = FontFamilies.Righteous, fontSize = 18.sp, color = ToborColors.gold)
            },
            text = {
                Text(
                    "Delete session ${String.format(Locale.US, "%03d", s.id)} “${s.title.ifBlank { "untitled" }}”? This cannot be undone.",
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 13.sp,
                    color = ToborColors.fg,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = null
                        mutate { api.deleteSession(s.id) }
                    },
                ) { Text("delete", fontFamily = FontFamilies.Righteous, color = ToborColors.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = null }) {
                    Text("cancel", fontFamily = FontFamilies.Righteous, color = ToborColors.muted)
                }
            },
        )
    }

    fun answer(q: PendingQuestion, text: String) {
        if (q.callId in busyCalls) return
        busyCalls = busyCalls + q.callId
        questionErrors = questionErrors - q.callId
        scope.launch {
            try {
                api.answerQuestion(q.callId, text, q.conversationId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ToborApiException) {
                // 409 (already answered) / 404 (gone): show it, the refetch below drops the card
                questionErrors = questionErrors + (q.callId to "${e.status} ${e.message}".trim())
            } catch (e: Exception) {
                questionErrors = questionErrors + (q.callId to (e.message ?: "error"))
            }
            load()
            busyCalls = busyCalls - q.callId
        }
    }

    Surface(color = ToborColors.bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().fillMaxSize()) {
            StripeBand(Modifier.fillMaxWidth())

            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "tobor",
                        fontFamily = FontFamilies.Righteous,
                        fontSize = 28.sp,
                        color = ToborColors.gold,
                    )
                    Text(
                        if (showArchived) "ARCHIVE" else "FIELD LOG",
                        fontFamily = FontFamilies.Righteous,
                        fontSize = 9.sp,
                        letterSpacing = 2.sp,
                        color = ToborColors.muted,
                    )
                    // Workspace selector chip
                    val workspaces = store.workspaces
                    val activeIndex = store.activeIndexFlow.collectAsState().value
                    val activeWorkspace = store.active
                    Box {
                        Text(
                            "${activeWorkspace.name} ▾",
                            fontFamily = FontFamilies.SpecialElite,
                            fontSize = 11.sp,
                            color = ToborColors.gold,
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .border(1.dp, ToborColors.gold.copy(alpha = 0.5f), RoundedCornerShape(3.dp))
                                .clickable { showWorkspaceMenu = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        DropdownMenu(
                            expanded = showWorkspaceMenu,
                            onDismissRequest = { showWorkspaceMenu = false },
                        ) {
                            for (index in workspaces.indices) {
                                val workspace = workspaces[index]
                                DropdownMenuItem(
                                    text = {
                                        Row(
                                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Column(Modifier.weight(1f)) {
                                                Text(
                                                    workspace.name,
                                                    fontFamily = FontFamilies.SpecialElite,
                                                    fontSize = 13.sp,
                                                    color = ToborColors.fg,
                                                )
                                                Text(
                                                    workspace.baseUrl,
                                                    fontFamily = FontFamilies.CourierPrime,
                                                    fontSize = 11.sp,
                                                    color = ToborColors.muted,
                                                )
                                            }
                                            if (index == activeIndex) {
                                                Tag("active", color = ToborColors.gold, filled = true)
                                            }
                                        }
                                    },
                                    onClick = {
                                        store.setActive(index)
                                        showWorkspaceMenu = false
                                    },
                                )
                            }
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        "manage…",
                                        fontFamily = FontFamilies.SpecialElite,
                                        fontSize = 13.sp,
                                        color = ToborColors.muted,
                                    )
                                },
                                onClick = {
                                    showWorkspaceMenu = false
                                    onSettings()
                                },
                            )
                        }
                    }
                }
                IconButton(onClick = { showArchived = !showArchived }) {
                    Icon(
                        Icons.Default.Archive,
                        contentDescription = if (showArchived) "show active sessions" else "show archived sessions",
                        tint = if (showArchived) ToborColors.gold else ToborColors.muted,
                    )
                }
                IconButton(onClick = onSchedules) {
                    Icon(Icons.Default.Schedule, contentDescription = "schedules", tint = ToborColors.muted)
                }
                IconButton(onClick = onSettings) {
                    Icon(Icons.Default.Settings, contentDescription = "settings", tint = ToborColors.muted)
                }
                Button(
                    onClick = onNew,
                    shape = RoundedCornerShape(4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ToborColors.gold,
                        contentColor = ToborColors.bg,
                    ),
                ) {
                    Text("new entry", fontFamily = FontFamilies.Righteous, fontSize = 14.sp)
                }
            }
            HorizontalDivider(thickness = 1.dp, color = ToborColors.border)

            if (actionError != null) {
                Text(
                    actionError!!,
                    color = ToborColors.error,
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { actionError = null }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val list = sessions
                when {
                    list == null && error == null -> {
                        CircularProgressIndicator(
                            modifier = Modifier.align(Alignment.Center).size(24.dp),
                            color = ToborColors.gold,
                            strokeWidth = 2.dp,
                        )
                    }
                    list == null -> {
                        Column(
                            Modifier.align(Alignment.Center).padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(
                                error ?: "error",
                                color = ToborColors.error,
                                fontFamily = FontFamilies.CourierPrime,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                            )
                            OutlinedButton(
                                onClick = { scope.launch { load() } },
                                shape = RoundedCornerShape(4.dp),
                                border = BorderStroke(1.dp, ToborColors.muted),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.fg),
                            ) {
                                Text("retry", fontFamily = FontFamilies.Righteous)
                            }
                        }
                    }
                    else -> {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(if (showArchived) emptyList<PendingApproval>() else approvals, key = { "a-" + it.callId }) { p ->
                                ApprovalCard(
                                    p,
                                    busy = p.callId in busyCalls,
                                    onApprove = { decide(p, "approve") },
                                    onSession = { decide(p, "approve_session") },
                                    onDeny = { decide(p, "deny") },
                                )
                            }
                            items(questions, key = { "q-" + it.callId }) { q ->
                                QuestionCard(
                                    q,
                                    busy = q.callId in busyCalls,
                                    error = questionErrors[q.callId],
                                    showSession = true,
                                    onAnswer = { answer(q, it) },
                                )
                            }
                            if (list!!.isEmpty()) {
                                item(key = "empty") {
                                    Column(
                                        Modifier.fillMaxWidth().padding(vertical = 64.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                    ) {
                                        Text(
                                            if (showArchived) "nothing archived" else "no entries yet",
                                            fontFamily = FontFamilies.SpecialElite,
                                            fontSize = 16.sp,
                                            color = ToborColors.muted,
                                        )
                                        Text(
                                            if (showArchived) "archive is empty" else "form 14-b",
                                            fontFamily = FontFamilies.SpecialElite,
                                            fontSize = 12.sp,
                                            color = ToborColors.subtle,
                                        )
                                    }
                                }
                            } else {
                                items(list, key = { "s-" + it.id }) { s ->
                                    Box {
                                        SessionRow(s, onClick = { onOpen(s.id) }, onLongClick = { menuFor = s })
                                        DropdownMenu(
                                            expanded = menuFor?.id == s.id,
                                            onDismissRequest = { menuFor = null },
                                        ) {
                                            DropdownMenuItem(
                                                text = {
                                                    Text(
                                                        if (showArchived) "unarchive" else "archive",
                                                        fontFamily = FontFamilies.SpecialElite,
                                                        fontSize = 13.sp,
                                                        color = ToborColors.fg,
                                                    )
                                                },
                                                onClick = {
                                                    menuFor = null
                                                    val archive = !showArchived
                                                    mutate { api.patchSession(s.id, PatchSessionRequest(archived = archive)) }
                                                },
                                            )
                                            DropdownMenuItem(
                                                text = {
                                                    Text(
                                                        "delete",
                                                        fontFamily = FontFamilies.SpecialElite,
                                                        fontSize = 13.sp,
                                                        color = ToborColors.error,
                                                    )
                                                },
                                                onClick = {
                                                    menuFor = null
                                                    confirmDelete = s
                                                },
                                            )
                                        }
                                    }
                                    HorizontalDivider(thickness = 1.dp, color = ToborColors.border)
                                }
                            }
                        }
                    }
                }
            }

            HorizontalDivider(thickness = 1.dp, color = ToborColors.border)
            val w = whoami
            Text(
                text = when {
                    w != null -> "host · ${w.host} · v${w.version}".uppercase()
                    whoamiFailed -> "OFFLINE"
                    else -> "HOST · …"
                },
                fontFamily = FontFamilies.Righteous,
                fontSize = 9.sp,
                letterSpacing = 2.sp,
                color = if (whoamiFailed && w == null) ToborColors.error else ToborColors.muted,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onSettings)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun ApprovalCard(
    p: PendingApproval,
    busy: Boolean,
    onApprove: () -> Unit,
    onSession: () -> Unit,
    onDeny: () -> Unit,
) {
    val shape = RoundedCornerShape(4.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .background(ToborColors.surface, shape)
            .border(1.dp, ToborColors.warning, shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            "approval · ${p.tool}",
            fontFamily = FontFamilies.SpecialElite,
            fontSize = 14.sp,
            color = ToborColors.warning,
        )
        val who = buildString {
            append("session ").append(String.format(Locale.US, "%03d", p.sessionId))
            p.worker?.let { append(" · ").append(it) }
        }
        Text(who, fontFamily = FontFamilies.CourierPrime, fontSize = 11.sp, color = ToborColors.muted)
        Text(
            p.args.toString().replace('\n', ' ').take(160),
            fontFamily = FontFamilies.CourierPrime,
            fontSize = 12.sp,
            color = ToborColors.fg,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val pad = PaddingValues(horizontal = 12.dp, vertical = 0.dp)
            Button(
                onClick = onApprove,
                enabled = !busy,
                modifier = Modifier.height(32.dp),
                contentPadding = pad,
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ToborColors.gold,
                    contentColor = ToborColors.bg,
                    disabledContainerColor = ToborColors.raised,
                    disabledContentColor = ToborColors.subtle,
                ),
            ) { Text("approve", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
            OutlinedButton(
                onClick = onSession,
                enabled = !busy,
                modifier = Modifier.height(32.dp),
                contentPadding = pad,
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, ToborColors.muted),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = ToborColors.fg,
                    disabledContentColor = ToborColors.subtle,
                ),
            ) { Text("session", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
            OutlinedButton(
                onClick = onDeny,
                enabled = !busy,
                modifier = Modifier.height(32.dp),
                contentPadding = pad,
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, ToborColors.error),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = ToborColors.error,
                    disabledContentColor = ToborColors.subtle,
                ),
            ) { Text("deny", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
        }
    }
}

private fun cwdTail(cwd: String): String =
    cwd.split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/").ifEmpty { cwd }

private fun stateColor(state: String): Color = when (state) {
    "running" -> ToborColors.gold
    "waiting" -> ToborColors.warning
    "failed" -> ToborColors.error
    "working" -> ToborColors.teal
    else -> ToborColors.subtle
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(s: SessionSummary, onClick: () -> Unit, onLongClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            String.format(Locale.US, "%03d", s.id),
            fontFamily = FontFamilies.SpecialElite,
            fontSize = 16.sp,
            color = ToborColors.gold,
        )
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(
                s.title.ifBlank { "untitled" },
                fontFamily = FontFamilies.SpecialElite,
                fontSize = 15.sp,
                color = ToborColors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                cwdTail(s.cwd),
                fontFamily = FontFamilies.CourierPrime,
                fontSize = 11.sp,
                color = ToborColors.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Tag(s.state, stateColor(s.state))
            Text(
                String.format(Locale.US, "\$%.2f", s.usage.cost),
                fontFamily = FontFamilies.CourierPrime,
                fontSize = 11.sp,
                color = ToborColors.muted,
            )
            if (s.pending > 0) {
                Tag(String.format(Locale.US, "%d pending", s.pending), ToborColors.warning, filled = true)
            }
        }
    }
}
