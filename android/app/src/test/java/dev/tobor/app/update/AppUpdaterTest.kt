package dev.tobor.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
