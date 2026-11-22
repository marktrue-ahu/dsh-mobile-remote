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

    /** 单次读取的 descriptor+token 快照；请求必须从它构造，禁止二次独立读 base/path。 */
    data class Snapshot(val connection: NativeConnection, val token: String) {
        fun isStillCurrent(fresh: NativeConnection?, activeProfileId: String): Boolean =
            fresh != null &&
                fresh.isSameConnection(connection) &&
                fresh.profileId == activeProfileId

        fun requestUrl(apiPath: String): String {
            var base = connection.baseUrl.trim()
            if (base.endsWith("/")) base = base.dropLast(1)
            if (base.endsWith("/m")) base = base.dropLast(2)
            return "$base${connection.path}/api/$apiPath"
        }
    }

    object Access {
        /** 一次读取 descriptor/token/active；任何不一致返回 null（fail-closed）。 */
        fun snapshot(context: Context): Snapshot? {
            val descriptor = read(context) ?: return null
            if (CredentialStore.activeProfileId(context) != descriptor.profileId) {
                return null
            }
            val token = CredentialStore.readToken(context, descriptor.profileId)
                ?: return null
            return Snapshot(descriptor, token)
        }

        fun isCurrent(context: Context, snapshot: Snapshot): Boolean =
            snapshot.isStillCurrent(read(context), CredentialStore.activeProfileId(context))
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
