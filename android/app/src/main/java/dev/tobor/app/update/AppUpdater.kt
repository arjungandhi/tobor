package dev.tobor.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** A newer GitHub release than the running app. [sha256] comes from the release's manifest.json when present. */
data class UpdateInfo(
    val version: String,
    val apkUrl: String,
    val sha256: String?,
    val notes: String?,
)

/**
 * Self-updater for sideloaded installs: reads GitHub's `releases/latest`, compares the tag to our own versionName,
 * downloads `tobor.apk` (sha256-checked against `manifest.json`) into cache and hands it to the package installer.
 *
 * Holds Compose state so screens can observe it; one instance lives in `AppNav`. All failures are logged and surfaced
 * through [status], never thrown.
 */
class AppUpdater(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("tobor_update", Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder()
        .callTimeout(10, TimeUnit.MINUTES)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** The running app's versionName (`0.0.0-dev` for local builds). */
    val currentVersion: String = runCatching {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName
    }.getOrNull().orEmpty()

    /** Set when a newer release was found and the user has not yet answered the prompt. */
    var available by mutableStateOf<UpdateInfo?>(null)
        private set

    /** Short human-readable progress/result line for the settings screen; null when idle. */
    var status by mutableStateOf<String?>(null)
        private set

    var busy by mutableStateOf(false)
        private set

    fun dismiss() {
        available = null
    }

    /** Auto trigger (start/resume): at most once per [CHECK_INTERVAL_MS], silent unless an update is found. */
    suspend fun checkIfDue() {
        if (isDev()) return
        val last = prefs.getLong(KEY_LAST_CHECK, 0L)
        if (System.currentTimeMillis() - last < CHECK_INTERVAL_MS) return
        check(manual = false)
    }

    /** Fetches the latest release; sets [available] if newer. [manual] also reports "up to date"/errors in [status]. */
    suspend fun check(manual: Boolean = true) {
        if (busy) return
        if (isDev()) {
            if (manual) status = "dev build ($currentVersion): updates disabled"
            return
        }
        busy = true
        if (manual) status = "checking…"
        try {
            val info = withContext(Dispatchers.IO) { fetchLatest() }
            prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
            if (info != null) {
                available = info
                status = if (manual) "v${info.version} available" else null
            } else if (manual) {
                status = "up to date (v$currentVersion)"
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "update check failed", e)
            if (manual) status = "update check failed: ${e.message ?: e.javaClass.simpleName}"
        } finally {
            busy = false
        }
    }

    /** Downloads [info]'s APK, verifies its checksum and launches the installer. */
    suspend fun install(info: UpdateInfo) {
        if (busy) return
        available = null
        busy = true
        status = "downloading v${info.version}…"
        try {
            val file = withContext(Dispatchers.IO) { download(info) }
            launchInstaller(file)
            status = "installer launched for v${info.version}"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "update install failed", e)
            status = "update failed: ${e.message ?: e.javaClass.simpleName}"
        } finally {
            busy = false
        }
    }

    private fun isDev(): Boolean = currentVersion.isEmpty() || currentVersion.endsWith("-dev") || parseVersion(currentVersion) == null

    private fun getText(url: String): String {
        val req = Request.Builder().url(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/vnd.github+json")
            .build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code} from $url")
            return r.body?.string().orEmpty()
        }
    }

    private fun fetchLatest(): UpdateInfo? {
        val release = Json.parseToJsonElement(getText(LATEST_URL)).jsonObject
        val tag = release.str("tag_name") ?: return null
        val remote = parseVersion(tag) ?: return null
        val local = parseVersion(currentVersion) ?: return null
        if (compareVersions(remote, local) <= 0) return null

        val assets = (release["assets"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val apk = assets.firstOrNull { it.str("name") == APK_NAME }?.str("browser_download_url") ?: return null
        val manifestUrl = assets.firstOrNull { it.str("name") == "manifest.json" }?.str("browser_download_url")
        val sha = manifestUrl?.let { runCatching { shaFromManifest(getText(it)) }.getOrNull() }
        return UpdateInfo(tag.removePrefix("v"), apk, sha, release.str("body")?.takeIf { it.isNotBlank() })
    }

    private fun download(info: UpdateInfo): File {
        val dir = File(app.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, APK_NAME)
        val digest = MessageDigest.getInstance("SHA-256")
        val req = Request.Builder().url(info.apkUrl).header("User-Agent", USER_AGENT).build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IOException("download failed: HTTP ${r.code}")
            val body = r.body ?: throw IOException("empty download")
            body.byteStream().use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        digest.update(buf, 0, n)
                    }
                }
            }
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (info.sha256 != null && !info.sha256.equals(actual, ignoreCase = true)) {
            out.delete()
            throw IOException("checksum mismatch")
        }
        return out
    }

    private fun launchInstaller(file: File) {
        if (!app.packageManager.canRequestPackageInstalls()) {
            // User must allow installs from this app once; send them to that settings page.
            app.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            throw IOException("allow installs from this app, then check for updates again")
        }
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
        app.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    companion object {
        private const val TAG = "AppUpdater"
        private const val LATEST_URL = "https://api.github.com/repos/arjungandhi/tobor/releases/latest"
        private const val APK_NAME = "tobor.apk"
        private const val USER_AGENT = "tobor-android"
        private const val KEY_LAST_CHECK = "last_check"
        private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

        /** `vX.Y.Z[-suffix]` -> [X, Y, Z]; null if it does not look like a version. */
        internal fun parseVersion(v: String): List<Int>? {
            val m = Regex("""^v?(\d+)\.(\d+)\.(\d+)""").find(v.trim()) ?: return null
            return m.groupValues.drop(1).map { it.toIntOrNull() ?: return null }
        }

        internal fun compareVersions(a: List<Int>, b: List<Int>): Int {
            for (i in 0 until maxOf(a.size, b.size)) {
                val c = a.getOrElse(i) { 0 }.compareTo(b.getOrElse(i) { 0 })
                if (c != 0) return c
            }
            return 0
        }

        /** sha256 of the android `tobor.apk` entry in manifest.json, or null. */
        internal fun shaFromManifest(text: String): String? {
            val assets = Json.parseToJsonElement(text).jsonObject["assets"]?.jsonArray ?: return null
            return assets.mapNotNull { it as? JsonObject }
                .firstOrNull { it.str("name") == APK_NAME && it.str("target").let { t -> t == null || t == "android" } }
                ?.str("sha256")
        }
    }
}
