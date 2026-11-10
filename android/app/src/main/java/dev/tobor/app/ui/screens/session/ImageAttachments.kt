package dev.tobor.app.ui.screens.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.ImageAttachment
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.ToborColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException

/** Wire limits: at most [MAX_IMAGE_ATTACHMENTS] per message, each at most [MAX_IMAGE_BYTES] decoded. */
internal const val MAX_IMAGE_ATTACHMENTS = 8
internal const val MAX_IMAGE_BYTES = 5 * 1024 * 1024

private val ALLOWED_MIME = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
private const val THUMB_DIM = 160
private const val TRANSCRIPT_DIM = 1280

// ───────────────────────── decoding ─────────────────────────

/** Decodes [bytes] downsampled (power-of-two `inSampleSize`) so neither side exceeds [maxDim]; null on failure. */
internal fun decodeSampledBitmap(bytes: ByteArray, maxDim: Int): Bitmap? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        null
    } else {
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxDim) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
} catch (_: Exception) {
    null
} catch (_: OutOfMemoryError) {
    null
}

// ───────────────────────── pending attachments (composer state) ─────────────────────────

internal class PendingImage(val id: Long, val attachment: ImageAttachment, val thumb: ImageBitmap?)

/** Images picked for the next message. Holds base64 payloads until [clear] (after a successful send). */
@Stable
internal class PendingImages {
    var items by mutableStateOf<List<PendingImage>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    private var nextId = 0L

    val attachments: List<ImageAttachment> get() = items.map { it.attachment }

    fun remove(id: Long) {
        items = items.filter { it.id != id }
    }

    fun clear() {
        items = emptyList()
    }

    /** Reads and validates [uris]; returns a user-visible problem summary, or null when all were added. */
    suspend fun add(resolver: ContentResolver, uris: List<Uri>): String? {
        if (uris.isEmpty()) return null
        val room = MAX_IMAGE_ATTACHMENTS - items.size
        if (room <= 0) return "max $MAX_IMAGE_ATTACHMENTS images per message"
        loading = true
        try {
            val problems = mutableListOf<String>()
            if (uris.size > room) problems += "max $MAX_IMAGE_ATTACHMENTS images per message; ${uris.size - room} skipped"
            for ((i, uri) in uris.take(room).withIndex()) {
                val (image, problem) = withContext(Dispatchers.IO) { readImage(resolver, uri, nextId++) }
                if (image != null) items = items + image else problems += "photo ${i + 1}: $problem"
            }
            return problems.takeIf { it.isNotEmpty() }?.joinToString("; ")
        } finally {
            loading = false
        }
    }
}

private fun readImage(resolver: ContentResolver, uri: Uri, id: Long): Pair<PendingImage?, String?> {
    val mime = resolver.getType(uri)?.lowercase()
    if (mime == null || mime !in ALLOWED_MIME) {
        return null to "unsupported type (${mime ?: "unknown"}); use png, jpeg, gif or webp"
    }
    val bytes = try {
        val stream = resolver.openInputStream(uri) ?: return null to "could not be read"
        stream.use { s ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_IMAGE_BYTES) return null to "too large (max 5 MB)"
            }
            out.toByteArray()
        }
    } catch (e: IOException) {
        return null to "could not be read"
    } catch (e: SecurityException) {
        return null to "could not be read"
    }
    if (bytes.isEmpty()) return null to "is empty"
    val thumb = decodeSampledBitmap(bytes, THUMB_DIM)?.asImageBitmap()
    val data = Base64.encodeToString(bytes, Base64.NO_WRAP)
    return PendingImage(id, ImageAttachment(data = data, mimeType = mime), thumb) to null
}

// ───────────────────────── composer UI ─────────────────────────

/**
 * Attach button: opens the system photo picker (multiple, capped at [MAX_IMAGE_ATTACHMENTS] in total with what is
 * already pending). [onProblem] receives a message for rejected files, or null when everything was accepted.
 */
@Composable
internal fun AttachImageButton(
    pending: PendingImages,
    onProblem: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGE_ATTACHMENTS),
    ) { uris ->
        if (uris.isNotEmpty()) scope.launch { onProblem(pending.add(context.contentResolver, uris)) }
    }
    IconButton(
        onClick = {
            launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        enabled = !pending.loading && pending.items.size < MAX_IMAGE_ATTACHMENTS,
        modifier = modifier,
    ) {
        Icon(
            Icons.Default.AddPhotoAlternate,
            contentDescription = "attach images",
            tint = if (pending.items.size < MAX_IMAGE_ATTACHMENTS) ToborColors.gold else ToborColors.subtle,
        )
    }
}

/** Thumbnails of pending attachments with a remove affordance; renders nothing when there are none. */
@Composable
internal fun PendingImagesRow(pending: PendingImages, modifier: Modifier = Modifier) {
    if (pending.items.isEmpty() && !pending.loading) return
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        pending.items.forEach { p ->
            val shape = RoundedCornerShape(4.dp)
            Box(Modifier.padding(top = 6.dp, end = 6.dp)) {
                Box(
                    Modifier
                        .size(56.dp)
                        .clip(shape)
                        .border(1.dp, ToborColors.border, shape)
                        .background(ToborColors.raised),
                    contentAlignment = Alignment.Center,
                ) {
                    if (p.thumb != null) {
                        Image(
                            p.thumb,
                            contentDescription = "attached image",
                            modifier = Modifier.size(56.dp),
                            contentScale = ContentScale.Crop,
                        )
                    } else {
                        Text("img", color = ToborColors.subtle, fontFamily = CourierPrime, fontSize = 11.sp)
                    }
                }
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .size(20.dp)
                        .background(ToborColors.bg, CircleShape)
                        .border(1.dp, ToborColors.muted, CircleShape)
                        .clickable { pending.remove(p.id) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "remove image",
                        tint = ToborColors.fg,
                        modifier = Modifier.size(12.dp),
                    )
                }
            }
        }
        if (pending.loading) {
            Text("reading…", color = ToborColors.muted, fontFamily = CourierPrime, fontSize = 11.sp)
        }
        Text(
            "${pending.items.size}/$MAX_IMAGE_ATTACHMENTS",
            color = ToborColors.subtle,
            fontFamily = CourierPrime,
            fontSize = 11.sp,
        )
    }
}

// ───────────────────────── transcript image ─────────────────────────

/** An image content part from a message (`{type:"image", data, mimeType}`). */
internal data class ImagePart(val data: String, val mimeType: String)

private sealed interface ImageState {
    data object Loading : ImageState
    data object Failed : ImageState
    class Ready(val bitmap: ImageBitmap) : ImageState
}

/** Decodes the part off the main thread (downsampled), keyed by its payload; shows fallback text on failure. */
@Composable
internal fun TranscriptImage(part: ImagePart, modifier: Modifier = Modifier) {
    val state by produceState<ImageState>(ImageState.Loading, part.data) {
        value = withContext(Dispatchers.Default) {
            val bytes = try {
                Base64.decode(part.data, Base64.DEFAULT)
            } catch (_: IllegalArgumentException) {
                null
            }
            val bmp = bytes?.let { decodeSampledBitmap(it, TRANSCRIPT_DIM) }
            if (bmp != null) ImageState.Ready(bmp.asImageBitmap()) else ImageState.Failed
        }
    }
    when (val s = state) {
        ImageState.Loading -> Text("[loading image…]", color = ToborColors.subtle, fontFamily = CourierPrime, fontSize = 11.sp, modifier = modifier)
        ImageState.Failed -> Text(
            "[image: could not decode ${part.mimeType}]",
            color = ToborColors.subtle,
            fontFamily = CourierPrime,
            fontSize = 11.sp,
            modifier = modifier,
        )
        is ImageState.Ready -> Image(
            s.bitmap,
            contentDescription = "image",
            modifier = modifier.fillMaxWidth().heightIn(max = 240.dp),
            contentScale = ContentScale.Fit,
            alignment = Alignment.CenterStart,
        )
    }
}
