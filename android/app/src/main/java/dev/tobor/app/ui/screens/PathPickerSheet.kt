package dev.tobor.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.PathCompleteEntry
import dev.tobor.app.api.ToborApi
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.ToborColors
import dev.tobor.app.ui.theme.fieldTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Searchable path picker opened by typing `@` in the composer. The top field holds the raw path prefix (empty lists
 * the session cwd); rows below come from `api.complete`. [onInsert] receives the picked path exactly as navigated;
 * [onDismiss] is called when the sheet is closed without a pick. Both fire after the sheet has animated away.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PathPickerSheet(
    api: ToborApi,
    sessionId: Long,
    onInsert: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var field by remember { mutableStateOf(TextFieldValue("")) }
    var entries by remember { mutableStateOf<List<PathCompleteEntry>>(emptyList()) }
    // The prefix `entries` were fetched for; row actions are relative to it, not to the (possibly newer) field text.
    var fetchedPrefix by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val prefix = field.text

    LaunchedEffect(api, sessionId, prefix) {
        loading = true
        delay(150)
        try {
            val r = api.complete(sessionId, prefix)
            entries = r.entries
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            entries = emptyList()
            error = e.message ?: e::class.simpleName
        }
        fetchedPrefix = prefix
        loading = false
    }

    fun close(then: () -> Unit) {
        scope.launch {
            // finally: the sheet may leave composition mid-animation (cancelling this scope); the pick must still land.
            try {
                sheetState.hide()
            } finally {
                then()
            }
        }
    }
    fun navigate(to: String) {
        field = TextFieldValue(to, TextRange(to.length))
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ToborColors.surface,
        contentColor = ToborColors.fg,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.6f)
                .navigationBarsPadding()
                .padding(horizontal = 12.dp),
        ) {
            OutlinedTextField(
                value = field,
                onValueChange = { field = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = fieldTextStyle(color = ToborColors.fg),
                placeholder = { Text("path (empty = session cwd)", color = ToborColors.subtle, style = fieldTextStyle()) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (prefix.isNotEmpty()) close { onInsert(prefix) } }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = ToborColors.fg,
                    unfocusedTextColor = ToborColors.fg,
                    focusedBorderColor = ToborColors.gold,
                    unfocusedBorderColor = ToborColors.border,
                    cursorColor = ToborColors.gold,
                ),
            )
            val parent = parentPrefix(fetchedPrefix)
            when {
                entries.isEmpty() && parent == null -> StatusLine(
                    when {
                        loading -> "loading…"
                        error != null -> "couldn't list: $error"
                        else -> "no matches"
                    },
                )
                else -> LazyColumn(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    if (parent != null) {
                        item(key = "..") { PathRow("../", onClick = { navigate(parent) }) }
                    }
                    if (entries.isEmpty()) {
                        item(key = "status") {
                            StatusLine(if (loading) "loading…" else if (error != null) "couldn't list: $error" else "no matches")
                        }
                    }
                    items(entries, key = { it.type + it.name }) { e ->
                        val isDir = e.type == "dir"
                        val path = entryPath(fetchedPrefix, e.name, isDir)
                        PathRow(
                            label = if (isDir) e.name + "/" else e.name,
                            onClick = { if (isDir) navigate(path) else close { onInsert(path) } },
                            onInsert = if (isDir) ({ close { onInsert(path) } }) else null,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusLine(text: String) {
    Text(
        text,
        color = ToborColors.subtle,
        fontFamily = CourierPrime,
        fontSize = 12.sp,
        modifier = Modifier.padding(vertical = 12.dp, horizontal = 4.dp),
    )
}

@Composable
private fun PathRow(label: String, onClick: () -> Unit, onInsert: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick)
            .padding(start = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            color = if (label.endsWith("/")) ToborColors.gold else ToborColors.fg,
            fontFamily = CourierPrime,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
        )
        if (onInsert != null) {
            IconButton(onClick = onInsert) {
                Icon(Icons.Filled.Add, contentDescription = "insert $label", tint = ToborColors.muted)
            }
        }
    }
}
