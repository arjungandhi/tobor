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
import dev.tobor.app.api.ToborApiException
import dev.tobor.app.api.Whoami
import dev.tobor.app.update.AppUpdater
import dev.tobor.app.data.SettingsStore
import dev.tobor.app.data.Workspace
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.RuleLabel
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.ToborColors
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    api: ToborApi,
    store: SettingsStore,
    updater: AppUpdater,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val activeIdx = store.activeIndexFlow.collectAsState().value

    // ── node info / upgrade / restart ──
    var node by remember { mutableStateOf<Whoami?>(null) }
    var nodeError by remember { mutableStateOf<String?>(null) }
    var nodeNote by remember { mutableStateOf<String?>(null) }
    var nodeBusy by remember { mutableStateOf(false) }
    var confirmNode by remember { mutableStateOf<String?>(null) } // "upgrade" | "restart"

    suspend fun refreshNode() {
        try {
            node = api.whoami()
            nodeError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            nodeError = e.message ?: e.toString()
        }
    }

    // Reload when the active workspace changes (api.baseUrl is updated by AppNav's own effect, so re-point it here too).
    LaunchedEffect(activeIdx) {
        api.baseUrl = store.baseUrl
        node = null
        nodeNote = null
        refreshNode()
    }

    /** After upgrade/restart the node drops the connection: poll whoami with backoff until it answers again. */
    fun awaitNode(previousVersion: String?) {
        nodeBusy = true
        nodeNote = "node restarting…"
        scope.launch {
            var wait = 1500L
            var sawDown = false
            delay(2000) // let the node begin shutting down before the first probe
            var back = false
            for (attempt in 1..12) {
                try {
                    val w = api.whoami()
                    // Success only counts once we saw it go away, or the version visibly changed.
                    if (sawDown || (previousVersion != null && w.version != previousVersion)) {
                        node = w
                        nodeError = null
                        back = true
                        break
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    sawDown = true
                    nodeNote = "node restarting… (retry $attempt)"
                }
                delay(wait)
                wait = (wait * 2).coerceAtMost(10_000)
            }
            nodeNote = if (back) "node is back · v${node?.version}" else "node did not come back yet: check again"
            nodeBusy = false
            if (back) refreshNode()
        }
    }

    fun runNodeAction(action: String) {
        val before = node?.version
        nodeBusy = true
        nodeError = null
        nodeNote = null
        scope.launch {
            try {
                if (action == "upgrade") {
                    val r = api.upgrade()
                    if (r.status == "current") {
                        nodeNote = "already on the latest version (v${r.version})"
                        nodeBusy = false
                        refreshNode()
                        return@launch
                    }
                    awaitNode(before)
                } else {
                    api.restart()
                    awaitNode(null)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ToborApiException) {
                nodeError = if (e.code == "unsupported") "this node runs from source and cannot self-upgrade" else (e.message ?: e.toString())
                nodeBusy = false
            } catch (e: Exception) {
                // The node may drop the connection before it finishes answering: treat as restarting.
                awaitNode(before)
            }
        }
    }

    confirmNode?.let { action ->
        ConfirmDialog(
            title = if (action == "upgrade") "upgrade node" else "restart node",
            message = if (action == "upgrade") {
                "Download v${node?.latestVersion ?: "latest"} and restart ${store.active.name}? Running sessions are interrupted."
            } else {
                "Restart ${store.active.name}? The connection will drop briefly."
            },
            confirmLabel = action,
            destructive = true,
            onConfirm = { confirmNode = null; runNodeAction(action) },
            onDismiss = { confirmNode = null },
        )
    }
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

                RuleLabel("node")
                val nodeShape = RoundedCornerShape(4.dp)
                val n = node
                Column(
                    Modifier.fillMaxWidth()
                        .background(ToborColors.surface, nodeShape)
                        .border(1.dp, ToborColors.border, nodeShape)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        when {
                            n != null -> "host · ${n.host}\nversion · v${n.version}" +
                                (n.latestVersion?.let { "\nlatest · v${it.removePrefix("v")}" } ?: "")
                            nodeError != null -> "unreachable"
                            else -> "loading…"
                        },
                        fontFamily = FontFamilies.SpecialElite,
                        fontSize = 14.sp,
                        color = if (n == null && nodeError != null) ToborColors.error else ToborColors.fg,
                    )
                    if (n?.updateAvailable == true) Tag("update available", color = ToborColors.gold, filled = true)
                    nodeNote?.let {
                        Text(it, fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.muted)
                    }
                    nodeError?.let {
                        Text(it, fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.error)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedAction("upgrade", enabled = !nodeBusy && n != null) { confirmNode = "upgrade" }
                    OutlinedAction("restart", enabled = !nodeBusy && n != null) { confirmNode = "restart" }
                    OutlinedAction("refresh", enabled = !nodeBusy) { scope.launch { refreshNode() } }
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

                RuleLabel("app")
                Text(
                    "tobor android · v${updater.currentVersion}",
                    fontFamily = FontFamilies.SpecialElite,
                    fontSize = 14.sp,
                    color = ToborColors.fg,
                )
                updater.status?.let {
                    Text(it, fontFamily = FontFamilies.CourierPrime, fontSize = 12.sp, color = ToborColors.muted)
                }
                OutlinedAction("check for updates", enabled = !updater.busy) {
                    scope.launch { updater.check(manual = true) }
                }
            }
        }
    }
}
