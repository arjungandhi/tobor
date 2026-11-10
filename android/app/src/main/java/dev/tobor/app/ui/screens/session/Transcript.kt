package dev.tobor.app.ui.screens.session

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.EntryRecord
import dev.tobor.app.ui.markdown.MarkdownText
import dev.tobor.app.ui.markdown.linkifyUrls
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.SpecialElite
import dev.tobor.app.ui.theme.Tag
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

// ───────────────────────── model ─────────────────────────

internal data class RawEntry(val id: Long, val kind: String, val model0: JsonObject?)

internal fun EntryRecord.toRaw(): RawEntry = RawEntry(id, kind, model?.firstOrNull() as? JsonObject)

internal fun JsonObject.toRawOrNull(): RawEntry? {
    val id = (this["id"] as? JsonPrimitive)?.longOrNull ?: return null
    val kind = (this["kind"] as? JsonPrimitive)?.contentOrNull ?: "?"
    val model0 = (this["model"] as? JsonArray)?.firstOrNull() as? JsonObject
    return RawEntry(id, kind, model0)
}

internal sealed interface Block {
    data class Text(val text: String) : Block
    data class Thinking(val text: String) : Block
    data class Call(val name: String, val args: String) : Block
    data class Other(val label: String) : Block
    data class Image(val part: ImagePart) : Block
}

internal sealed interface Item {
    val key: String

    data class User(override val key: String, val text: String, val images: List<ImagePart> = emptyList()) : Item
    data class Assistant(
        override val key: String,
        val model: String,
        val blocks: List<Block>,
        val live: Boolean = false,
    ) : Item
    data class ToolResult(
        override val key: String,
        val name: String,
        val isError: Boolean,
        val text: String,
        val images: List<ImagePart> = emptyList(),
    ) : Item
    data class System(override val key: String, val text: String) : Item
    data class Divider(override val key: String, val label: String) : Item
    data class LiveTool(override val key: String, val name: String, val status: String, val output: String) : Item
    data class Failure(override val key: String, val reason: String, val detail: String?) : Item
    data class Queued(override val key: String, val mode: String, val text: String) : Item
}

// ───────────────────────── parsing ─────────────────────────

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

internal fun JsonElement?.present(): Boolean = this != null && this !is JsonNull

private fun parseBlocks(content: JsonElement?): List<Block> = when (content) {
    null, is JsonNull -> emptyList()
    is JsonPrimitive -> listOf(Block.Text(content.contentOrNull ?: ""))
    is JsonArray -> content.map { el ->
        runCatching {
            val o = el as? JsonObject ?: return@runCatching Block.Other(el.toString().take(80))
            when (val type = o["type"].str()) {
                "text" -> Block.Text(o["text"].str() ?: "")
                "thinking" -> Block.Thinking(o["thinking"].str() ?: o["text"].str() ?: "")
                "toolCall" -> Block.Call(
                    o["name"].str() ?: "tool",
                    (o["arguments"] ?: JsonNull).toString().replace('\n', ' '),
                )
                "image" -> imagePart(o)?.let { Block.Image(it) } ?: Block.Other("[image]")
                else -> Block.Other("[${type ?: "block"}]")
            }
        }.getOrElse { Block.Other("[unreadable block]") }
    }
    is JsonObject -> parseBlocks(JsonArray(listOf(content)))
}

private fun imagePart(o: JsonObject): ImagePart? {
    val data = o["data"].str()?.takeIf { it.isNotEmpty() } ?: return null
    return ImagePart(data, o["mimeType"].str() ?: "image")
}

/** Image parts of a message `content` array, in order. */
private fun imageParts(content: JsonElement?): List<ImagePart> =
    (content as? JsonArray)?.mapNotNull { el ->
        (el as? JsonObject)?.takeIf { it["type"].str() == "image" }?.let(::imagePart)
    }.orEmpty()

/** Flattens `content` to text. Image parts become "[image]" unless [imagePlaceholder] is false (callers that render them). */
private fun plainText(content: JsonElement?, imagePlaceholder: Boolean = true): String = when (content) {
    null, is JsonNull -> ""
    is JsonPrimitive -> content.contentOrNull ?: ""
    is JsonArray -> content.mapNotNull { el ->
        val o = el as? JsonObject
        when (o?.get("type").str()) {
            "text" -> o?.get("text").str() ?: ""
            "image" -> if (imagePlaceholder || imagePart(o!!) == null) "[image]" else null
            else -> "[${o?.get("type").str() ?: "block"}]"
        }
    }.joinToString("\n")
    is JsonObject -> content.toString()
}

private fun shortModel(m: String?): String {
    if (m.isNullOrBlank()) return ""
    return m.substringAfterLast('/').take(28)
}

internal fun RawEntry.toItem(): Item {
    val key = "e$id"
    return runCatching<Item> {
        val m = model0
        when (kind) {
            "pi.user" -> Item.User(key, plainText(m?.get("content"), imagePlaceholder = false), imageParts(m?.get("content")))
            "pi.assistant" -> Item.Assistant(key, shortModel(m?.get("model").str()), parseBlocks(m?.get("content")))
            "pi.tool-result" -> Item.ToolResult(
                key,
                m?.get("toolName").str() ?: "tool",
                (m?.get("isError") as? JsonPrimitive)?.booleanOrNull ?: false,
                plainText(m?.get("content"), imagePlaceholder = false),
                imageParts(m?.get("content")),
            )
            "pi.system" -> Item.System(key, plainText(m?.get("content")))
            "pi.reset" -> Item.Divider(key, "— reset —")
            "pi.compaction" -> Item.Divider(key, "— compaction —")
            else -> Item.Divider(key, "— $kind —")
        }
    }.getOrElse { Item.Divider(key, "— unreadable entry —") }
}

/** Builds the live tail (partial assistant message, running tool slots, run failure) from docs["pi.live"]. */
internal fun liveItems(live: JsonObject?): List<Item> {
    if (live == null) return emptyList()
    val out = mutableListOf<Item>()
    runCatching {
        val msg = (live["generation"] as? JsonObject)?.get("message") as? JsonObject
        if (msg != null) {
            val blocks = parseBlocks(msg["content"])
            if (blocks.isNotEmpty()) out += Item.Assistant("live-msg", shortModel(msg["model"].str()), blocks, live = true)
        }
    }
    runCatching {
        (live["tools"] as? JsonArray)?.forEachIndexed { i, el ->
            val o = el as? JsonObject ?: return@forEachIndexed
            val out0 = o["output"]
            val output = when (out0) {
                null, is JsonNull -> ""
                is JsonPrimitive -> out0.contentOrNull ?: ""
                else -> plainText(out0).ifBlank { out0.toString() }
            }
            out += Item.LiveTool(
                "live-tool-${o["callId"].str() ?: i}",
                o["name"].str() ?: "tool",
                o["status"].str() ?: "running",
                output,
            )
        }
    }
    runCatching {
        val f = live["runFailure"] as? JsonObject
        if (f != null) out += Item.Failure("live-failure", f["reason"].str() ?: "run failed", f["detail"].str())
    }
    return out
}

/** Pending steer/follow-up messages from docs["pi.inbox"]; "write" items are not user messages and are dropped. */
internal fun queuedItems(docs: JsonObject?): List<Item> {
    val items = ((docs?.get("pi.inbox") as? JsonObject)?.get("items") as? JsonArray) ?: return emptyList()
    return runCatching {
        items.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val mode = o["mode"].str()
            if (mode != "steer" && mode != "followUp") return@mapNotNull null
            val id = o["id"].str() ?: return@mapNotNull null
            Item.Queued("q:$id", mode, plainText(o["content"]))
        }
    }.getOrElse { emptyList() }
}

// ───────────────────────── composables ─────────────────────────

private fun clip(s: String, max: Int): String =
    if (s.length <= max) s else s.take(max) + "\n… (${s.length - max} more chars)"

@Composable
internal fun TranscriptItem(item: Item) {
    when (item) {
        is Item.User -> UserCard(item)
        is Item.Assistant -> AssistantBlock(item)
        is Item.ToolResult -> ToolResultCard(item)
        is Item.System -> SystemLine(item)
        is Item.Divider -> Text(
            item.label,
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            textAlign = TextAlign.Center,
            color = ToborColors.subtle,
            fontFamily = SpecialElite,
            fontSize = 12.sp,
        )
        is Item.LiveTool -> LiveToolCard(item)
        is Item.Queued -> QueuedCard(item)
        is Item.Failure -> Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp)
                .border(1.5.dp, ToborColors.error, RoundedCornerShape(4.dp))
                .background(ToborColors.surface, RoundedCornerShape(4.dp))
                .padding(10.dp),
        ) {
            Text("run failed · ${item.reason}", color = ToborColors.error, fontFamily = SpecialElite, fontSize = 12.sp)
            if (!item.detail.isNullOrBlank()) {
                Text(
                    clip(item.detail, 1500),
                    color = ToborColors.muted,
                    fontFamily = CourierPrime,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun QueuedCard(item: Item.Queued) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .alpha(0.6f)
            .background(ToborColors.raised, RoundedCornerShape(4.dp))
            .padding(10.dp),
    ) {
        Text(
            "queued · ${if (item.mode == "followUp") "follow-up" else "steer"}",
            color = ToborColors.subtle,
            fontFamily = SpecialElite,
            fontSize = 10.sp,
        )
        Text(
            clip(item.text, 8000),
            color = ToborColors.muted,
            fontFamily = CourierPrime,
            fontSize = 14.sp,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

@Composable
private fun UserCard(item: Item.User) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(ToborColors.raised, RoundedCornerShape(4.dp))
            .padding(10.dp),
    ) {
        Text("operator", color = ToborColors.gold, fontFamily = SpecialElite, fontSize = 10.sp)
        if (item.text.isNotEmpty() || item.images.isEmpty()) {
            Text(
                clip(item.text, 8000),
                color = ToborColors.fg,
                fontFamily = CourierPrime,
                fontSize = 14.sp,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        item.images.forEach { TranscriptImage(it, Modifier.padding(top = 4.dp)) }
    }
}

@Composable
private fun AssistantBlock(item: Item.Assistant) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (item.model.isBlank()) "tobor" else "tobor · ${item.model}",
                color = ToborColors.gold,
                fontFamily = SpecialElite,
                fontSize = 10.sp,
            )
            if (item.live) Tag("live", ToborColors.gold)
        }
        item.blocks.forEach { b ->
            when (b) {
                is Block.Text -> if (b.text.isNotEmpty()) MarkdownText(b.text)
                is Block.Thinking -> ThinkingRow(b.text)
                is Block.Call -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("→ ${b.name}", color = ToborColors.gold, fontFamily = SpecialElite, fontSize = 12.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        b.args,
                        modifier = Modifier.weight(1f),
                        color = ToborColors.muted,
                        fontFamily = CourierPrime,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                is Block.Image -> TranscriptImage(b.part)
                is Block.Other -> Text(b.label, color = ToborColors.subtle, fontFamily = SpecialElite, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun ThinkingRow(text: String) {
    var open by remember { mutableStateOf(false) }
    Text(
        if (open) text else "thinking …",
        modifier = Modifier.fillMaxWidth().clickable { open = !open },
        color = ToborColors.muted,
        fontFamily = CourierPrime,
        fontStyle = FontStyle.Italic,
        fontSize = 13.sp,
    )
}

@Composable
private fun CardShell(
    borderColor: Color,
    borderWidth: androidx.compose.ui.unit.Dp,
    header: @Composable () -> Unit,
    body: String?,
    bodyMuted: Color = ToborColors.muted,
    bodySize: Int = 12,
    onToggle: (() -> Unit)? = null,
    expanded: Boolean = false,
    linkify: Boolean = false,
) {
    val shape = RoundedCornerShape(4.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .border(borderWidth, borderColor, shape)
            .background(ToborColors.surface, shape)
            .let { if (onToggle != null) it.clickable { onToggle() } else it }
            .padding(10.dp),
    ) {
        header()
        if (expanded && body != null) {
            Text(
                if (linkify) remember(body) { linkifyUrls(body) } else AnnotatedString(body),
                color = bodyMuted,
                fontFamily = CourierPrime,
                fontSize = bodySize.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun ToolResultCard(item: Item.ToolResult) {
    var open by remember { mutableStateOf(false) }
    Column {
        CardShell(
            borderColor = if (item.isError) ToborColors.error else ToborColors.border,
            borderWidth = 1.dp,
            header = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        item.name,
                        modifier = Modifier.weight(1f),
                        color = ToborColors.fg,
                        fontFamily = SpecialElite,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (item.isError) Tag("err", ToborColors.error) else Tag("ok", ToborColors.success)
                    Text(if (open) "▾" else "▸", color = ToborColors.muted, fontSize = 12.sp)
                }
            },
            body = clip(item.text.ifEmpty { if (item.images.isEmpty()) "(empty)" else "(image)" }, 4000),
            onToggle = { open = !open },
            expanded = open,
            linkify = true,
        )
        item.images.forEach { TranscriptImage(it, Modifier.padding(vertical = 4.dp)) }
    }
}

@Composable
private fun SystemLine(item: Item.System) {
    var open by remember { mutableStateOf(false) }
    Text(
        if (open) clip(item.text, 2000) else "system prompt · tap",
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).clickable { open = !open },
        color = ToborColors.subtle,
        fontFamily = if (open) CourierPrime else SpecialElite,
        fontSize = if (open) 11.sp else 12.sp,
    )
}

@Composable
private fun LiveToolCard(item: Item.LiveTool) {
    val s = item.status.lowercase()
    val color = when {
        s.contains("err") || s.contains("fail") -> ToborColors.error
        s.contains("done") || s.contains("complete") || s == "ok" || s.contains("success") -> ToborColors.success
        else -> ToborColors.gold
    }
    val running = color == ToborColors.gold
    val pulse = if (running) {
        val t = rememberInfiniteTransition(label = "pulse")
        t.animateFloat(
            0.45f, 1f,
            infiniteRepeatable(tween(500), RepeatMode.Reverse),
            label = "pulseAlpha",
        ).value
    } else 1f
    CardShell(
        borderColor = color,
        borderWidth = 1.5.dp,
        header = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "→ ${item.name}",
                    modifier = Modifier.weight(1f),
                    color = ToborColors.gold,
                    fontFamily = SpecialElite,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Box(Modifier.alpha(pulse)) { Tag(item.status, color) }
            }
        },
        body = if (item.output.isBlank()) null else item.output.takeLast(600),
        bodySize = 11,
        expanded = true,
    )
}
