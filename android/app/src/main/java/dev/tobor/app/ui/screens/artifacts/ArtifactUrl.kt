package dev.tobor.app.ui.screens.artifacts

import androidx.compose.ui.platform.UriHandler
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val loopbackHosts = setOf("127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0")

/**
 * Point a server-advertised [url] at the host the phone actually reached the node through.
 *
 * Two cases make the advertised host unusable from the phone:
 * - The server's `artifacts_url`/`public_url` is a loopback address.
 * - It is a tailnet-specific name, e.g. the MagicDNS FQDN `strugglebus.tail4bff7.ts.net`. When the phone is on a
 *   different tailnet that FQDN doesn't resolve, but the phone already reached the same node via [baseUrl] (say
 *   `http://strugglebus:7879`), so that host is the one known to resolve.
 *
 * If [url]'s host is loopback or one of [advertisedHosts] (hosts parsed from whoami's `public_url`/`artifacts_url`;
 * case-insensitive), swap in [baseUrl]'s host, keeping [url]'s scheme, port, path and query. Returns [url] unchanged
 * for any other host, an unparseable input, or a [baseUrl] that is itself loopback.
 */
fun rewriteServerHost(url: String, baseUrl: String, advertisedHosts: Set<String> = emptySet()): String {
    val target = url.toHttpUrlOrNull() ?: return url
    val host = target.host.lowercase()
    if (host !in loopbackHosts && advertisedHosts.none { it.equals(host, ignoreCase = true) }) return url
    val base = baseUrl.toHttpUrlOrNull() ?: return url
    if (base.host.lowercase() in loopbackHosts) return url
    return target.newBuilder().host(base.host).build().toString()
}

/** Hosts of the given server-advertised URLs (whoami `public_url`, `artifacts_url`), lowercased; blanks/garbage skipped. */
fun advertisedHostsOf(vararg urls: String): Set<String> =
    urls.mapNotNullTo(mutableSetOf()) { it.toHttpUrlOrNull()?.host?.lowercase() }

/**
 * App-wide [UriHandler] that runs every opened link (artifact list, markdown/linkified chat links) through
 * [rewriteServerHost] before delegating. [baseUrl] and [advertisedHosts] are read at open time so workspace switches
 * and late whoami responses apply immediately.
 */
class ServerHostUriHandler(
    private val delegate: UriHandler,
    private val baseUrl: () -> String,
    private val advertisedHosts: () -> Set<String>,
) : UriHandler {
    override fun openUri(uri: String) = delegate.openUri(rewriteServerHost(uri, baseUrl(), advertisedHosts()))
}
