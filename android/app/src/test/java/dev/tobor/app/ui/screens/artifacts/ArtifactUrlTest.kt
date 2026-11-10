package dev.tobor.app.ui.screens.artifacts

import org.junit.Assert.assertEquals
import org.junit.Test

class ArtifactUrlTest {
    private val base = "http://100.64.0.5:7878"

    @Test fun rewritesIpv4Loopback() {
        assertEquals(
            "http://100.64.0.5:7880/art/proj_x/slug",
            rewriteLoopback("http://127.0.0.1:7880/art/proj_x/slug", base),
        )
    }

    @Test fun rewritesLocalhostKeepingQueryAndScheme() {
        assertEquals(
            "https://tobor.lan:7880/art/r/abc?x=1",
            rewriteLoopback("https://localhost:7880/art/r/abc?x=1", "https://tobor.lan/"),
        )
    }

    @Test fun leavesRemoteHostAlone() {
        val u = "http://example.com:7880/art/a/b"
        assertEquals(u, rewriteLoopback(u, base))
    }

    @Test fun leavesUrlWhenBaseIsAlsoLoopbackOrInvalid() {
        val u = "http://127.0.0.1:7880/art/a/b"
        assertEquals(u, rewriteLoopback(u, "http://127.0.0.1:7878"))
        assertEquals(u, rewriteLoopback(u, "not a url"))
        assertEquals("garbage", rewriteLoopback("garbage", base))
    }
}
