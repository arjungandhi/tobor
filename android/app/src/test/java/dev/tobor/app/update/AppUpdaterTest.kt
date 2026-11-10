package dev.tobor.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest

class AppUpdaterTest {
    @Test
    fun parsesTags() {
        assertEquals(listOf(1, 2, 3), AppUpdater.parseVersion("v1.2.3"))
        assertEquals(listOf(0, 0, 0), AppUpdater.parseVersion("0.0.0-dev"))
        assertNull(AppUpdater.parseVersion("nightly"))
    }

    @Test
    fun comparesNumerically() {
        val v = { s: String -> AppUpdater.parseVersion(s)!! }
        assertTrue(AppUpdater.compareVersions(v("1.10.0"), v("1.9.9")) > 0)
        assertTrue(AppUpdater.compareVersions(v("1.0.0"), v("1.0.1")) < 0)
        assertEquals(0, AppUpdater.compareVersions(v("v2.0.0"), v("2.0.0")))
    }

    @Test
    fun readsAndroidShaFromManifest() {
        val m = """{"version":"1.0.0","assets":[
            {"name":"tobor-linux","target":"linux","sha256":"aa"},
            {"name":"tobor.apk","target":"android","sha256":"bb"}]}"""
        assertEquals("bb", AppUpdater.shaFromManifest(m))
        assertNull(AppUpdater.shaFromManifest("""{"assets":[]}"""))
    }

    private val manifest = """{"assets":[{"name":"tobor.apk","target":"android","sha256":"bb"}]}"""

    private fun assertRefused(block: () -> Unit) {
        try {
            block()
            fail("expected IOException (fail closed)")
        } catch (_: IOException) {
        }
    }

    @Test
    fun manifestFetchFailureRefusesUpdate() {
        assertRefused { AppUpdater.requireSha("https://x/manifest.json") { throw IOException("HTTP 404") } }
    }

    @Test
    fun missingManifestAssetRefusesUpdate() {
        assertRefused { AppUpdater.requireSha(null) { manifest } }
    }

    @Test
    fun manifestWithoutAndroidEntryRefusesUpdate() {
        val linuxOnly = """{"assets":[{"name":"tobor-linux","target":"linux","sha256":"aa"}]}"""
        assertRefused { AppUpdater.requireSha("https://x/manifest.json") { linuxOnly } }
        assertRefused { AppUpdater.requireSha("https://x/manifest.json") { "not json" } }
    }

    @Test
    fun goodManifestYieldsSha() {
        assertEquals("bb", AppUpdater.requireSha("https://x/manifest.json") { manifest })
    }

    @Test
    fun downloadVerifiedOnlyWithMatchingSha() {
        val bytes = "apk-bytes".toByteArray()
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val out = File.createTempFile("tobor", ".apk")
        try {
            AppUpdater.copyVerified(ByteArrayInputStream(bytes), out, sha.uppercase())
            assertTrue(out.exists())
            assertRefused { AppUpdater.copyVerified(ByteArrayInputStream(bytes), out, "00") }
            assertFalse(out.exists())
            assertRefused { AppUpdater.copyVerified(ByteArrayInputStream(bytes), out, "") }
            assertFalse(out.exists())
        } finally {
            out.delete()
        }
    }
}
