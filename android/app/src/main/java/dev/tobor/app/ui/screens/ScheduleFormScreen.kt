package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.CreateScheduleRequest
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.UpdateScheduleRequest
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.RuleLabel
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
private fun toborFieldColors(): TextFieldColors = OutlinedTextFieldDefaults.colors(
    focusedTextColor = ToborColors.fg,
    unfocusedTextColor = ToborColors.fg,
    disabledTextColor = ToborColors.subtle,
    focusedBorderColor = ToborColors.gold,
    unfocusedBorderColor = ToborColors.border,
    focusedLabelColor = ToborColors.gold,
    unfocusedLabelColor = ToborColors.muted,
    cursorColor = ToborColors.gold,
    focusedContainerColor = ToborColors.sunken,
    unfocusedContainerColor = ToborColors.sunken,
    focusedPlaceholderColor = ToborColors.subtle,
    unfocusedPlaceholderColor = ToborColors.subtle,
    focusedTrailingIconColor = ToborColors.muted,
    unfocusedTrailingIconColor = ToborColors.muted,
)

private val fieldTextStyle = dev.tobor.app.ui.theme.fieldTextStyle()

@Composable
private fun OptionChip(text: String, selected: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val color = if (selected) ToborColors.gold else ToborColors.muted
    Box(
        Modifier
            .clip(shape)
            .border(1.dp, if (selected) ToborColors.gold else ToborColors.border, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            text,
            fontFamily = FontFamilies.CourierPrime,
            fontSize = 12.sp,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ScheduleFormScreen(
    api: ToborApi,
    editId: String? = null,
    onDone: () -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var useCron by remember { mutableStateOf(true) }
    var cron by remember { mutableStateOf("") }
    var at by remember { mutableStateOf("") }
    var tz by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var approvalMode by remember { mutableStateOf("ask") }
    var misfireGrace by remember { mutableStateOf("") }
    var suggestions by remember { mutableStateOf<List<String>>(emptyList()) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(editId == null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(api, editId, reloadKey) {
        if (editId == null) return@LaunchedEffect
        loadError = null
        try {
            val s = api.schedule(editId)
            name = s.name
            prompt = s.prompt
            useCron = s.cron != null || s.at == null
            cron = s.cron ?: ""
            at = s.at ?: ""
            tz = s.tz
            cwd = s.cwd
            model = s.model ?: ""
            approvalMode = s.approvalMode ?: "ask"
            misfireGrace = s.misfireGrace ?: ""
            loaded = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadError = e.message ?: e.toString()
        }
    }

    LaunchedEffect(api) {
        try {
            val c = api.cwds()
            suggestions = (c.roots + c.recent).distinct().take(8)
            if (editId == null && cwd.isBlank()) cwd = c.roots.firstOrNull() ?: ""
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    val timingValue = if (useCron) cron else at
    val canSubmit = name.isNotBlank() && cwd.isNotBlank() && prompt.isNotBlank() && timingValue.isNotBlank() && loaded && !submitting

    Surface(color = ToborColors.bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().imePadding().fillMaxSize()) {
            StripeBand(Modifier.fillMaxWidth())
            Row(
                Modifier.fillMaxWidth().padding(end = 16.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = ToborColors.fg)
                }
                Text(
                    if (editId == null) "new schedule" else "edit schedule",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                )
            }

            if (!loaded) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    val loadMessage = loadError
                    if (loadMessage == null) {
                        CircularProgressIndicator(
                            modifier = Modifier.align(Alignment.Center).size(24.dp),
                            color = ToborColors.gold,
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Column(
                            Modifier.align(Alignment.Center).padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Text(
                                loadMessage,
                                color = ToborColors.error,
                                fontFamily = FontFamilies.CourierPrime,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                            )
                            OutlinedButton(
                                onClick = { reloadKey++ },
                                shape = RoundedCornerShape(4.dp),
                                border = BorderStroke(1.dp, ToborColors.muted),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.fg),
                            ) {
                                Text("retry", fontFamily = FontFamilies.Righteous)
                            }
                        }
                    }
                }
            } else {
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    RuleLabel("name")
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("morning digest", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )

                    RuleLabel("when")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OptionChip("cron", useCron) { useCron = true }
                        OptionChip("one time", !useCron) { useCron = false }
                    }
                    if (useCron) {
                        OutlinedTextField(
                            value = cron,
                            onValueChange = { cron = it },
                            modifier = Modifier.fillMaxWidth(),
                            textStyle = fieldTextStyle,
                            singleLine = true,
                            placeholder = { Text("0 9 * * 1-5", style = fieldTextStyle) },
                            colors = toborFieldColors(),
                        )
                    } else {
                        OutlinedTextField(
                            value = at,
                            onValueChange = { at = it },
                            modifier = Modifier.fillMaxWidth(),
                            textStyle = fieldTextStyle,
                            singleLine = true,
                            placeholder = { Text("2026-12-01T09:00:00Z", style = fieldTextStyle) },
                            colors = toborFieldColors(),
                        )
                    }

                    RuleLabel("timezone")
                    OutlinedTextField(
                        value = tz,
                        onValueChange = { tz = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("host zone", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )

                    RuleLabel("cwd")
                    OutlinedTextField(
                        value = cwd,
                        onValueChange = { cwd = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("/path/to/project", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )
                    if (suggestions.isNotEmpty()) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            suggestions.forEach { s ->
                                OptionChip(
                                    text = s.trimEnd('/').substringAfterLast('/').ifEmpty { s },
                                    selected = cwd == s,
                                    onClick = { cwd = s },
                                )
                            }
                        }
                    }

                    RuleLabel("model")
                    OutlinedTextField(
                        value = model,
                        onValueChange = { model = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("node default", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )

                    RuleLabel("approval mode")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("ask", "auto").forEach { m ->
                            OptionChip(m, approvalMode == m) { approvalMode = m }
                        }
                    }

                    RuleLabel("misfire grace")
                    OutlinedTextField(
                        value = misfireGrace,
                        onValueChange = { misfireGrace = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("2h", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )

                    RuleLabel("prompt")
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        minLines = 4,
                        placeholder = { Text("what needs doing?", style = fieldTextStyle) },
                        colors = toborFieldColors(),
                    )

                    error?.let {
                        Text(
                            it,
                            color = ToborColors.error,
                            fontFamily = FontFamilies.CourierPrime,
                            fontSize = 12.sp,
                        )
                    }

                    Button(
                        onClick = {
                            submitting = true
                            error = null
                            scope.launch {
                                try {
                                    // The node rejects "" for tz/model/misfire_grace and null for any field, so a blank optional
                                    // field is omitted: on create it means the default, on edit it keeps the stored value.
                                    // Sending cron clears at and vice versa.
                                    if (editId == null) {
                                        api.createSchedule(
                                            CreateScheduleRequest(
                                                name = name.trim(),
                                                cwd = cwd.trim(),
                                                prompt = prompt.trim(),
                                                cron = if (useCron) cron.trim() else null,
                                                at = if (useCron) null else at.trim(),
                                                tz = tz.trim().ifEmpty { null },
                                                model = model.trim().ifEmpty { null },
                                                approvalMode = approvalMode,
                                                misfireGrace = misfireGrace.trim().ifEmpty { null },
                                            ),
                                        )
                                    } else {
                                        api.updateSchedule(
                                            editId,
                                            UpdateScheduleRequest(
                                                name = name.trim(),
                                                cwd = cwd.trim(),
                                                prompt = prompt.trim(),
                                                cron = if (useCron) cron.trim() else null,
                                                at = if (useCron) null else at.trim(),
                                                tz = tz.trim().ifEmpty { null },
                                                model = model.trim().ifEmpty { null },
                                                approvalMode = approvalMode,
                                                misfireGrace = misfireGrace.trim().ifEmpty { null },
                                            ),
                                        )
                                    }
                                    onDone()
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: ToborApiException) {
                                    error = e.message ?: "request failed"
                                } catch (e: Exception) {
                                    error = e.message ?: e.toString()
                                }
                                submitting = false
                            }
                        },
                        enabled = canSubmit,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        shape = RoundedCornerShape(4.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ToborColors.gold,
                            contentColor = ToborColors.bg,
                            disabledContainerColor = ToborColors.raised,
                            disabledContentColor = ToborColors.subtle,
                        ),
                    ) {
                        if (submitting) {
                            CircularProgressIndicator(
                                modifier = Modifier.padding(end = 8.dp).size(18.dp),
                                color = ToborColors.subtle,
                                strokeWidth = 2.dp,
                            )
                        }
                        Text(if (editId == null) "schedule it" else "save changes", fontFamily = FontFamilies.Righteous, fontSize = 16.sp)
                    }
                }
            }
        }
    }
}
