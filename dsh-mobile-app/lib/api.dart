// DSH Mobile App — API 客户端（对接 dsh-mobile-remote 插件的 /m 接口）
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'logger.dart';
import 'models.dart';
import 'git_models.dart';
import 'plugin_update_status.dart';
import 'update_core.dart';
import 'version_alignment.dart';

class ApiException implements Exception {
  final String message;

  /// v3.0.0：内核错误码（如 queue-item-not-found / steer-unavailable），供 UI 区分语义
  final String? code;

  /// issue #25：HTTP 状态码（仅"服务端确实应答过"的路径有值）。
  /// 命令通路要靠它区分 `commands-execute-failed` 的两种含义：504 = 服务端 AbortSignal 中止
  /// （结果未知，不能断言失败）vs 400 = 命令自己抛错（确定失败）。
  final int? status;
  final Map<String, dynamic>? body;
  ApiException(this.message, {this.code, this.status, this.body});
  @override
  String toString() => message;
}

/// 电脑端**口令生成/落盘失败**（罕见：状态目录不可写等；契约 §5.7 / F21）。
/// 与普通 `auth-required`（口令缺失/错误，重扫一次即可）分开处理。
bool isAuthNotConfigured(ApiException error) {
  if (error.code == 'auth-not-configured') return true;
  final detail = error.message;
  return detail.contains('认证未配置') || detail.contains('auth not configured');
}

/// 口令缺失/错误（`401 auth-required`，或任何 401）：迁移期空口令也走这里，重扫即可。
bool isAuthRequired(Object error) {
  if (error is! ApiException) return false;
  return error.status == 401 ||
      error.code == 'auth-required' ||
      error.code == 'unauthorized';
}

/// 认证类错误 → 专门、可执行的提示；非认证错误返回 null（不能显示成通用网络错误）。
///
/// 契约（§5.7 / F21，2026-10-20 定稿）：
/// - `401 auth-required` 是**普通情况**：口令缺失或错误（迁移期 App 存的是空口令也走这里）
///   → 重新扫电脑连接页的二维码即可；
/// - `401 auth-not-configured` 是**罕见情况**：口令生成/状态落盘失败（状态目录不可写等）
///   → 重扫也拿不到口令，应检查插件状态目录权限，而不是让用户反复重扫。
String? authFixHint(Object error) {
  if (error is! ApiException) return null;
  if (isAuthNotConfigured(error)) {
    return '电脑端访问口令生成或保存失败（认证未配置，控制接口已拒绝访问）。'
        '请检查电脑端插件状态目录的写权限/磁盘空间后重启宿主；此时重扫二维码无效';
  }
  if (isAuthRequired(error)) {
    return '访问口令缺失或未通过验证。请在电脑上打开连接页，用二维码重新扫码连接一次即可继续（插件升级后可能只需重扫一次）';
  }
  return null;
}

/// v3.0.0(热修 05)：客户端 requestId（UUID v4，Random.secure，不引第三方依赖）。
/// 与服务端回执一起构成幂等发送：同一 requestId 重复投递最多执行一次。
String genRequestId() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String h(int i) => b[i].toRadixString(16).padLeft(2, '0');
  return '${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}';
}

/// 全局 API 单例
final Api api = Api();

/// 目录浏览结果：[dirs] 子目录名列表；[sep] 服务端路径分隔符
/// （null = 旧版插件未返回，由调用方按根视图推断，见 sheets.dart dirSepOf）。
typedef DirListing = ({List<String> dirs, List<String> files, String? sep});

abstract interface class GitReadApi {
  Future<GitReadCapabilities> capabilities(String sessionId);
  Future<GitRepository> repository(String sessionId);
  Future<List<GitBranch>> branches(String sessionId, String repositoryId);
  Future<GitGraphPage> graph(
    String sessionId,
    String repositoryId,
    List<GitGraphTip> tips, {
    String? snapshotId,
    String? cursor,
    int limit,
  });
  Future<GitCommitDetails> commitDetails(
    String sessionId,
    String repositoryId,
    String oid, {
    String? filesCursor,
    int filesLimit,
  });
  Future<GitWorktreeSnapshot> worktree(String sessionId, String repositoryId);
  Future<GitFilePreview> preview(
    String sessionId,
    String repositoryId, {
    required String kind,
    required String path,
    String? snapshotId,
    String? oid,
  });
}

class Api implements GitReadApi {
  final http.Client _client;

  Api({http.Client? client}) : _client = client ?? http.Client();

  String baseUrl = '';
  String token = '';

  /// v3.0.0 review：插件挂载路径（默认 /m；由扫描地址/二维码解析，bootstrap 权威校正）。
  String path = '/m';

  /// 电脑端插件版本（bootstrap 返回，设置页「版本」展示用）。
  String pluginVersion = '';

  /// 电脑端**正在运行**的插件内容标识（bootstrap 返回）。
  /// 更新接续据此确认"新实例已健康生效"，而不是只看版本号（评审 R7）。
  String pluginContentSha256 = '';

  /// 电脑端下发的插件自更新状态（含安装形态、能否自更新、降级指引、事务摘要）。
  PluginUpdateStatus pluginUpdate = const PluginUpdateStatus.unknown();

  /// 电脑端**当前发布**（bootstrap 的 `currentRelease`）：releaseId + 完整快照。
  /// 新流程的权威来源：与"正在运行且健康确认"的插件内容配对，用于 App-only 首装/更新。
  ReleasePointer? currentRelease;

  /// 电脑端**更新目标**（bootstrap 的 `updateTarget`）：受信来源解析出的候选发布。
  /// 它可以早于实际安装进入候选状态，但不能提前把当前首装入口指向未生效的插件配对。
  ReleasePointer? updateTarget;

  /// 当前发布的健康确认（`currentReleaseHealth`）。缺失 = 旧宿主，按运行内容兜底。
  ReleaseHealth? currentReleaseHealth;

  /// APK 分发就绪诊断（`appArtifact`；bootstrap 优先，诊断路由兜底）。
  AppArtifactDiagnostic? appArtifact;

  /// 电脑端服务实例身份（`plugin.instanceId`/pid）：核对"服务实例"与旧健康结论。
  String pluginInstanceId = '';

  /// 每次成功吸收 bootstrap 后的回调——**统一的接续入口**（评审 R8）：
  /// 首次连接、SSE 自动重连、下拉刷新、存活探测都走 `absorbBootstrap`，
  /// 因此把"接续推进"挂在这里，就不会漏掉"用户什么都没做、只是自动重连"的路径。
  void Function()? onBootstrapAbsorbed;

  /// 手机端自身版本（`X.Y.Z+build`，启动时由 package_info_plus 填入）。
  /// 随每个请求以 `x-mobile-app-version` 上报：电脑端据此判定两端对齐，
  /// 并在**缺失**时把"旧 App"作为可靠信号（旧版 App 不上报）。
  String appVersion = '';

  /// 两端对齐状态（电脑端下发优先；旧插件不下发时本地自行判定）。
  AppAlignment alignment = const AppAlignment.unknown();

  /// 记录手机端自身版本，并立即重算对齐状态。
  void setAppVersion(String value) {
    appVersion = value;
    alignment = computeAlignment(
      pluginVersion: pluginVersion,
      appVersion: appVersion,
      server: null,
    );
  }

  /// 对话时间线能力由服务端显式声明，不能只按 package version 猜测。
  TimelineCapabilities timelineCapabilities = const TimelineCapabilities();

  /// 电脑的全部候选地址（局域网 IP / Tailscale IP / 127.0.0.1）。
  /// 连接失败时按顺序轮换（外出自动切 Tailscale，回家自动切回局域网）。
  List<String> baseUrls = [];
  static const _kBase = 'dsh_mr_base';
  static const _kPath = 'dsh_mr_path';
  static const _kToken = 'dsh_mr_token';
  static const _kUrls = 'dsh_mr_urls';
  static const _kPluginVer = 'dsh_mr_plugin_ver';
  static const _maxUrls = 8;

  /// 共享 HTTP 客户端：SSE 重连复用同一连接池，避免每次 new Client 泄漏
  /// socket/定时器导致内存耗尽闪退。构造注入仅用于契约测试。

  /// 地址归一：只保留 scheme://host[:port]（路径剥掉）——挂载路径由 [_pathOf] 单独解析。
  static String _normBase(String s) {
    var t = s.trim();
    if (t.isEmpty) return '';
    final u = Uri.tryParse(t);
    if (u != null && u.host.isNotEmpty) {
      return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}';
    }
    // 兜底：非 URL 形态（无 scheme 等），退化为去尾斜杠 + 旧 /m 后缀
    while (t.endsWith('/')) {
      t = t.substring(0, t.length - 1);
    }
    if (t.endsWith('/m')) t = t.substring(0, t.length - 2);
    return t;
  }

  /// 从地址解析挂载路径（默认 /m；根路径 '/' 归一为默认）。
  static String _pathOf(String s) {
    final u = Uri.tryParse(s.trim());
    var p = (u != null ? u.path : '').trim();
    if (p.isEmpty || p == '/') return '/m';
    while (p.length > 1 && p.endsWith('/')) {
      p = p.substring(0, p.length - 1);
    }
    return p;
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    baseUrl = _normBase(prefs.getString(_kBase) ?? '');
    path = prefs.getString(_kPath) ?? '/m';
    token = prefs.getString(_kToken) ?? '';
    pluginVersion = prefs.getString(_kPluginVer) ?? ''; // 上次连接时记录，断线也可见
    final urls = prefs.getStringList(_kUrls) ?? [];
    if (urls.isNotEmpty) {
      baseUrls = urls.map(_normBase).where((u) => u.isNotEmpty).toList();
      if (!baseUrls.contains(baseUrl)) baseUrls.insert(0, baseUrl);
    } else if (baseUrl.isNotEmpty) {
      baseUrls = [baseUrl];
    }
  }

  Future<void> save({required String base, required String token}) async {
    final prefs = await SharedPreferences.getInstance();
    baseUrl = _normBase(base);
    path = _pathOf(base);
    await prefs.setString(_kBase, baseUrl);
    await prefs.setString(_kPath, path);
    await prefs.setString(_kToken, token);
    // 修复：旧版把候选地址表重置为单条。若新地址恰好不可达（如扫到蒲公英 IP
    // 而手机组网没开），连回退的机会都没有。现改为：新地址置首，保留旧候选作兜底。
    final merged = <String>[_normBase(base)];
    for (final u in baseUrls) {
      final n = _normBase(u);
      if (n.isNotEmpty && n != merged.first && merged.length < _maxUrls) {
        merged.add(n);
      }
    }
    baseUrls = merged;
    await prefs.setStringList(_kUrls, baseUrls);
    this.token = token;
  }

  /// 合并新收集到的地址（去重、去回环置后、上限裁剪），当前可用地址保持第一位。
  void mergeUrls(List<String> urls) {
    final seen = <String>{};
    final merged = <String>[_normBase(baseUrl)];
    seen.add(merged.first);
    for (final u in urls) {
      final n = _normBase(u);
      if (n.isEmpty) continue;
      // 排除回环与链路本地地址（含带端口形式）：手机均不可达
      final host = Uri.tryParse(n)?.host ?? '';
      if (host == '127.0.0.1' || host == 'localhost' || host == '::1') continue;
      if (host.startsWith('169.254.')) continue;
      if (seen.add(n)) merged.add(n);
    }
    if (merged.length > _maxUrls) merged.removeRange(_maxUrls, merged.length);
    baseUrls = merged;
    unawaited(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setStringList(_kUrls, baseUrls);
      } catch (_) {}
    }());
  }

  /// 探测某地址是否可达（独立临时客户端，不动全局 baseUrl）。
  /// 返回 null 表示可达；否则返回错误描述。
  Future<String?> probeBase(String base) async {
    try {
      await (Api.forProbe(base, token)).getJson('/api/bootstrap');
      return null;
    } catch (e) {
      return e.toString();
    }
  }

  /// v3.0.0：构造只读探测客户端——地址/路径规范化和 save() 同源逻辑，
  /// 避免"地址含 /m、路径默认 /m"拼接成 `/m/m/...` 而 404。
  static Api forProbe(String base, String token) => Api()
    ..baseUrl = _normBase(base)
    ..path = _pathOf(base)
    ..token = token;

  /// 吸收 bootstrap 响应：合并服务器全部地址 + 记录插件版本（持久化，断线也可见）
  /// + 校正挂载路径（v3.0.0 review：服务端为权威来源）。
  void absorbBootstrap(Map<String, dynamic> d) {
    final urls =
        (d['server']?['urls'] as List?)?.map((u) => u.toString()).toList() ??
        const <String>[];
    mergeUrls(urls);
    final sp = d['server'];
    if (sp is Map &&
        sp['path'] is String &&
        (sp['path'] as String).isNotEmpty) {
      final p = (sp['path'] as String).trim();
      path = p == '/' ? '/m' : p;
      unawaited(() async {
        try {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString(_kPath, path);
        } catch (_) {}
      }());
    }
    final p = d['plugin'];
    if (p is Map && p['version'] is String) {
      pluginVersion = p['version'] as String;
      unawaited(() async {
        try {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString(_kPluginVer, pluginVersion);
        } catch (_) {}
      }());
    }
    final align = d['alignment'];
    alignment = computeAlignment(
      pluginVersion: pluginVersion,
      appVersion: appVersion,
      server: align is Map ? Map<String, dynamic>.from(align) : null,
    );
    final capabilities = d['capabilities'];
    timelineCapabilities = capabilities is Map
        ? TimelineCapabilities.fromJson(
            capabilities['eventTimeline'] is Map
                ? Map<String, dynamic>.from(
                    capabilities['eventTimeline'] as Map,
                  )
                : null,
          )
        : const TimelineCapabilities();
    // 正在运行的内容标识 + 插件自更新状态 + 三角色发布快照：接续/门禁/App 安装的依据
    _absorbUpdateFields(d);
    // 统一接续入口：所有吸收 bootstrap 的路径（首连/自动重连/刷新/探测）都走到这里
    onBootstrapAbsorbed?.call();
  }

  /// 只吸收与**两端更新**有关的字段（bootstrap / 诊断响应同构）。
  ///
  /// 与 [absorbBootstrap] 分开是为了让"下载前/拉起安装器前重新读取当前状态"（§5.9）
  /// 不触发接续回调（否则会在安装中途递归推进 journal）。
  void absorbUpdateState(Map<String, dynamic> d) => _absorbUpdateFields(d);

  void _absorbUpdateFields(Map<String, dynamic> d) {
    final p = d['plugin'];
    if (p is Map) {
      if (p['contentSha256'] is String) {
        pluginContentSha256 = (p['contentSha256'] as String).toLowerCase();
      }
      final instance = p['instanceId'] ?? p['pid'];
      if (instance != null) pluginInstanceId = '$instance';
    }
    pluginUpdate = PluginUpdateStatus.fromJson(d['pluginUpdate']);
    // 三角色发布（§5.3）：当前发布 / 更新目标 / 固定快照分开，旧字段只作兜底。
    currentRelease = ReleasePointer.fromJson(d['currentRelease']);
    updateTarget = ReleasePointer.fromJson(d['updateTarget']);
    currentReleaseHealth = ReleaseHealth.fromJson(d['currentReleaseHealth']);
    // appArtifact 也可能只出现在诊断路由；bootstrap 的值优先。
    appArtifact = _findAppArtifact(d) ?? appArtifact;
  }

  /// `appArtifact` 可能在 bootstrap 顶层、诊断顶层或诊断的 `checks` 段（§5.10）。
  AppArtifactDiagnostic? _findAppArtifact(Map<String, dynamic> d) {
    final direct = AppArtifactDiagnostic.fromJson(d['appArtifact']);
    if (direct != null) return direct;
    final checks = d['checks'];
    if (checks is Map) {
      return AppArtifactDiagnostic.fromJson(checks['appArtifact']);
    }
    return null;
  }

  /// 重新读取电脑端当前状态（下载前 / 拉起安装器前的复核，§5.9）。
  ///
  /// 失败会抛 [ApiException]：调用方必须据此**拒绝继续**，不能靠旧缓存证明启动安装。
  Future<void> refreshUpdateState({Duration timeout = const Duration(seconds: 8)}) async {
    final d = await getJson('/api/bootstrap', timeout: timeout);
    absorbUpdateState(d);
  }

  /// 连接成功后收集电脑全部地址（/api/bootstrap 的 server.urls 含 Tailscale/ZeroTier 等虚拟网段 IP）。
  Future<void> collectUrls() async {
    try {
      final d = await getJson('/api/bootstrap');
      absorbBootstrap(d);
      AppLog.instance.log(
        '地址收集完成：共 ${baseUrls.length} 个 → ${baseUrls.join(' , ')}',
      );
    } catch (_) {
      // 收集失败不影响当前连接
    }
  }

  /// 连接失败时轮换到下一个候选地址；返回是否发生了切换。
  bool rotateBaseUrl() {
    if (baseUrls.length < 2) return false;
    final cur = _normBase(baseUrl);
    final idx = baseUrls.indexOf(cur);
    if (idx < 0) return false;
    final next = baseUrls[(idx + 1) % baseUrls.length];
    if (next == cur) return false;
    baseUrl = next;
    // 持久化新活动地址（失败不影响内存态切换）
    unawaited(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_kBase, baseUrl);
      } catch (_) {}
    }());
    return true;
  }

  /// 插件路由挂在 [path]（默认 /m）下，所有 API 需带该前缀。
  /// 地址与路径分离存储（v3.0.0 review）：路径来自二维码/手动填写解析 + bootstrap 权威校正。
  Uri _uri(String path) {
    var base = baseUrl.trim();
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    var mount = this.path.trim();
    if (mount.isEmpty) mount = '/m';
    if (mount.endsWith('/')) mount = mount.substring(0, mount.length - 1);
    return Uri.parse('$base$mount$path');
  }

  Map<String, String> get _headers => {
    'content-type': 'application/json',
    if (token.isNotEmpty) 'x-mobile-token': token,
    // 电脑端据此判定两端对齐；旧 App 不带这个头，那本身就是"旧 App"的信号
    if (appVersion.isNotEmpty) 'x-mobile-app-version': appVersion,
  };

  Future<Map<String, dynamic>> getJson(
    String path, {
    Duration timeout = const Duration(seconds: 15),
  }) async {
    try {
      final res = await _client
          .get(_uri(path), headers: _headers)
          .timeout(timeout);
      return _decode(res);
    } catch (e) {
      AppLog.instance.log('GET $path 失败: $e');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> postJson(
    String path,
    Map<String, dynamic> body, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    try {
      final res = await _client
          .post(_uri(path), headers: _headers, body: jsonEncode(body))
          .timeout(timeout);
      return _decode(res);
    } catch (e) {
      AppLog.instance.log('POST $path 失败: $e');
      rethrow;
    }
  }

  // ── v3.1.2（csborbbnc 反馈）：文件传输 ──
  /// 下载电脑文件（返回原始字节；失败抛 ApiException）。
  Future<Uint8List> downloadFile(
    String path, {
    Duration timeout = const Duration(seconds: 120),
  }) async {
    try {
      final res = await _client
          .get(
            _uri('/api/files?path=${Uri.encodeQueryComponent(path)}'),
            headers: _headers,
          )
          .timeout(timeout);
      if (res.statusCode != 200) {
        Map<String, dynamic>? body;
        try {
          body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
        } catch (_) {
          body = null;
        }
        throw ApiException(
          (body?['detail'] as String?) ?? 'HTTP ${res.statusCode}',
          code: body?['error'] is String ? (body?['error'] as String) : null,
          status: res.statusCode,
        );
      }
      return res.bodyBytes;
    } catch (e) {
      AppLog.instance.log('GET /api/files 失败: $e');
      rethrow;
    }
  }

  /// 上传文件到会话工作目录（base64，服务端写盘；返回 {path, bytes}）。
  Future<Map<String, dynamic>> uploadFile(
    String sessionId,
    String name,
    Uint8List bytes, {
    Duration timeout = const Duration(minutes: 3),
  }) async {
    return await postJson('/api/files/upload', {
      'sessionId': sessionId,
      'name': name,
      'data': base64Encode(bytes),
    }, timeout: timeout);
  }

  /// v3.1.2：发送测试通知（逐个通道验证，绕过节流；返回 {channels, results[]}）。
  Future<Map<String, dynamic>> pushTest() async =>
      await postJson('/api/push-test', {});

  Map<String, dynamic> _decode(http.Response res) {
    // v2.9.0 review(LOW#7)：非 JSON 错误体（反代 HTML 页等）不再抛 FormatException，回退 HTTP <status>
    Map<String, dynamic>? body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      body = null;
    }
    if (res.statusCode != 200) {
      throw ApiException(
        (body?['detail'] as String?) ??
            (body?['error'] as String?) ??
            'HTTP ${res.statusCode}',
        code: body?['error'] is String ? (body?['error'] as String) : null,
        status: res.statusCode,
        body: body,
      );
    }
    if (body == null) {
      throw ApiException('HTTP ${res.statusCode}', status: res.statusCode);
    }
    return body;
  }

  // ── 业务接口 ──
  Future<Catalog> catalog({bool refresh = false}) async =>
      Catalog.fromJson(await getJson(refresh ? '/api/catalog?refresh=1' : '/api/catalog'));
  Future<SessionConfig> sessionConfig(
    String sessionId,
  ) async => SessionConfig.fromJson(
    (await getJson(
              '/api/session-config?sessionId=${Uri.encodeQueryComponent(sessionId)}',
            ))['config']
            as Map<String, dynamic>? ??
        {},
  );
  Future<void> updateSessionConfig(
    String sessionId,
    Map<String, dynamic> patch,
  ) async {
    await postJson('/api/session-config', {'sessionId': sessionId, ...patch});
  }

  /// 自动更新（主机源）：读取 updateDir 的 manifest。端点 503/404 会抛 ApiException（error code 可供提示）。
  Future<Map<String, dynamic>> updateManifest() async {
    final d = await getJson('/api/update/manifest');
    return (d['manifest'] as Map<String, dynamic>?) ?? const {};
  }

  /// Only the trusted host artifact routes may receive the host token, never external URLs.
  Map<String, String> artifactHeaders(Uri uri) {
    final mount = path == '/' || path.isEmpty ? '/m' : path.replaceFirst(RegExp(r'/$'), '');
    // baseUrl 可能为空（绝对 URL 候选）：这时没有"本机 origin"可言，绝不带口令。
    final origin = baseUrl.isEmpty ? null : Uri.tryParse(baseUrl);
    final sameOrigin = origin != null && origin.hasScheme && uri.origin == origin.origin;
    return {'User-Agent': 'dsh-mobile-remote-app',
      if (sameOrigin && uri.path.startsWith('$mount/api/update/') && token.isNotEmpty) 'x-mobile-token': token};
  }

  Future<Map<String, dynamic>> getAbsoluteJson(String url) async {
    var uri = Uri.parse(url);
    for (var redirects = 0; redirects <= 5; redirects++) {
      final localOrigin = baseUrl.isEmpty ? null : Uri.tryParse(baseUrl);
      final isLocalHttp = localOrigin != null && localOrigin.hasScheme && uri.scheme == 'http' && uri.origin == localOrigin.origin;
      if (uri.host.isEmpty || uri.userInfo.isNotEmpty || (uri.scheme != 'https' && !isLocalHttp)) {
        throw ApiException('不安全的清单 URL');
      }
      final request = http.Request('GET', uri)..followRedirects = false;
      request.headers.addAll(artifactHeaders(uri));
      final response = await _client.send(request).timeout(const Duration(seconds: 15));
      if (const {301, 302, 303, 307, 308}.contains(response.statusCode)) {
        final next = response.headers['location'];
        await response.stream.drain<void>();
        if (next == null) throw ApiException('清单重定向缺少地址');
        uri = uri.resolve(next);
        continue;
      }
      return _decode(await http.Response.fromStream(response));
    }
    throw ApiException('清单重定向次数过多');
  }

  /// 触发**电脑端插件自更新**（ADR 0019：手机可独立触发，不需要坐到电脑前）。
  /// 返回 `{action, opId?, check?}`；服务端**先应答、再后台推进**，因此超时不代表没开始
  /// ——带同一个 [opId] 重试是幂等的，重连后凭它查询同一事务（评审 R6/R10）。
  Future<Map<String, dynamic>> triggerPluginUpdate({String opId = ''}) =>
      postJson(
        '/api/plugin-update',
        <String, dynamic>{if (opId.isNotEmpty) 'opId': opId},
        timeout: const Duration(seconds: 15),
      );

  // ── v2.6：模型提供商（与 PC 端 设置→模型 同一配置通道） ──
  /// 提供商列表（含 dormant 未激活项、baseURL、密钥状态）。
  Future<List<Map<String, dynamic>>> llmProviders() async {
    final data = await getJson('/api/llm-providers');
    return (data['providers'] as List? ?? []).cast<Map<String, dynamic>>();
  }

  /// 探测端点模型列表（凭据一次性使用，不存储）。
  Future<List<Map<String, dynamic>>> probeLlmProvider({
    required String settingsNs,
    required String baseURL,
    String? apiKey,
    String? protocol,
  }) async {
    final data = await postJson('/api/llm-providers/probe', {
      'settingsNs': settingsNs,
      'baseURL': baseURL,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      if (protocol != null && protocol.isNotEmpty) 'protocol': protocol,
    });
    return (data['models'] as List? ?? []).cast<Map<String, dynamic>>();
  }

  /// 保存提供商配置（baseURL / API Key / 模型目录）。
  /// [removeKey] 为 true 时清除已存密钥；[models] 为模型列表（[{id, name?}] 或字符串）。
  Future<void> saveLlmProvider({
    required String provider,
    required String settingsNs,
    String? baseURL,
    String? apiKey,
    List<Map<String, dynamic>>? models,
    String? api,
    String? displayName,
    bool removeKey = false,
  }) async {
    await postJson('/api/llm-providers', {
      'provider': provider,
      'settingsNs': settingsNs,
      if (baseURL != null && baseURL.isNotEmpty) 'baseURL': baseURL,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      if (models != null && models.isNotEmpty) 'models': models,
      if (api != null && api.isNotEmpty) 'api': api,
      if (displayName != null && displayName.isNotEmpty)
        'displayName': displayName,
      if (removeKey) 'removeKey': true,
    });
  }

  Future<List<Session>> sessions() async {
    final data = await getJson('/api/sessions');
    return (data['sessions'] as List? ?? [])
        .map((e) => Session.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// 标记会话被打开（服务端记录活跃时间，用于"最近会话"排序）。失败静默。
  Future<void> touchSession(String sessionId) async {
    try {
      await postJson('/api/sessions/touch', {'sessionId': sessionId});
    } catch (_) {
      // 旧版插件无此端点：不影响打开会话
    }
  }

  // ── v2.7：任务（jobs）/ 子代理 / 目标 ──
  /// 会话任务列表（SSE session/jobs 帧已实时推送，此端点用于下拉刷新兜底）。
  Future<List<Map<String, dynamic>>> jobs(String sessionId) async {
    final data = await getJson(
      '/api/jobs?sessionId=${Uri.encodeQueryComponent(sessionId)}',
    );
    return (data['jobs'] as List? ?? []).cast<Map<String, dynamic>>();
  }

  /// 会话任务清单（v3.1.4，issue #12 姊妹需求）：读内核 todo 投影（与 PC 端「任务」面板同源）。
  /// 返回 null = 该会话未激活/旧内核无该工具 —— 调用方退回历史事件折叠，不视为错误。
  Future<List<Map<String, dynamic>>?> todos(String sessionId) async {
    final data = await getJson(
      '/api/todos?sessionId=${Uri.encodeQueryComponent(sessionId)}',
    );
    final list = data['todos'];
    if (list is! List) return null;
    return list.cast<Map<String, dynamic>>();
  }

  /// 取消任务。
  Future<void> jobKill(String sessionId, String jobId) async {
    await postJson('/api/jobs/kill', {'sessionId': sessionId, 'jobId': jobId});
  }

  /// 子代理列表（按父会话查询，与内核 subagent.list 契约一致）。
  Future<List<Map<String, dynamic>>> subagents(String parentSessionId) async {
    final data = await getJson(
      '/api/subagents?parentSessionId=${Uri.encodeQueryComponent(parentSessionId)}',
    );
    return (data['subagents'] as List? ?? []).cast<Map<String, dynamic>>();
  }

  /// 中断子代理（内核契约：parentSessionId + childSessionId + mode=continuable）。
  Future<void> subagentInterrupt(
    String parentSessionId,
    String childSessionId,
  ) async {
    await postJson('/api/subagents/interrupt', {
      'parentSessionId': parentSessionId,
      'childSessionId': childSessionId,
    });
  }

  /// 当前目标。
  Future<Map<String, dynamic>?> goal(String sessionId) async {
    final data = await getJson(
      '/api/goal?sessionId=${Uri.encodeQueryComponent(sessionId)}',
    );
    return data['goal'] as Map<String, dynamic>?;
  }

  /// 目标操作：create / pause / resume / complete（sessionId 必填，与内核 goal RPC 契约一致）。
  Future<void> goalAction(
    String action, {
    required String sessionId,
    String? objective,
    int? maxGoalRounds,
  }) async {
    await postJson('/api/goal', {
      'action': action,
      'sessionId': sessionId,
      'objective': ?objective,
      'maxGoalRounds': ?maxGoalRounds,
    });
  }

  /// 归档 / 恢复会话（服务端持久化）。
  Future<void> archiveSession(String sessionId, {required bool archive}) async {
    await postJson(
      archive ? '/api/sessions/archive' : '/api/sessions/unarchive',
      {'sessionId': sessionId},
    );
  }

  /// 停止（取消）会话当前运行：对齐 PC 端"停止"按钮（映射 session.cancel）。
  Future<void> stopSession(String sessionId) async {
    await postJson('/api/sessions/stop', {'sessionId': sessionId});
  }

  /// 在新对话中分支（映射内核 session.fork，atSeq 锚定切点），返回子会话 id。
  Future<String> forkSession(String sessionId, {int? atSeq}) async {
    final r = await postJson('/api/sessions/fork', {
      'sessionId': sessionId,
      'atSeq': ?atSeq,
    });
    return r['sessionId'] as String? ?? '';
  }

  /// 消息反馈（👍/👎）：直接写内核 messageFeedback 服务（与 PC 端同一份数据）。
  Future<void> putFeedback(
    String sessionId,
    String messageId,
    String rating,
  ) async {
    await postJson('/api/feedback', {
      'sessionId': sessionId,
      'messageId': messageId,
      'rating': rating,
    });
  }

  /// v2.8.0：斜杠命令目录（对齐 PC 端 ctx.commands）。
  /// v2.9.0 review(LOW#13)：返回 (命令列表, unavailable)——服务端 commands 服务缺失时
  /// unavailable=true，UI 应提示"命令服务不可用"而非"无可用命令"。
  Future<(List<Map<String, dynamic>>, bool)> commands(String sessionId) async {
    final data = await getJson(
      '/api/commands?sessionId=${Uri.encodeQueryComponent(sessionId)}',
    );
    return (
      (data['commands'] as List? ?? []).cast<Map<String, dynamic>>(),
      data['unavailable'] == true,
    );
  }

  /// v2.8.0：执行斜杠命令（line 形如 "/plan 目标"）。
  /// issue #25：提交时（`_send` 判定为命令行且名字在命令目录里）与 ⊕ 菜单里的裸命令都走这里。
  /// 服务端把整条命令的上限放宽到 180s（`/compact` 要等内核跑完一次完整 LLM 摘要），客户端
  /// 必须比它更晚放弃（200s）——否则会在服务端收敛前先本地超时，把"已提交、结果未知"误报成失败。
  Future<Map<String, dynamic>?> runCommand(
    String sessionId,
    String line, {
    Duration timeout = const Duration(seconds: 200),
  }) async {
    return await postJson('/api/commands', {
      'sessionId': sessionId,
      'line': line,
    }, timeout: timeout);
  }

  Future<Map<String, dynamic>> createSession(Map<String, dynamic> body) async =>
      await postJson('/api/sessions', body);

  /// v2.7.2：排队中消息列表（对齐 PC 端 Queue Dock）。
  Future<List<Map<String, dynamic>>> queue(
    String sessionId, {
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final data = await getJson(
      '/api/queue?sessionId=${Uri.encodeQueryComponent(sessionId)}',
      timeout: timeout,
    );
    return (data['queue'] as List? ?? []).cast<Map<String, dynamic>>();
  }

  /// v2.7.2：对排队中消息操作（edit / remove / steer，对齐 PC 端 session.updateQueue）。
  Future<void> updateQueueMessage(
    String sessionId,
    String itemId,
    Map<String, dynamic> action,
  ) async {
    await postJson('/api/messages', {
      'sessionId': sessionId,
      'itemId': itemId,
      'action': action,
    });
  }

  /// v3.0.0：返回 (messageId, note, configDegraded)。note=held-until-idle 表示消息被插件持存
  /// （运行中排队，任务结束才释放）——排队消息不进对话窗口，只进 dock（与 PC 端一致）。
  /// v3.1.5：configDegraded=true 表示休眠会话（seeded 降级）的模型/权限/预设折叠失败、
  /// 服务端已回退默认配置——调用方必须提示用户，否则配置被静默改写。
  Future<(String, String?, bool)> send(
    String sessionId,
    String text, {
    String mode = 'followup',
    String? requestId,
  }) async {
    // v2.7.2：mode=steer 插队发送（插到 agent 下一步执行）；默认 followup 排队
    final r = await postJson('/api/send', {
      'sessionId': sessionId,
      'text': text,
      if (mode == 'steer') 'mode': 'steer',
      'requestId': ?requestId,
    });
    return (
      r['messageId'] as String? ?? '',
      r['note'] as String?,
      r['configDegraded'] == true,
    );
  }

  /// v3.0.0 图像链路：发送文本+图片（原始文件字节 base64，与 PC 端 wire 同形；不压缩）。
  /// 返回 (accepted, note, configDegraded)；configDegraded 语义同 [send]。
  Future<(bool, String?, bool)> sendImages(
    String sessionId,
    String text,
    List<Map<String, dynamic>> images, {
    String mode = 'followup',
    String? requestId,
  }) async {
    final r = await postJson('/api/send', {
      'sessionId': sessionId,
      'text': text,
      'images': images,
      if (mode == 'steer') 'mode': 'steer',
      'requestId': ?requestId,
    }, timeout: const Duration(seconds: 90));
    return (
      r['accepted'] == true,
      r['note'] as String?,
      r['configDegraded'] == true,
    );
  }

  /// v3.0.0(热修 05)：发送回执查询——网络层错误（reset/超时）后据此判断是否已送达。
  /// 未命中返回 404 receipt-not-found（ApiException.code 同值）；命中返回 { status, result }。
  Future<Map<String, dynamic>> sendReceipt(
    String sessionId,
    String requestId, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final data = await getJson(
      '/api/send-receipt?sessionId=${Uri.encodeQueryComponent(sessionId)}&requestId=${Uri.encodeQueryComponent(requestId)}',
      timeout: timeout,
    );
    return (data['receipt'] as Map<String, dynamic>?) ?? const {};
  }

  /// v3.0.0 图像链路：拉取图片字节（渲染用），带 LRU 缓存（64 张）。
  final Map<String, Uint8List> _imgCache = {};
  final List<String> _imgOrder = [];
  static const _imgCacheMax = 64;
  Future<Uint8List> attachmentBytes(
    String sessionId,
    String attachmentId,
  ) async {
    final key = '$sessionId/$attachmentId';
    final hit = _imgCache[key];
    if (hit != null) return hit;
    final res = await _client
        .get(
          _uri(
            '/api/attachment?sessionId=${Uri.encodeQueryComponent(sessionId)}'
            '&attachmentId=${Uri.encodeQueryComponent(attachmentId)}',
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) {
      throw ApiException(
        'HTTP ${res.statusCode}',
        code: 'attachment-fetch-failed',
      );
    }
    final bytes = res.bodyBytes;
    if (bytes.isEmpty) throw ApiException('empty attachment');
    _imgCache[key] = bytes;
    _imgOrder.remove(key);
    _imgOrder.add(key);
    if (_imgOrder.length > _imgCacheMax) {
      final evict = _imgOrder.removeAt(0);
      _imgCache.remove(evict);
    }
    return bytes;
  }

  /// 拉历史页。移动端默认取最近 100 条（服务端 limit 截断取尾部=最近的），
  /// 避免一次解析/渲染数百条事件导致手机卡死。
  /// 服务端返回 `hasMore`（durable cursor 分页）与 `degraded`/`historyMode`
  /// （v3.1.5 休眠会话 current-surface 降级标记：历史可能不完整）。
  Future<HistoryPage> historyPage(
    String sessionId, {
    int? after,
    int? before,
    int limit = 100,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final params =
        'sessionId=${Uri.encodeQueryComponent(sessionId)}'
        '${after != null ? '&after=$after' : ''}${before != null ? '&before=$before' : ''}&limit=$limit';
    final data = await getJson('/api/history?$params', timeout: timeout);
    return HistoryPage(
      events: (data['events'] as List? ?? [])
          .whereType<Map>()
          .map((e) => ChatEvent.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      hasMore: data['hasMore'] == true,
      // v3.1.5：休眠会话降级读取标记（current surface）——历史可能不完整
      degraded: data['degraded'] == true,
      historyMode: data['historyMode'] as String?,
    );
  }

  /// 兼容旧调用方的历史列表接口。
  Future<List<ChatEvent>> history(
    String sessionId, {
    int? after,
    int? before,
    int limit = 100,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    return (await historyPage(
      sessionId,
      after: after,
      before: before,
      limit: limit,
      timeout: timeout,
    )).events;
  }

  /// 按 seq 读取一条无损事件详情。详情不可用时由调用方显示明确降级状态。
  Future<EventDetail> eventDetail(
    String sessionId,
    int seq, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final data = await getJson(
      '/api/event-detail?sessionId=${Uri.encodeQueryComponent(sessionId)}&seq=$seq',
      timeout: timeout,
    );
    final event = data['event'];
    if (event is! Map || event['type'] is! String) {
      throw ApiException(
        'event detail unavailable',
        code: 'event-detail-unavailable',
      );
    }
    return EventDetail(
      event: Map<String, dynamic>.from(event),
      degraded: data['degraded'] == true,
      detailMode: data['detailMode'] as String?,
    );
  }

  Future<List<AppNotification>> notifications() async {
    final data = await getJson('/api/notifications');
    return (data['items'] as List? ?? [])
        .map((e) => AppNotification.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> markNotifsRead({List<String>? ids, bool all = false}) async {
    await postJson(
      '/api/notifications/read',
      all ? {'all': true} : {'ids': ids ?? []},
    );
  }

  /// 删除通知记录：指定 id 列表或全部（插件端 /notifications/delete，桌面端重启后生效）。
  Future<void> deleteNotifs({List<String>? ids, bool all = false}) async {
    await postJson(
      '/api/notifications/delete',
      all ? {'all': true} : {'ids': ids ?? []},
    );
  }

  /// 回答内核问询/审批（kind: question | approval | cancel），走与 PC 端 GUI 相同的 respond 通道。
  Future<Map<String, dynamic>> respond({
    required String kind,
    required String rpcId,
    required String sessionId,
    List<Map<String, dynamic>>? answers,
    String? approvalId,
    String? outcome,
  }) async {
    final body = <String, dynamic>{
      'kind': kind,
      'rpcId': rpcId,
      'sessionId': sessionId,
    };
    if (answers != null) body['answers'] = answers;
    if (approvalId != null) body['approvalId'] = approvalId;
    if (outcome != null) body['outcome'] = outcome;
    return await postJson('/api/respond', body);
  }

  Future<double?> balance() async {
    try {
      final data = await getJson('/api/balance');
      final infos = data['balance']?['balance_infos'] as List? ?? [];
      if (infos.isEmpty) return null;
      final total = (infos.first as Map<String, dynamic>)['total_balance'];
      return total is num
          ? total.toDouble()
          : double.tryParse(total.toString());
    } on ApiException {
      rethrow;
    }
  }

  /// 余额详情（含币种/可用标记），查询失败返回 null。
  Future<Map<String, dynamic>?> balanceInfo() async {
    try {
      // 余额是电脑端代查官方 API，链路可能慢（官方接口抖动 + 组网隧道延迟），放宽到 25 秒
      final data = await getJson(
        '/api/balance',
        timeout: const Duration(seconds: 25),
      );
      final infos = data['balance']?['balance_infos'] as List? ?? [];
      if (infos.isEmpty) return null;
      final first = infos.first as Map<String, dynamic>;
      final total = first['total_balance'];
      return {
        'total': total is num
            ? total.toDouble()
            : double.tryParse(total.toString()) ?? 0,
        'currency': first['currency'] ?? 'CNY',
        'available': first['is_available'] ?? true,
      };
    } on ApiException {
      rethrow;
    }
  }

  /// 设置页用量与额度：服务端只返回最新查询成功的来源，不返回任何凭据。
  /// [refresh] 为 true 时绕过电脑端 60 秒运行期缓存，用于详情页手动刷新。
  Future<UsageSnapshot> accountUsage({
    bool refresh = false,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final path = refresh
        ? '/api/account-usage?refresh=1'
        : '/api/account-usage';
    return UsageSnapshot.fromJson(await getJson(path, timeout: timeout));
  }

  /// 修改默认配置（Agent 预设 / 权限预设，作用于之后新建的会话）。
  Future<void> updateDefaults({
    String? agentPreset,
    String? permissionPreset,
  }) async {
    await postJson('/api/defaults', {
      'agentPreset': ?agentPreset,
      'permissionPreset': ?permissionPreset,
    });
  }

  /// 会话 token 用量统计（服务端聚合）+ 上下文窗口（request/context 事件，PC 圆环同源）。
  Future<Map<String, dynamic>> usage(String sessionId) async {
    final data = await getJson(
      '/api/usage?sessionId=${Uri.encodeQueryComponent(sessionId)}',
    );
    return {
      ...(data['usage'] as Map<String, dynamic>? ?? {}),
      if (data['contextWindow'] != null) 'contextWindow': data['contextWindow'],
    };
  }

  /// 移动端动作注册表（插件提供）。
  Future<List<Map<String, dynamic>>> actions() async {
    final data = await getJson('/api/actions');
    return (data['actions'] as List? ?? [])
        .map((e) => e as Map<String, dynamic>)
        .toList();
  }

  /// 执行一个动作。
  Future<void> invokeAction(String id, Map<String, dynamic> args) async {
    await postJson('/api/actions/${Uri.encodeQueryComponent(id)}/invoke', {
      'args': args,
    });
  }

  /// 已注册工作区列表：[{path, title?}]。
  Future<List<Map<String, dynamic>>> workspaces() async {
    final data = await getJson('/api/workspaces');
    return (data['workspaces'] as List? ?? [])
        .map((e) => e as Map<String, dynamic>)
        .toList();
  }

  /// 目录浏览：path 为空返回盘符/根；否则返回子目录名列表（附服务端分隔符，v3.1.1；
  /// v3.1.2 增返回 files 文件列表，供文件选择器使用）。
  Future<DirListing> directories(String path) async {
    final data = await getJson(
      '/api/directories?path=${Uri.encodeQueryComponent(path)}',
    );
    return (
      dirs: (data['dirs'] as List? ?? []).map((e) => e.toString()).toList(),
      files: (data['files'] as List? ?? []).map((e) => e.toString()).toList(),
      sep: data['sep'] is String ? data['sep'] as String : null,
    );
  }

  /// 新建文件夹。
  Future<void> createDirectory({String? path, required String name}) async {
    await postJson('/api/directories', {'path': path, 'name': name});
  }

  String _gitQuery(String route, Map<String, String> parameters) =>
      '$route?${Uri(queryParameters: parameters).query}';

  @override
  Future<GitReadCapabilities> capabilities(String sessionId) async {
    final data = await getJson(
      _gitQuery('/api/git/capabilities', {'sessionId': sessionId}),
    );
    final value = data['git'];
    return GitReadCapabilities.fromJson(
      value is Map ? Map<String, dynamic>.from(value) : data,
    );
  }

  @override
  Future<GitRepository> repository(String sessionId) async {
    final data = await getJson(
      _gitQuery('/api/git/repository', {'sessionId': sessionId}),
    );
    final value = data['repository'];
    return GitRepository.fromJson(
      value is Map ? Map<String, dynamic>.from(value) : data,
    );
  }

  @override
  Future<List<GitBranch>> branches(
    String sessionId,
    String repositoryId,
  ) async {
    final data = await getJson(
      _gitQuery('/api/git/branches', {
        'sessionId': sessionId,
        'repositoryId': repositoryId,
      }),
    );
    return List.unmodifiable(
      (data['branches'] as List? ?? const []).whereType<Map>().map(
        (item) => GitBranch.fromJson(Map<String, dynamic>.from(item)),
      ),
    );
  }

  @override
  Future<GitGraphPage> graph(
    String sessionId,
    String repositoryId,
    List<GitGraphTip> tips, {
    String? snapshotId,
    String? cursor,
    int limit = 100,
  }) async => GitGraphPage.fromJson(
    await getJson(
      _gitQuery('/api/git/graph', {
        'sessionId': sessionId,
        'repositoryId': repositoryId,
        'tips': jsonEncode(tips.map((tip) => tip.toJson()).toList()),
        'snapshotId': ?snapshotId,
        'cursor': ?cursor,
        'limit': '$limit',
      }),
    ),
  );

  @override
  Future<GitCommitDetails> commitDetails(
    String sessionId,
    String repositoryId,
    String oid, {
    String? filesCursor,
    int filesLimit = 100,
  }) async => GitCommitDetails.fromJson(
    await getJson(
      _gitQuery('/api/git/commit', {
        'sessionId': sessionId,
        'repositoryId': repositoryId,
        'oid': oid,
        'filesCursor': ?filesCursor,
        'filesLimit': '$filesLimit',
      }),
    ),
  );

  @override
  Future<GitWorktreeSnapshot> worktree(
    String sessionId,
    String repositoryId,
  ) async => GitWorktreeSnapshot.fromJson(
    await getJson(
      _gitQuery('/api/git/worktree', {
        'sessionId': sessionId,
        'repositoryId': repositoryId,
      }),
    ),
  );

  @override
  Future<GitFilePreview> preview(
    String sessionId,
    String repositoryId, {
    required String kind,
    required String path,
    String? snapshotId,
    String? oid,
  }) async => GitFilePreview.fromJson(
    await getJson(
      _gitQuery('/api/git/preview', {
        'sessionId': sessionId,
        'repositoryId': repositoryId,
        'kind': kind,
        'path': path,
        'snapshotId': ?snapshotId,
        'oid': ?oid,
      }),
    ),
  );

  Future<Map<String, dynamic>?> diagnostics() async {
    try {
      final d = await getJson('/api/diagnostics');
      // appArtifact 也可能只出现在诊断路由（bootstrap 优先，这里只补缺）。
      final artifact = _findAppArtifact(d);
      if (artifact != null) appArtifact = artifact;
      return d;
    } catch (_) {
      return null;
    }
  }

  /// SSE 全量帧流（session/event + agent/status + hello），不做会话过滤。
  /// 帧格式与网页端一致：{type: "hello"|"session/event"|"agent/status", ...}。
  /// 解析：StringBuffer 累积，每 chunk 处理全部完整帧，剩余部分保留。
  /// （旧实现 while 循环内不更新缓冲区，收到 ≥2 帧后同一帧无限处理 → 死循环）
  /// SSE 保活回调：收到服务器心跳（`: ping` 注释行）或任何数据帧时触发。
  /// 用于连接存活性看门狗（网络静默丢包时 TCP 不会立刻报错，靠心跳超时强制重连）。
  void Function()? onSseKeepalive;

  Stream<Map<String, dynamic>> eventsRaw() {
    // v2.7.2 review(FS3)：onCancel 必须取消底层响应流订阅，否则订阅取消后
    // await-for 消费循环仍读 socket → 每条 SSE 长连接在 App 存活期间永不释放
    StreamSubscription<dynamic>? bodySub;
    // v2.9.0 review(M6)：连接窗口期（超时看门狗已触发/订阅已取消）内晚到的响应
    // 也必须立即取消——旧实现 .then 挂在 timeout 包装链上，超时后 response 无人消费，
    // 跨重连会累积半开 socket
    var timedOut = false;
    // v3.1.5 修复：`controller.isClosed` **判不出"订阅已取消"** —— Dart SDK 里流控制器
    // 的 `_STATE_CANCELED(2)` 与 `_STATE_CLOSED(4)` 是两回事，`isClosed` 只查 closed 位，
    // 取消后仍为 false，且取消后的 `add()` 不抛错（帧被静默丢弃）。窗口期内 `onCancel`
    // 跑得比这行早，`bodySub` 还是 null 什么都不做，于是晚到的响应会挂上一条**没人再取消**
    // 的响应流 → 每条泄漏连接的 TCP 都是活的（服务端靠 res.on("close") 清理，永不触发），
    // 累积到服务端 maxConnections 后手机直接 503 连不上（症状：必须把 App 划掉重开）。
    // 显式标志位补上这一位。
    var cancelled = false;
    final controller = StreamController<Map<String, dynamic>>(
      onCancel: () {
        cancelled = true;
        bodySub?.cancel();
      },
    );
    final req = http.Request('GET', _uri('/api/events'));
    req.headers.addAll(_headers);
    // 连接超时：地址不可达但"黑洞"（不拒绝也不响应，如组网 IP 在手机端隧道关闭时）会让
    // send() 永久挂起，旧版因此卡死在 connecting 状态、看门狗与地址轮换全部失效。
    // 8 秒足够（正常服务器毫秒级回响应），失败越快轮换越快。
    final timeoutWatchdog = Timer(const Duration(seconds: 8), () {
      timedOut = true;
      if (!controller.isClosed) {
        controller.addError(ApiException('SSE 连接超时'));
        controller.close();
      }
    });
    _client
        .send(req)
        .then((res) {
          if (timedOut || cancelled || controller.isClosed) {
            // 晚到的响应/已取消：立即消费并释放，不留半开 socket
            res.stream.listen((_) {}).cancel();
            return;
          }
          if (res.statusCode != 200) {
            if (!controller.isClosed) {
              controller.addError(ApiException('SSE HTTP ${res.statusCode}'));
              controller.close();
            }
            return;
          }
          final stream = res.stream.transform(utf8.decoder);
          final buf = StringBuffer();
          bodySub = stream.listen(
            (chunk) {
              buf.write(chunk);
              var s = buf.toString();
              var idx = s.indexOf('\n\n');
              while (idx >= 0) {
                final frame = s.substring(0, idx);
                s = s.substring(idx + 2);
                idx = s.indexOf('\n\n');
                if (frame.startsWith('data: ')) {
                  onSseKeepalive?.call();
                  try {
                    controller.add(
                      jsonDecode(frame.substring(6)) as Map<String, dynamic>,
                    );
                  } catch (_) {
                    /* 忽略坏帧 */
                  }
                } else if (frame.trim() == ': ping') {
                  onSseKeepalive?.call();
                }
              }
              buf
                ..clear()
                ..write(s);
            },
            onDone: () {
              if (!controller.isClosed) controller.close();
            },
            onError: (e) {
              if (!controller.isClosed) controller.addError(e);
            },
            cancelOnError: true,
          );
        })
        .catchError((e) {
          if (!controller.isClosed) {
            controller.addError(e);
            controller.close();
          }
        })
        .whenComplete(() {
          timeoutWatchdog.cancel();
        });
    return controller.stream;
  }
}
