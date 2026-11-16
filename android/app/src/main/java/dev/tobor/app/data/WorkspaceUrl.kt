package dev.tobor.app.data

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * True when [a] and [b] address the same node endpoint (case-insensitive host and effective port). A workspace's bearer
 * token belongs to that endpoint, so editing the URL to a different one must drop the stored token. Unparseable URLs
 * compare by trimmed text.
 */
fun sameEndpoint(a: String, b: String): Boolean {
    val x = a.trim().toHttpUrlOrNull()
    val y = b.trim().toHttpUrlOrNull()
    if (x == null || y == null) return a.trim() == b.trim()
    return x.host.equals(y.host, ignoreCase = true) && x.port == y.port
}
