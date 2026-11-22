package com.dsh.remote

import android.content.Context
import org.json.JSONObject

/**
 * issue #152：Dart 写入的非敏感连接描述符（原生只读）。
 * Flutter shared_preferences 会把 key 前缀成 flutter.；这里固定读取该物理 key。
 */
data class NativeConnection(
    val profileId: String,
    val hostId: String,
    val generation: Int,
    val baseUrl: String,
    val path: String,
    val tlsPolicy: String,
) {
    /** 同一 profile + generation 才允许应用原生帧。 */
    fun isSameConnection(other: NativeConnection?): Boolean =
        other != null && other.profileId == profileId && other.generation == generation

    val origin: String
        get() = try {
            val uri = java.net.URI(baseUrl)
            "${uri.scheme}://${uri.host}${if (uri.port >= 0) ":${uri.port}" else ""}"
        } catch (_: Exception) {
            ""
        }

    companion object {
        private const val PREFS = "FlutterSharedPreferences"
        private const val KEY = "flutter.dsh_native_connection"

        fun read(context: Context): NativeConnection? {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY, null) ?: return null
            return try {
                val json = JSONObject(raw)
                val profileId = json.optString("profileId")
                val baseUrl = json.optString("baseUrl")
                if (profileId.isEmpty() || baseUrl.isEmpty()) return null
                NativeConnection(
                    profileId = profileId,
                    hostId = json.optString("hostId"),
                    generation = json.optInt("generation", 0),
                    baseUrl = baseUrl,
                    path = json.optString("path", "/m").ifEmpty { "/m" },
                    tlsPolicy = json.optString("tlsPolicy", "https"),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}
