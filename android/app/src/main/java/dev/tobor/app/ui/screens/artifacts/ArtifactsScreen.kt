package dev.tobor.app.ui.screens.artifacts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.ArtifactSummary
import dev.tobor.app.api.ToborApi
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.StripeBand
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun ArtifactsScreen(
    api: ToborApi,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var artifacts by remember { mutableStateOf<List<ArtifactSummary>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var openError by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        try {
            artifacts = api.artifacts()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        }
    }

    LaunchedEffect(api) { load() }

    fun open(a: ArtifactSummary) {
        try {
            // LocalUriHandler is AppNav's ServerHostUriHandler: it swaps loopback/advertised hosts for the workspace host.
            uriHandler.openUri(a.url)
            openError = null
        } catch (e: Exception) {
            openError = e.message ?: "cannot open ${a.url}"
        }
    }

    Surface(color = ToborColors.bg, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.systemBarsPadding().fillMaxSize()) {
            StripeBand(Modifier.fillMaxWidth())
            Row(
                Modifier.fillMaxWidth().padding(end = 8.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = ToborColors.fg)
                }
                Text(
                    "Artifacts",
                    fontFamily = FontFamilies.Righteous,
                    fontSize = 24.sp,
                    color = ToborColors.gold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { scope.launch { load() } }) {
                    Icon(Icons.Default.Refresh, contentDescription = "refresh", tint = ToborColors.muted)
                }
            }
            HorizontalDivider(thickness = 1.dp, color = ToborColors.border)

            openError?.let {
                Text(
                    it,
                    color = ToborColors.error,
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { openError = null }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                val list = artifacts
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
                                "no artifacts yet",
                                fontFamily = FontFamilies.SpecialElite,
                                fontSize = 16.sp,
                                color = ToborColors.muted,
                            )
                        }
                    }
                    else -> {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(list, key = { it.projectId + "/" + it.slug }) { a ->
                                ArtifactRow(a, onClick = { open(a) })
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

@Composable
private fun ArtifactRow(a: ArtifactSummary, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                a.title.ifBlank { a.slug },
                fontFamily = FontFamilies.SpecialElite,
                fontSize = 15.sp,
                color = ToborColors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${a.projectId} / ${a.slug}",
                fontFamily = FontFamilies.CourierPrime,
                fontSize = 11.sp,
                color = ToborColors.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (a.latest.createdAt > 0) {
                Text(
                    "published ${formatTime(a.latest.createdAt)}",
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 11.sp,
                    color = ToborColors.subtle,
                )
            }
        }
        Tag("r${a.latest.revision.coerceAtLeast(a.revisions)}", ToborColors.gold)
    }
}
