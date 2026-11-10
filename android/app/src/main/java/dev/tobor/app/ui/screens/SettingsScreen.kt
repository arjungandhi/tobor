package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.ToborApi
import dev.tobor.app.data.SettingsStore
import dev.tobor.app.data.Workspace
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.RuleLabel
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    api: ToborApi,
    store: SettingsStore,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var editingIndex by remember { mutableStateOf<Int?>(null) }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }
    var resultText by remember { mutableStateOf<String?>(null) }
    var resultError by remember { mutableStateOf<String?>(null) }

    fun normalizeUrl(u: String): String {
        val trimmed = u.trim().trimEnd('/')
        return if (trimmed.isNotEmpty() && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            "http://$trimmed"
        } else {
            trimmed
        }
    }

    fun resetForm() {
        editingIndex = null
        name = ""
        url = ""
        saved = false
        resultText = null
        resultError = null
    }

    Surface(color = ToborColors.bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().fillMaxSize()) {
            StripeBand(Modifier.fillMaxWidth())
            Row(
                Modifier.fillMaxWidth().padding(end = 16.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = ToborColors.fg)
                }
                Text(
                    "settings",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                )
            }

            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                RuleLabel("workspaces")

                // List of workspaces
                val workspaces = store.workspaces
                val activeIndex = store.activeIndexFlow.collectAsState().value
                for (index in workspaces.indices) {
                    val workspace = workspaces[index]
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(ToborColors.surface, RoundedCornerShape(4.dp))
                            .border(
                                1.dp,
                                if (index == activeIndex) ToborColors.gold.copy(alpha = 0.5f) else ToborColors.border,
                                RoundedCornerShape(4.dp),
                            )
                            .clickable {
                                if (index != activeIndex) {
                                    store.setActive(index)
                                }
                            }
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    workspace.name,
                                    fontFamily = FontFamilies.SpecialElite,
                                    fontSize = 14.sp,
                                    color = ToborColors.fg,
                                )
                                if (index == activeIndex) {
                                    Tag("active", color = ToborColors.gold, filled = true)
                                }
                            }
                            Text(
                                workspace.baseUrl,
                                fontFamily = FontFamilies.CourierPrime,
                                fontSize = 11.sp,
                                color = ToborColors.muted,
                            )
                        }
                        IconButton(
                            onClick = {
                                editingIndex = index
                                name = workspace.name
                                url = workspace.baseUrl
                                saved = false
                                resultText = null
                                resultError = null
                            },
                        ) {
                            Icon(Icons.Default.Edit, contentDescription = "edit", tint = ToborColors.muted)
                        }
                        IconButton(
                            onClick = { store.remove(index) },
                            enabled = workspaces.size > 1 && index != activeIndex,
                        ) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "delete",
                                tint = if (workspaces.size > 1 && index != activeIndex) ToborColors.error else ToborColors.subtle,
                            )
                        }
                    }
                }

                RuleLabel("add / edit")

                OutlinedTextField(
                    value = name,
                    onValueChange = {
                        name = it
                        saved = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = TextStyle(fontFamily = FontFamilies.SpecialElite, fontSize = 14.sp),
                    singleLine = true,
                    placeholder = { Text("workspace name", fontFamily = FontFamilies.SpecialElite) },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = ToborColors.fg,
                        unfocusedTextColor = ToborColors.fg,
                        focusedBorderColor = ToborColors.gold,
                        unfocusedBorderColor = ToborColors.border,
                        cursorColor = ToborColors.gold,
                        focusedContainerColor = ToborColors.sunken,
                        unfocusedContainerColor = ToborColors.sunken,
                        focusedPlaceholderColor = ToborColors.subtle,
                        unfocusedPlaceholderColor = ToborColors.subtle,
                    ),
                )

                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        saved = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = TextStyle(fontFamily = FontFamilies.CourierPrime, fontSize = 14.sp),
                    singleLine = true,
                    placeholder = { Text("http://127.0.0.1:7879", fontFamily = FontFamilies.CourierPrime) },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = ToborColors.fg,
                        unfocusedTextColor = ToborColors.fg,
                        focusedBorderColor = ToborColors.gold,
                        unfocusedBorderColor = ToborColors.border,
                        cursorColor = ToborColors.gold,
                        focusedContainerColor = ToborColors.sunken,
                        unfocusedContainerColor = ToborColors.sunken,
                        focusedPlaceholderColor = ToborColors.subtle,
                        unfocusedPlaceholderColor = ToborColors.subtle,
                    ),
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = {
                            testing = true
                            resultText = null
                            resultError = null
                            scope.launch {
                                try {
                                    val testApi = ToborApi(normalizeUrl(url))
                                    val w = testApi.whoami()
                                    resultText = "host · ${w.host}\nversion · ${w.version}"
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    resultError = e.message ?: e.toString()
                                }
                                testing = false
                            }
                        },
                        enabled = !testing && url.isNotBlank(),
                        shape = RoundedCornerShape(4.dp),
                        border = BorderStroke(1.dp, ToborColors.muted),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.fg),
                    ) {
                        Text(
                            if (testing) "testing…" else "test",
                            fontFamily = FontFamilies.Righteous,
                            fontSize = 14.sp,
                        )
                    }
                    Button(
                        onClick = {
                            val normalizedUrl = normalizeUrl(url)
                            val workspace = Workspace(name, normalizedUrl)
                            val idx = editingIndex
                            if (idx != null) {
                                store.update(idx, workspace)
                            } else {
                                store.add(workspace)
                            }
                            saved = true
                            resetForm()
                        },
                        enabled = name.isNotBlank() && url.isNotBlank(),
                        shape = RoundedCornerShape(4.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ToborColors.gold,
                            contentColor = ToborColors.bg,
                        ),
                    ) {
                        Text(
                            if (editingIndex != null) "update" else "save",
                            fontFamily = FontFamilies.Righteous,
                            fontSize = 14.sp,
                        )
                    }
                }

                if (saved) {
                    Text(
                        "saved.",
                        fontFamily = FontFamilies.SpecialElite,
                        fontSize = 12.sp,
                        color = ToborColors.success,
                    )
                }

                val shape = RoundedCornerShape(4.dp)
                resultText?.let {
                    Text(
                        it,
                        fontFamily = FontFamilies.SpecialElite,
                        fontSize = 14.sp,
                        color = ToborColors.fg,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(ToborColors.surface, shape)
                            .border(1.dp, ToborColors.success, shape)
                            .padding(12.dp),
                    )
                }
                resultError?.let {
                    Text(
                        it,
                        fontFamily = FontFamilies.CourierPrime,
                        fontSize = 13.sp,
                        color = ToborColors.error,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(ToborColors.surface, shape)
                            .border(1.dp, ToborColors.error, shape)
                            .padding(12.dp),
                    )
                }
            }
        }
    }
}
