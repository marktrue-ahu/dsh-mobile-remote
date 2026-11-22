package com.dsh.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * issue #152：Android Keystore AES-256-GCM 凭据唯一所有者。
 *
 * - alias 固定 dsh_credentials_v1；AAD 绑定 profileId，密文不能跨档案解出；
 * - 只写私有 SharedPreferences（dsh_credentials），不写 FlutterSharedPreferences；
 * - Dart 不再读写明文 token；原生 FloatingBubbleService 也只从这里取。
 */
object CredentialStore {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "dsh_credentials_v1"
    private const val PREFS = "dsh_credentials"
    private const val ACTIVE_KEY = "active_profile"
    private const val MIGRATION_KEY = "migration_state"
    private const val TOKEN_PREFIX = "token."

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        val existing = store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    @Synchronized
    fun writeToken(context: Context, profileId: String, token: String) {
        require(profileId.isNotEmpty()) { "profileId-required" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(profileId.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val payload = ByteArray(cipher.iv.size + encrypted.size)
        System.arraycopy(cipher.iv, 0, payload, 0, cipher.iv.size)
        System.arraycopy(encrypted, 0, payload, cipher.iv.size, encrypted.size)
        prefs(context).edit()
            .putString(TOKEN_PREFIX + profileId, Base64.encodeToString(payload, Base64.NO_WRAP))
            .putString(MIGRATION_KEY, "complete")
            .commit()
    }

    @Synchronized
    fun readToken(context: Context, profileId: String): String? {
        if (profileId.isEmpty()) return null
        val encoded = prefs(context).getString(TOKEN_PREFIX + profileId, null) ?: return null
        return try {
            val payload = Base64.decode(encoded, Base64.NO_WRAP)
            if (payload.size <= 12) return null
            val iv = payload.copyOfRange(0, 12)
            val ciphertext = payload.copyOfRange(12, payload.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            cipher.updateAAD(profileId.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    @Synchronized
    fun deleteToken(context: Context, profileId: String) {
        prefs(context).edit().remove(TOKEN_PREFIX + profileId).commit()
    }

    @Synchronized
    fun activeProfileId(context: Context): String =
        prefs(context).getString(ACTIVE_KEY, "") ?: ""

    @Synchronized
    fun activate(context: Context, profileId: String) {
        // 激活前必须能解出该档案 token；避免把 active 指向不可用凭据。
        require(readToken(context, profileId) != null) { "credential-missing" }
        prefs(context).edit().putString(ACTIVE_KEY, profileId).commit()
    }

    @Synchronized
    fun deactivate(context: Context) {
        prefs(context).edit().remove(ACTIVE_KEY).commit()
    }

    @Synchronized
    fun status(context: Context): Map<String, Any> {
        val active = activeProfileId(context)
        return mapOf(
            "activeProfileId" to active,
            "hasToken" to (active.isNotEmpty() && readToken(context, active) != null),
            "migrationState" to (prefs(context).getString(MIGRATION_KEY, "") ?: ""),
        )
    }

    fun readActiveToken(context: Context): String? {
        val active = activeProfileId(context)
        return if (active.isEmpty()) null else readToken(context, active)
    }
}
