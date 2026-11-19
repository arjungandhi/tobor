package dev.tobor.app.ui.screens.artifacts

import org.junit.Assert.assertEquals
import org.junit.Test

class ArtifactUrlTest {
    private val base = "http://100.64.0.5:7878"
    private val fqdn = "strugglebus.tail4bff7.ts.net"

    @Test fun rewritesIpv4Loopback() {
        assertEquals(
            "http://100.64.0.5:7880/art/proj_x/slug",
            rewriteServerHost("http://127.0.0.1:7880/art/proj_x/slug", base),
        )
    }

    @Test fun rewritesLocalhostKeepingQueryAndScheme() {
        assertEquals(
            "https://tobor.lan:7880/art/r/abc?x=1",
            rewriteServerHost("https://localhost:7880/art/r/abc?x=1", "https://tobor.lan/"),
        )
    }

    @Test fun leavesRemoteHostAlone() {
        val u = "http://example.com:7880/art/a/b"
        assertEquals(u, rewriteServerHost(u, base))
    }

    @Test fun leavesUrlWhenBaseIsAlsoLoopbackOrInvalid() {
        val u = "http://127.0.0.1:7880/art/a/b"
        assertEquals(u, rewriteServerHost(u, "http://127.0.0.1:7878"))
        assertEquals(u, rewriteServerHost(u, "not a url"))
        assertEquals("garbage", rewriteServerHost("garbage", base))
    }

    @Test fun rewritesAdvertisedTailnetFqdnToWorkspaceHost() {
        assertEquals(
            "http://strugglebus:7880/art/x",
            rewriteServerHost("http://$fqdn:7880/art/x", "http://strugglebus:7879", setOf(fqdn)),
        )
    }

    @Test fun advertisedHostMatchIsCaseInsensitive() {
        assertEquals(
            "http://strugglebus:7880/art/x",
            rewriteServerHost("http://StruggleBus.Tail4bff7.ts.net:7880/art/x", "http://strugglebus:7879", setOf(fqdn)),
        )
        assertEquals(
            "http://strugglebus:7880/art/x",
            rewriteServerHost("http://$fqdn:7880/art/x", "http://strugglebus:7879", setOf(fqdn.uppercase())),
        )
    }

    @Test fun leavesNonAdvertisedRemoteHostAlone() {
        val u = "http://example.com:7880/art/x"
        assertEquals(u, rewriteServerHost(u, "http://strugglebus:7879", setOf(fqdn)))
    }

    @Test fun leavesAdvertisedHostWhenBaseIsLoopback() {
        val u = "http://$fqdn:7880/art/x"
        assertEquals(u, rewriteServerHost(u, "http://127.0.0.1:7879", setOf(fqdn)))
    }

    @Test fun advertisedHostsOfParsesHostsAndSkipsBlanks() {
        assertEquals(
            setOf(fqdn),
            advertisedHostsOf("http://StruggleBus.tail4bff7.ts.net:7879", "http://$fqdn:7880", "", "garbage"),
        )
    }
}
