package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.EventsClient
import dev.tobor.app.api.Schedule
import dev.tobor.app.api.ScheduleRun
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.UpdateScheduleRequest
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.RuleLabel
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
import java.text.DateFormat
import java.util.Date
import java.util.Locale

private val RefreshEvents = setOf("schedule.fired")

@Composable
fun SchedulesScreen(
    api: ToborApi,
    onOpenSession: (Long) -> Unit,
    onNew: () -> Unit,
    onEdit: (String) -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var schedules by remember { mutableStateOf<List<Schedule>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var actionErrorId by remember { mutableStateOf<String?>(null) }
    var expandedId by remember { mutableStateOf<String?>(null) }
    var busyIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var confirmDelete by remember { mutableStateOf<Schedule?>(null) }

    // Bumped on every load start; a result is applied only if no newer load has started since.
    val loadSeq = remember { intArrayOf(0) }

    suspend fun load() {
        val seq = ++loadSeq[0]
        try {
            val fresh = api.schedules()
            if (seq != loadSeq[0]) return
            schedules = fresh
            error = null
            // The failed action's schedule is gone, so the error no longer applies.
            val errId = actionErrorId
            if (errId != null && fresh.none { it.id == errId }) {
                actionError = null
                actionErrorId = null
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (seq != loadSeq[0]) return
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

    LaunchedEffect(api) { load() }
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

    fun mutate(s: Schedule, action: suspend () -> Unit) {
        if (s.id in busyIds) return
        busyIds = busyIds + s.id
        actionError = null
        actionErrorId = null
        scope.launch {
            try {
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ToborApiException) {
                actionError = e.message ?: "request failed"
                actionErrorId = s.id
            } catch (e: Exception) {
                actionError = e.message ?: e.toString()
                actionErrorId = s.id
            }
            load()
            busyIds = busyIds - s.id
        }
    }

    confirmDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            containerColor = ToborColors.raised,
            title = {
                Text("delete schedule", fontFamily = FontFamilies.Righteous, fontSize = 18.sp, color = ToborColors.gold)
            },
            text = {
                Text(
                    "Delete “${s.name}”? Its pending fire is cancelled.",
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 13.sp,
                    color = ToborColors.fg,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = null
                        mutate(s) {
                            api.deleteSchedule(s.id)
                            if (expandedId == s.id) expandedId = null
                        }
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

    Surface(color = ToborColors.bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().fillMaxSize()) {
            StripeBand(Modifier.fillMaxWidth())
            Row(
                Modifier.fillMaxWidth().padding(end = 16.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = ToborColors.fg)
                }
                Text(
                    "Schedules",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = onNew,
                    shape = RoundedCornerShape(4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ToborColors.gold,
                        contentColor = ToborColors.bg,
                    ),
                ) {
                    Text("New", fontFamily = FontFamilies.Righteous, fontSize = 14.sp)
                }
            }
            HorizontalDivider(thickness = 1.dp, color = ToborColors.border)

            actionError?.let {
                Text(
                    it,
                    color = ToborColors.error,
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            actionError = null
                            actionErrorId = null
                        }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                val list = schedules
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
                    list!!.isEmpty() -> {
                        Column(
                            Modifier.align(Alignment.Center).padding(vertical = 64.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                "no schedules yet",
                                fontFamily = FontFamilies.SpecialElite,
                                fontSize = 16.sp,
                                color = ToborColors.muted,
                            )
                        }
                    }
                    else -> {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(list, key = { it.id }) { s ->
                                ScheduleRow(
                                    s,
                                    expanded = expandedId == s.id,
                                    busy = s.id in busyIds,
                                    onClick = { expandedId = if (expandedId == s.id) null else s.id },
                                    onToggle = {
                                        mutate(s) { api.updateSchedule(s.id, UpdateScheduleRequest(enabled = !s.enabled)) }
                                    },
                                    onEdit = { onEdit(s.id) },
                                    onDelete = { confirmDelete = s },
                                    onOpenSession = onOpenSession,
                                )
                                HorizontalDivider(thickness = 1.dp, color = ToborColors.border)
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun formatTime(ms: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.getDefault()).format(Date(ms))

private fun timing(s: Schedule): String {
    val when_ = s.cron?.let { "cron $it" } ?: "at ${s.at ?: "?"}"
    return if (s.tz.isBlank()) when_ else "$when_ · ${s.tz}"
}

private fun runColor(status: String): Color = when (status) {
    "running" -> ToborColors.gold
    "done" -> ToborColors.success
    "failed" -> ToborColors.error
    else -> ToborColors.warning
}

@Composable
private fun ScheduleRow(
    s: Schedule,
    expanded: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onOpenSession: (Long) -> Unit,
) {
    val last = s.runs.lastOrNull()
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                s.name,
                fontFamily = FontFamilies.SpecialElite,
                fontSize = 15.sp,
                color = ToborColors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            if (s.enabled) Tag("enabled", ToborColors.success) else Tag("disabled", ToborColors.subtle)
        }
        Text(
            timing(s),
            fontFamily = FontFamilies.CourierPrime,
            fontSize = 11.sp,
            color = ToborColors.muted,
            maxLines = if (expanded) Int.MAX_VALUE else 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                s.nextFireAt?.let { "next ${formatTime(it)}" } ?: "no next fire",
                fontFamily = FontFamilies.CourierPrime,
                fontSize = 11.sp,
                color = ToborColors.muted,
                modifier = Modifier.weight(1f),
            )
            if (last != null) {
                Text("last", fontFamily = FontFamilies.CourierPrime, fontSize = 11.sp, color = ToborColors.muted)
                Tag(last.status.replace('_', ' '), runColor(last.status))
            }
        }

        if (expanded) {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                RuleLabel("details")
                DetailLine("cwd", s.cwd)
                DetailLine("model", s.model ?: "default")
                DetailLine("approval", s.approvalMode ?: "ask")
                DetailLine("misfire grace", s.misfireGrace ?: "2h")
                RuleLabel("prompt")
                Text(s.prompt, fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.fg)
                RuleLabel("runs")
                if (s.runs.isEmpty()) {
                    Text("none yet", fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.subtle)
                } else {
                    s.runs.takeLast(10).reversed().forEach { r -> RunLine(r, onOpenSession) }
                }
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = onToggle,
                        enabled = !busy,
                        modifier = Modifier.height(32.dp),
                        shape = RoundedCornerShape(4.dp),
                        border = BorderStroke(1.dp, ToborColors.muted),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = ToborColors.fg,
                            disabledContentColor = ToborColors.subtle,
                        ),
                    ) { Text(if (s.enabled) "disable" else "enable", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
                    OutlinedButton(
                        onClick = onEdit,
                        enabled = !busy,
                        modifier = Modifier.height(32.dp),
                        shape = RoundedCornerShape(4.dp),
                        border = BorderStroke(1.dp, ToborColors.muted),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = ToborColors.fg,
                            disabledContentColor = ToborColors.subtle,
                        ),
                    ) { Text("Edit", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
                    OutlinedButton(
                        onClick = onDelete,
                        enabled = !busy,
                        modifier = Modifier.height(32.dp),
                        shape = RoundedCornerShape(4.dp),
                        border = BorderStroke(1.dp, ToborColors.error),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = ToborColors.error,
                            disabledContentColor = ToborColors.subtle,
                        ),
                    ) { Text("delete", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
                }
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.muted)
        Text(
            value,
            fontFamily = FontFamilies.CourierPrime,
            fontSize = 12.sp,
            color = ToborColors.fg,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun RunLine(r: ScheduleRun, onOpenSession: (Long) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Tag(r.status.replace('_', ' '), runColor(r.status))
            Text(
                formatTime(r.fireAt),
                fontFamily = FontFamilies.CourierPrime,
                fontSize = 12.sp,
                color = ToborColors.fg,
            )
            r.conversationId?.let { id ->
                Text(
                    "#" + String.format(Locale.US, "%03d", id),
                    fontFamily = FontFamilies.SpecialElite,
                    fontSize = 12.sp,
                    color = ToborColors.gold,
                    modifier = Modifier.clickable { onOpenSession(id) },
                )
            }
        }
        r.notice?.let {
            Text(it, fontFamily = FontFamilies.CourierPrime, fontSize = 11.sp, color = ToborColors.subtle)
        }
    }
}
