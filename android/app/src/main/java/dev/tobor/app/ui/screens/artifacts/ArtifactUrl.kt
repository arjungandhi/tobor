package dev.tobor.app.ui.screens.artifacts

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val loopbackHosts = setOf("127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0")

/**
 * The server's `artifacts_url` is often a loopback address, unreachable from the phone. If [url]'s host is loopback,
 * swap in the host of the workspace [baseUrl] (keeping [url]'s scheme, port, path and query). Anything else, or an
 * unparseable input, is returned unchanged.
 */
fun rewriteLoopback(url: String, baseUrl: String): String {
    val target = url.toHttpUrlOrNull() ?: return url
    if (target.host !in loopbackHosts) return url
    val base = baseUrl.toHttpUrlOrNull() ?: return url
    if (base.host in loopbackHosts) return url
    return target.newBuilder().host(base.host).build().toString()
}
