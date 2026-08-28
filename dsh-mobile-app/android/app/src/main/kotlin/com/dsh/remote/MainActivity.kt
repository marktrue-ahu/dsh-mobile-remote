package com.dsh.remote

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest

class MainActivity : FlutterActivity() {
    private var floatingChannel: MethodChannel? = null
    // v2.7.2 review(FS1)：悬浮球面板动作可能发生在冷启动（进程已被系统杀死时点"打开会话/充值/通知"），
    // 此时走 onCreate 而非 onNewIntent；Flutter 引擎未就绪前先暂存，configureFlutterEngine 后再投递。
    private var pendingOpenAction: String? = null // "charge" | "notifs" | "session:<id>"

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        // v2.9.0 review(A2)：Android 13+ 运行时请求通知权限（manifest 已声明 POST_NOTIFICATIONS）——
        // 不请求则悬浮球"运行中/点击回到 App"前台服务通知被系统抑制，用户看不到常驻提示
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
            }
        }
        handleIntentExtras(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        floatingChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dsh/floating")
        // 引擎就绪：投递冷启动暂存的面板动作
        deliverPendingAction()
        // v2.7.2 review：Dart 侧 handler 注册可能晚于本回调——延迟再投一次 + consume 兜底
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ deliverPendingAction() }, 800)
        floatingChannel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    startBubbleService()
                    result.success(true)
                }
                "stop" -> {
                    stopService(Intent(this, FloatingBubbleService::class.java))
                    result.success(true)
                }
                "isRunning" -> result.success(FloatingBubbleService.running)
                "canDrawOverlay" -> result.success(Settings.canDrawOverlays(this))
                "openOverlaySettings" -> {
                    openOverlaySettingsPage()
                    result.success(true)
                }
                // v2.7.2 review：冷启动动作兜底——Dart 首帧后主动拉取（投递失败时动作不丢）
                "consumeOpenPanel" -> {
                    result.success(pendingOpenAction)
                    pendingOpenAction = null
                }
                "notifyBalance" -> {
                    val v = call.argument<String>("value") ?: ""
                    // 服务未运行时忽略（否则余额刷新会把悬浮球拉起来，开关形同虚设）
                    if (FloatingBubbleService.running) {
                        val i = Intent(this, FloatingBubbleService::class.java).putExtra("balance", v)
                        startServiceCompat(i)
                    }
                    result.success(true)
                }
                "setBalanceAlert" -> {
                    // 余额预警配置（开关 + 阈值）推给悬浮球：悬浮球的报警判定完全以 App 端设置为依据
                    val enabled = call.argument<Boolean>("enabled") ?: false
                    val threshold = call.argument<String>("threshold")?.toDoubleOrNull() ?: 10.0
                    if (FloatingBubbleService.running) {
                        val i = Intent(this, FloatingBubbleService::class.java)
                            .putExtra("alert_enabled", enabled)
                            .putExtra("alert_threshold", threshold)
                        startServiceCompat(i)
                    }
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
        // ── 自动更新（v3.1）：签名读取 + 触发系统安装器 ──
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dsh/update").setMethodCallHandler { call, result ->
            when (call.method) {
                "ownSignatureSha256" -> result.success(signatureSha256(packageName))
                "apkSignatureSha256" -> {
                    val path = call.argument<String>("path") ?: ""
                    result.success(signatureSha256OfApk(path))
                }
                "installApk" -> {
                    val path = call.argument<String>("path") ?: ""
                    try {
                        installApkFile(path)
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("install-failed", e.message, null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 悬浮球迷你面板动作（热启动路径）：暂存后投递（引擎就绪时立即生效）
        handleIntentExtras(intent)
    }

    /** 解析悬浮球面板动作 extra；onCreate（冷启动）与 onNewIntent（热启动）共用。 */
    private fun handleIntentExtras(intent: Intent?) {
        if (intent == null) return
        when {
            intent.getBooleanExtra("open_charge", false) -> pendingOpenAction = "charge"
            intent.getBooleanExtra("open_notifs", false) -> pendingOpenAction = "notifs"
            else -> intent.getStringExtra("open_session")?.let { pendingOpenAction = "session:$it" }
        }
        deliverPendingAction()
    }

    /** 投递暂存的面板动作到 Flutter 侧（引擎未就绪时 no-op，等 configureFlutterEngine 再投）。 */
    private fun deliverPendingAction() {
        val action = pendingOpenAction ?: return
        val ch = floatingChannel ?: return
        when {
            action == "charge" -> ch.invokeMethod("openChargeRequested", null)
            action == "notifs" -> ch.invokeMethod("openNotifsRequested", null)
            action.startsWith("session:") -> {
                val sid = action.removePrefix("session:")
                if (sid.isNotEmpty()) ch.invokeMethod("openSessionRequested", sid)
            }
        }
        pendingOpenAction = null
    }

    private fun startBubbleService() {
        val i = Intent(this, FloatingBubbleService::class.java)
        startServiceCompat(i)
    }

    private fun startServiceCompat(i: Intent) {
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(i)
        } else {
            startService(i)
        }
    }

    private fun openOverlaySettingsPage() {
        try {
            val i = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:$packageName")
            )
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(i)
        } catch (e: Exception) {
            val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(i)
        }
    }

    // ── 自动更新原生支持（v3.0.0+） ──

    /**
     * 已安装包签名证书 SHA-256。API 28+ 用 GET_SIGNING_CERTIFICATES（signingInfo，兼容 v2/v3 签名——
     * AGP 9 产物 v1=false，GET_SIGNATURES 读不到）；旧版本回退 GET_SIGNATURES（v1）。读取失败返回 null（保守取消）。
     */
    private fun signatureSha256(pkg: String): String? {
        return try {
            val pm = packageManager
            val sigs: Array<android.content.pm.Signature>? = if (Build.VERSION.SDK_INT >= 28) {
                pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
                    ?.signingInfo?.apkContentsSigners
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)?.signatures
            }
            val sig = sigs?.firstOrNull() ?: return null
            sha256Hex(sig.toByteArray())
        } catch (e: Exception) {
            null
        }
    }

    /** 本地 APK 文件签名证书 SHA-256（getPackageArchiveInfo + GET_SIGNING_CERTIFICATES 兼容 v2/v3；API<28 回退 GET_SIGNATURES）。读取失败返回 null。 */
    private fun signatureSha256OfApk(path: String): String? {
        return try {
            val pm = packageManager
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else {
                @Suppress("DEPRECATION")
                PackageManager.GET_SIGNATURES
            }
            val info = pm.getPackageArchiveInfo(path, flags) ?: return null
            val sigs: Array<android.content.pm.Signature>? =
                if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else {
                    @Suppress("DEPRECATION")
                    info.signatures
                }
            val sig = sigs?.firstOrNull() ?: return null
            sha256Hex(sig.toByteArray())
        } catch (e: Exception) {
            null
        }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** 拉起系统安装器（FileProvider 授权读取；Android 8+ 未知来源由系统引导）。 */
    private fun installApkFile(path: String) {
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:$packageName"))
            )
            throw IllegalStateException("请允许本应用安装未知应用后重试")
        }
        val file = File(path)
        if (!file.exists()) throw IllegalStateException("APK 文件不存在")
        val uri: Uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(intent)
    }
}
