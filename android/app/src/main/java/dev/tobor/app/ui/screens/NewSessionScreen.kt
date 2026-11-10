package dev.tobor.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun NewSessionScreen(
    api: ToborApi,
    onCreated: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var cwd by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var approvalMode by remember { mutableStateOf("ask") }
    var mode by remember { mutableStateOf<String?>(null) }
    var suggestions by remember { mutableStateOf<List<String>>(emptyList()) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var modelMenu by remember { mutableStateOf(false) }

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
    LaunchedEffect(api) {
        try {
            val (ids, default) = api.modelIds()
            models = ids
            if (ids.isNotEmpty() && model.isEmpty()) model = default ?: ""
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    val canSubmit = cwd.isNotBlank() && prompt.isNotBlank() && !submitting

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
                    "new entry",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                )
            }

            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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
                if (models.isEmpty()) {
                    OutlinedTextField(
                        value = model,
                        onValueChange = { model = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = fieldTextStyle,
                        singleLine = true,
                        placeholder = { Text("node default", fontFamily = FontFamilies.CourierPrime) },
                        colors = toborFieldColors(),
                    )
                } else {
                    ExposedDropdownMenuBox(expanded = modelMenu, onExpandedChange = { modelMenu = it }) {
                        OutlinedTextField(
                            value = model,
                            onValueChange = {},
                            readOnly = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                            textStyle = fieldTextStyle,
                            singleLine = true,
                            placeholder = { Text("node default", fontFamily = FontFamilies.CourierPrime) },
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelMenu) },
                            colors = toborFieldColors(),
                        )
                        ExposedDropdownMenu(
                            expanded = modelMenu,
                            onDismissRequest = { modelMenu = false },
                            modifier = Modifier.background(ToborColors.raised),
                        ) {
                            models.forEach { id ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            id,
                                            fontFamily = FontFamilies.CourierPrime,
                                            fontSize = 13.sp,
                                            color = if (id == model) ToborColors.gold else ToborColors.fg,
                                        )
                                    },
                                    onClick = {
                                        model = id
                                        modelMenu = false
                                    },
                                )
                            }
                        }
                    }
                }

                RuleLabel("approval mode")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("ask", "auto").forEach { m ->
                        OptionChip(m, approvalMode == m) { approvalMode = m }
                    }
                }

                RuleLabel("mode")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("director", "solo").forEach { m ->
                        OptionChip(m, mode == m) { mode = if (mode == m) null else m }
                    }
                }

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
                                val id = api.createSession(
                                    cwd.trim(),
                                    prompt.trim(),
                                    model.trim().ifEmpty { null },
                                    null,
                                    approvalMode,
                                    mode,
                                )
                                onCreated(id)
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
                    Text("log it", fontFamily = FontFamilies.Righteous, fontSize = 16.sp)
                }
            }
        }
    }
}
