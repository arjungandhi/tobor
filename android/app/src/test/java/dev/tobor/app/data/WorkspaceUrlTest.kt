package dev.tobor.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceUrlTest {
    @Test fun unchangedUrlIsSameEndpoint() {
        assertTrue(sameEndpoint("https://tobor.example.com", "https://tobor.example.com/"))
        assertTrue(sameEndpoint("https://Tobor.Example.com", "https://tobor.example.com:443"))
        assertTrue(sameEndpoint("http://100.64.0.5:7879", "http://100.64.0.5:7879"))
    }

    @Test fun differentHostOrPortIsDifferentEndpoint() {
        assertFalse(sameEndpoint("https://a.example.com", "https://b.example.com"))
        assertFalse(sameEndpoint("http://100.64.0.5:7879", "http://100.64.0.5:7880"))
    }

    @Test fun unparseableComparesAsText() {
        assertTrue(sameEndpoint("garbage", " garbage "))
        assertFalse(sameEndpoint("garbage", "other"))
    }
}
