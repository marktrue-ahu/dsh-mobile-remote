// 自动更新编排：检查（只消费宿主给出的固定发布）→ 下载（进度）→ sha256 校验 →
// 签名预检 → 拉起系统安装器。均有副作用，按 spec 由 UI 层驱动。
//
// 来源接线（设计稿 §5.6 / §5.9、F04 / F19）：**不再直连 GitHub / 不自行拼资产地址**。
// 无论宿主的候选来自 HTTPS／GitHub 还是本机源，落给手机的 `release.app.url` 都是
// 宿主投影的固定目标绝对地址；App 只消费该字段（固定目标的 query 由宿主拼好）。
import 'dart:convert';
import 'dart:io';
import 'package:convert/convert.dart';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'api.dart';
import 'logger.dart';
import 'native_update.dart';
import 'store.dart';
import 'update_core.dart';
import 'plugin_update_resume.dart';

/// 一次「检查更新」的结果。
class UpdateCheckOutcome {
  final UpdateVerdict verdict;
  final UpdateCandidate? candidate;
  final String? error; // 检查失败的人类可读提示（verdict 无意义时使用）
  const UpdateCheckOutcome({required this.verdict, this.candidate, this.error});
}

/// 一次**下载/安装请求失败**的机器可读分类（§5.9 / §5.10）。
///
/// 调用方据此区分出口：目标失效（退出旧候选、提示重查）／尚未就绪（保留目标、
/// 稍后重试）／认证问题（重扫二维码后重试）／普通网络或校验失败（可重试）。
class UpdateFailure {
  const UpdateFailure(this.message, {this.code, this.status});

  final String message;
  final String? code;
  final int? status;

  /// 固定目标已失效/未知（410／404／400）：退出旧候选并提示重新检查，绝不静默换包。
  bool get targetGone =>
      code == 'app-artifact-expired' ||
      code == 'app-artifact-unknown' ||
      status == 410 ||
      status == 404 ||
      status == 400;

  /// APK 尚未就绪（503）：插件可正常工作，保留固定目标稍后重试（§5.10）。
  bool get notReady => code == 'app-artifact-not-ready' || status == 503;

  /// 认证类失败：不能显示成通用网络错误，需提示用电脑连接页二维码重扫。
  bool get authFailure =>
      code == 'auth-not-configured' || code == 'auth-required' || status == 401;
}

/// 下载取消令牌：UI 关闭进度弹窗时调用 [cancel] —— 中止 HTTP 流、
/// 停止后续校验/安装，并清理半成品文件（spec：取消即清理文件）。
class UpdateCancelToken {
  bool _cancelled = false;
  http.Client? _client;
  void cancel() {
    _cancelled = true;
    try {
      _client?.close(); // 中断进行中的下载流（抛 ClientException 由调用方收敛）
    } catch (_) {}
  }

  bool get cancelled => _cancelled;
}

/// 固定目标下载失败的稳定错误码 → 可执行文案（§5.10，码由宿主给出）。
UpdateFailure artifactFailure(int status, {String? code, String detail = ''}) {
  final apiError = ApiException(
    detail.isEmpty ? 'HTTP $status' : detail,
    code: code,
    status: status,
  );
  final auth = authFixHint(apiError);
  if (auth != null) {
    return UpdateFailure(auth, code: code, status: status);
  }
  if (status == 410 || code == 'app-artifact-expired') {
    return UpdateFailure(
      '固定目标已过期：电脑端已清理该版本，不会自动换成新版；请重新检查两端版本后重试（旧组合仍可继续使用）',
      code: 'app-artifact-expired',
      status: status,
    );
  }
  if (status == 404 || code == 'app-artifact-unknown') {
    return UpdateFailure(
      '电脑端没有该固定目标的记录；请重新检查两端版本后重试（不会自动换包）',
      code: 'app-artifact-unknown',
      status: status,
    );
  }
  if (status == 400) {
    return UpdateFailure(
      '固定目标标识无效；请重新检查两端版本后重试',
      code: code ?? 'bad-request',
      status: status,
    );
  }
  if (status == 503 || code == 'app-artifact-not-ready') {
    return UpdateFailure(
      '电脑端 APK 尚未就绪（可能正在导入或镜像滞后）；固定目标已保留，请稍后重试',
      code: 'app-artifact-not-ready',
      status: status,
    );
  }
  if (code == 'app-artifact-mismatch') {
    return UpdateFailure(
      '电脑端 APK 与发布清单不一致，已停止下载；请检查电脑端发布来源后重新检查',
      code: code,
      status: status,
    );
  }
  return UpdateFailure(
    '下载失败：HTTP $status${detail.isEmpty ? '' : '（$detail）'}',
    code: code,
    status: status,
  );
}

/// 主机源检查错误 → 明确的中文提示（spec：错误码可读化，「主机源未配置更新」等）。
String hostCheckErrorMessage(ApiException e) {
  final auth = authFixHint(e);
  if (auth != null) return auth;
  switch (e.code) {
    case 'update-not-configured':
      return '主机源未配置更新（需在插件配置 updateDir 并放入发布产物）';
    case 'update-dir-missing':
      return '主机更新目录不存在，请检查插件 updateDir 配置';
    case 'update-manifest-missing':
      return '主机更新目录缺少 manifest.json';
    case 'update-manifest-invalid':
      return '主机 manifest.json 格式无效';
    case 'app-artifact-not-ready':
      return '电脑端 APK 尚未就绪（可能正在导入或镜像滞后），请稍后重试';
    case 'app-artifact-expired':
      return '固定目标已过期：电脑端已清理该版本，请重新检查两端版本';
    case 'app-artifact-unknown':
      return '电脑端没有该固定目标的记录，请重新检查两端版本';
    case 'app-artifact-mismatch':
      return '电脑端 APK 与发布清单不一致，请检查电脑端发布来源';
    default:
      return '主机源检查失败：${e.message}';
  }
}

typedef UpdateInstaller = Future<String?> Function(UpdateCandidate candidate, {
  void Function(int received, int? total)? onProgress,
  void Function(String stage)? onStage,
  UpdateCancelToken? cancel,
});

class Updater {
  /// 读取本机 App 版本（package_info_plus）。失败返回 null。
  static Future<AppVersion?> localVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return parseAppVersion('${info.version}+${info.buildNumber}');
    } catch (e) {
      AppLog.instance.log('Update: 读取本地版本失败 $e');
      return null;
    }
  }

  /// 检查更新：只消费宿主给出的固定发布 / 主机清单，不直连 GitHub。
  static Future<UpdateCheckOutcome> check(AppStore store) async {
    final journal = store.pluginUpdateJournal;
    if (journal != null) {
      if (journal.phase == UpdatePhase.pluginPending) {
        return const UpdateCheckOutcome(verdict: UpdateVerdict.upToDate, error: '电脑端插件更新尚未健康确认');
      }
      return store.checkFixedAppUpdate(journal.release);
    }

    final preferHostManifest = store.updateSource == 'host';
    if (preferHostManifest) {
      final fromManifest = await _checkHostManifest(store);
      if (fromManifest != null) return fromManifest;
    }
    // 新流程权威来源：宿主下发的 currentRelease / updateTarget（GitHub/HTTPS 来源也由宿主投影）。
    final pointer = store.hostReleasePointer;
    if (pointer != null) return store.checkFixedAppUpdate(pointer.release);
    if (!preferHostManifest) {
      // 旧宿主兼容：主机目录里的完整 schema 1 清单（地址同样由宿主投影）。
      final fromManifest = await _checkHostManifest(store);
      if (fromManifest != null) return fromManifest;
    }
    return UpdateCheckOutcome(verdict: UpdateVerdict.upToDate, error: _noFixedReleaseMessage(store.updateSource));
  }

  /// 主机目录清单（人工区 / 旧宿主兼容）。返回 null = 旧宿主没有可用清单，交给上层兜底。
  static Future<UpdateCheckOutcome?> _checkHostManifest(AppStore store) async {
    try {
      final candidate = await _candidateFromHost(store.api);
      final release = candidate?.release;
      if (release == null) return null;
      return await store.checkFixedAppUpdate(release);
    } on ApiException catch (e) {
      final auth = authFixHint(e);
      if (auth != null) {
        return UpdateCheckOutcome(verdict: UpdateVerdict.upToDate, error: auth);
      }
      // 旧宿主没配主机目录：不是"检查失败"，交给固定发布/迁移提示兜底。
      if (e.code == 'update-not-configured' ||
          e.code == 'update-dir-missing' ||
          e.code == 'update-manifest-missing') {
        return null;
      }
      return UpdateCheckOutcome(verdict: UpdateVerdict.upToDate, error: hostCheckErrorMessage(e));
    } catch (e) {
      AppLog.instance.log('Update: 主机清单检查失败 $e');
      return UpdateCheckOutcome(verdict: UpdateVerdict.upToDate, error: '主机源检查失败：$e');
    }
  }

  static String _noFixedReleaseMessage(String source) {
    if (source == 'host') {
      return '电脑端没有可用的固定发布（updateDir 未配置或清单不完整）；请检查电脑端插件与更新目录，或用连接页二维码重扫一次';
    }
    return '新版 App 统一从电脑端固定目标下载（不再直连 GitHub）；电脑端尚未下发可用的固定发布。'
        '请在电脑上更新插件，或用电脑连接页的二维码重新扫码连接后重试；旧组合仍可继续使用';
  }

  static Future<UpdateCandidate?> _candidateFromHost(Api client) async {
    final d = await client.updateManifest();
    final base = hostApiBase(baseUrl: client.baseUrl, mountPath: client.path);
    final snapshot = normalizedReleaseFromManifest(
      d,
      manifestUrl: '$base/api/update/manifest',
      // 兜底定位仍指向宿主路由；固定目标的 query 只能由宿主给出，App 不拼。
      appUrl: '$base/api/update/apk',
      pluginUrl: '$base/api/update/plugin',
    );
    return snapshot?.candidate;
  }

  /// 启动静默自动检查（spec：默认开）：仅把命中的候选写入 store（不弹窗），
  /// 由首页横幅 / 设置页「有新版本」提示驱动用户操作；失败静默跳过。
  static Future<void> autoCheckSilent(AppStore store) async {
    if (store.updateChecking) return;
    store.updateChecking = true;
    final o = await check(store);
    store.updateChecking = false;
    if (o.verdict == UpdateVerdict.updateAvailable && o.candidate != null) {
      store.setUpdateCandidate(o.candidate);
    }
  }

  /// 下载 + 校验 + 签名预检 + 安装。成功返回 null；失败返回人类可读错误；
  /// 用户取消（经 [cancel]）返回 'cancelled' 并清理半成品文件，不进入安装。
  ///
  /// [onProgress]：(已下载字节, 总字节或 null)；[onStage]：阶段提示（用于 UI）。
  /// [beforeInstall]：**拉起安装器前**的异步复核（§5.9：重新读取电脑端当前状态）；
  /// 返回非 null = 拒绝安装的原因，null = 允许。
  /// [onFailure]：带稳定错误码的失败分类，供调用方决定接续出口。
  static Future<String?> downloadAndInstall(
    UpdateCandidate candidate, {
    void Function(int received, int? total)? onProgress,
    void Function(String stage)? onStage,
    UpdateCancelToken? cancel,
    Api? apiClient,
    Future<String?> Function()? beforeInstall,
    void Function(UpdateFailure failure)? onFailure,
    http.Client? downloadClient,
    Directory? temporaryDirectory,
  }) async {
    final connection = apiClient ?? api;
    // ── 下载 ──
    final dir = temporaryDirectory ?? await getTemporaryDirectory();
    final updateDir = Directory('${dir.path}/dsh-update');
    await updateDir.create(recursive: true);
    final target = File('${updateDir.path}/dsh-update-${DateTime.now().millisecondsSinceEpoch}.apk');

    // 取消即清理：删除半成品并收敛为 'cancelled'（UI 已自行展示取消态）
    Future<String> abortCancelled() async {
      try {
        if (await target.exists()) await target.delete();
      } catch (_) {}
      return 'cancelled';
    }

    http.Client? client;
    IOSink? sink;
    try {
      onStage?.call('download');
      final req = http.Request('GET', Uri.parse(candidate.downloadUrl));
      req.headers.addAll(connection.artifactHeaders(req.url));
      client = downloadClient ?? http.Client();
      if (cancel != null) cancel._client = client;
      final resp = await client.send(req).timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) {
        // 固定目标的稳定错误码（410/404/400/503/401）：分类收敛，供接续出口使用。
        final failure = await _artifactFailureFromResponse(resp);
        onFailure?.call(failure);
        return failure.message;
      }
      final total = resp.contentLength ?? candidate.sizeBytes;
      sink = target.openWrite();
      var received = 0;
      await for (final chunk in resp.stream) {
        if (cancel?.cancelled == true) break;
        sink.add(chunk);
        received += chunk.length;
        onProgress?.call(received, total);
      }
      await sink.flush();
      await sink.close();
      sink = null;
      if (cancel?.cancelled == true) return await abortCancelled();
      if (!await target.exists() || await target.length() == 0) {
        return '下载失败：文件为空';
      }
      bool wasCancelled() => cancel?.cancelled == true;

      // ── 字节数校验：以**发布清单声明的 size** 为准，不看响应的 Content-Length ──
      // （同 URL 被替换成另一份产物时，Content-Length 会跟着变，只信它就等于没校验。）
      if (candidate.sizeBytes != null && candidate.sizeBytes! > 0) {
        final actual = await target.length();
        if (actual != candidate.sizeBytes) {
          await target.delete();
          return '校验失败：文件大小与发布清单不一致（$actual ≠ ${candidate.sizeBytes}），已取消';
        }
      }

      // ── sha256 校验（主机源 manifest 提供；GitHub 无 -> 跳过） ──
      if (candidate.sha256 != null && candidate.sha256!.isNotEmpty) {
        onStage?.call('checksum');
        if (wasCancelled()) return await abortCancelled();
        final acc = AccumulatorSink<Digest>();
        await sha256.bind(target.openRead()).fold<AccumulatorSink<Digest>>(acc, (a, d) {
          a.add(d);
          return a;
        });
        final digest = acc.events.single.toString();
        if (digest != candidate.sha256!.toLowerCase()) {
          await target.delete();
          return '校验失败：文件与发布清单不一致，已取消';
        }
      }
      if (wasCancelled()) return await abortCancelled();

      // ── 签名预检（自身 vs 下载 APK；任一读取失败 → 保守取消） ──
      onStage?.call('signature');
      final own = await NativeUpdate.ownSignatureSha256();
      final apk = await NativeUpdate.apkSignatureSha256(target.path);
      if (wasCancelled()) return await abortCancelled();
      if (own == null || apk == null) {
        await target.delete();
        return '无法读取签名信息，已取消更新';
      }
      if (own.toLowerCase() != apk.toLowerCase()) {
        await target.delete();
        return '签名不一致，已取消更新（请先卸载旧版，或使用同签名版本）';
      }

      // ── 拉起安装器前复核（§5.9）：无法复核时不用旧缓存证明启动安装 ──
      if (beforeInstall != null) {
        final blocked = await beforeInstall();
        if (blocked != null && blocked.isNotEmpty) {
          await target.delete();
          return blocked;
        }
      }
      if (wasCancelled()) return await abortCancelled();

      // ── 安装（拉起系统安装器；最终核对交给系统 + 下次启动的真实版本） ──
      onStage?.call('install');
      await NativeUpdate.installApk(target.path);
      return null;
    } catch (e) {
      AppLog.instance.log('Update: 下载/安装失败 $e');
      // 用户取消触发的中断（close 流）不算失败——收敛为 cancelled
      if (cancel?.cancelled == true) return await abortCancelled();
      final err = '$e';
      try {
        if (sink != null) {
          await sink.close();
        }
      } catch (_) {}
      sink = null;
      try {
        if (await target.exists()) await target.delete();
      } catch (_) {}
      return '更新失败：$err';
    } finally {
      try {
        client?.close();
      } catch (_) {}
    }
  }

  /// 读取固定目标下载的错误响应体（`{error, detail}`）并分类。
  static Future<UpdateFailure> _artifactFailureFromResponse(http.StreamedResponse resp) async {
    String? code;
    var detail = '';
    try {
      final text = await resp.stream.bytesToString();
      final body = jsonDecode(text);
      if (body is Map) {
        code = body['error'] is String ? body['error'] as String : null;
        detail = (body['detail'] as String?) ?? '';
      }
    } catch (_) {
      // 非 JSON 错误体（反代 HTML 等）按状态码分类
    }
    return artifactFailure(resp.statusCode, code: code, detail: detail);
  }
}
