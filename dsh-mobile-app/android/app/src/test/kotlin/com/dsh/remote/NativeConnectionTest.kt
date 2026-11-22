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
    fun snapshotPinsUrlAndTokenToSameProfile() {
        val snapshot = NativeConnection.Snapshot(connection(), "token-a")
        val freshA = connection()
        val freshB = connection(profile = "profile-b", generation = 4, base = "https://10.0.0.2:3080")
        assertTrue(snapshot.isStillCurrent(freshA, "profile-a"))
        assertFalse(snapshot.isStillCurrent(freshB, "profile-b"))
        // A 的 URL/token 只能成对出现；fresh B 下不得继续发送该快照。
        assertEquals("https://192.168.1.20:3080/m/api/balance", snapshot.requestUrl("balance"))
        assertEquals("token-a", snapshot.token)
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
