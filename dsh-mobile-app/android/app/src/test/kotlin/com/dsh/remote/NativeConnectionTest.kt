package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeConnectionTest {
    private fun connection(
        profile: String = "profile-a",
        generation: Int = 3,
        base: String = "https://192.168.1.20:3080",
        path: String = "/m",
    ) = NativeConnection(profile, "host-a", generation, base, path, "https")

    @Test
    fun originDropsPathAndKeepsPort() {
        assertEquals("https://192.168.1.20:3080", connection().origin)
    }

    @Test
    fun generationAndProfileGateOldFrames() {
        val current = connection()
        assertTrue(current.isSameConnection(connection()))
        assertFalse(current.isSameConnection(connection(generation = 2)))
        assertFalse(current.isSameConnection(connection(profile = "profile-b")))
        assertFalse(current.isSameConnection(null))
    }
}
