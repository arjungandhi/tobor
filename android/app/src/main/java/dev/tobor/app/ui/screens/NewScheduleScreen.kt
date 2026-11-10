package dev.tobor.app.ui.screens

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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.CreateScheduleRequest
import dev.tobor.app.api.ToborApi
import dev.tobor.app.api.ToborApiException
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

private val fieldTextStyle = TextStyle(fontFamily = FontFamilies.CourierPrime, fontSize = 14.sp)

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
fun NewScheduleScreen(
    api: ToborApi,
    onCreated: () -> Unit,
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

    LaunchedEffect(api) {
        try {
            val c = api.cwds()
            suggestions = (c.roots + c.recent).distinct().take(8)
            if (cwd.isBlank()) cwd = c.roots.firstOrNull() ?: ""
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    val timingValue = if (useCron) cron else at
    val canSubmit = name.isNotBlank() && cwd.isNotBlank() && prompt.isNotBlank() && timingValue.isNotBlank() && !submitting

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
                    "new schedule",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                )
            }

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
                    placeholder = { Text("morning digest", fontFamily = FontFamilies.CourierPrime) },
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
                        placeholder = { Text("0 9 * * 1-5", fontFamily = FontFamilies.CourierPrime) },
                        colors = toborFieldColors(),
                    )
                } else {
                    OutlinedTextField(
                        value = at,
                        onValueChange = { at = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("2026-12-01T09:00:00Z", fontFamily = FontFamilies.CourierPrime) },
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
                    placeholder = { Text("host zone", fontFamily = FontFamilies.CourierPrime) },
                    colors = toborFieldColors(),
                )

                RuleLabel("cwd")
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = fieldTextStyle,
                    singleLine = true,
                    placeholder = { Text("/path/to/project", fontFamily = FontFamilies.CourierPrime) },
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
                    placeholder = { Text("node default", fontFamily = FontFamilies.CourierPrime) },
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
                    placeholder = { Text("2h", fontFamily = FontFamilies.CourierPrime) },
                    colors = toborFieldColors(),
                )

                RuleLabel("prompt")
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = fieldTextStyle,
                    minLines = 4,
                    placeholder = { Text("what needs doing?", fontFamily = FontFamilies.CourierPrime) },
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
                                onCreated()
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
                    Text("schedule it", fontFamily = FontFamilies.Righteous, fontSize = 16.sp)
                }
            }
        }
    }
}
