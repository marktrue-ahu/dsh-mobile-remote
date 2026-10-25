// App 自动更新 — 纯决策模块（无 I/O，可单测）。
// 职责：版本解析/比较、更新判定（含防降级）、更新源候选构建（host manifest / GitHub release）。
// 下载、校验、签名、安装等有副作用的步骤在调用方（updater / UI）完成。
import 'package:flutter/foundation.dart';

/// 版本号：`major.minor.patch` + 可选 `+build`。
@immutable
class AppVersion {
  final int major;
  final int minor;
  final int patch;
  final int build; // 缺失视为 0
  final bool buildSet; // 原版本串是否显式带 +build（GitHub tag 无 build → false）

  const AppVersion(this.major, this.minor, this.patch,
      {this.build = 0, bool? buildSet})
      : buildSet = buildSet ?? build > 0;

  @override
  String toString() => buildSet ? '$major.$minor.$patch+$build' : '$major.$minor.$patch';
}

/// 解析版本串：容忍 `v` 前缀与 `+build` 后缀；非法返回 null。
/// 例：`v3.0.0` → 3.0.0（buildSet=false）；`3.0.0+8` → 3.0.0+8（buildSet=true）。
AppVersion? parseAppVersion(String input) {
  var s = input.trim();
  if (s.startsWith('v')) s = s.substring(1).trim();
  final plus = s.indexOf('+');
  var build = 0;
  if (plus != -1) {
    final b = s.substring(plus + 1).trim();
    if (b.isEmpty) return null; // 显式 `+` 但无 build → 非法（防畸形 manifest）
    final n = int.tryParse(b);
    if (n == null || n < 0) return null;
    build = n;
    s = s.substring(0, plus).trim();
  }
  final parts = s.split('.');
  if (parts.length != 3) return null;
  final nums = <int>[];
  for (final p in parts) {
    final n = int.tryParse(p.trim());
    if (n == null || n < 0) return null;
    nums.add(n);
  }
  return AppVersion(nums[0], nums[1], nums[2], build: build, buildSet: plus != -1);
}

/// 插件版本格式：`X.Y.Z` + 可选 SemVer prerelease（如 `3.2.1-alpha.1`）
/// + 可选旧式数字 `+build`（与 [parseAppVersion] 的容忍一致）。
///
/// 插件版本串**原样保留**在 [ReleaseArtifact.version] 里，不截断/不改写；
/// App 自身版本仍必须是 `X.Y.Z[+N]`（[parseAppVersion] 不接受 prerelease）。
final RegExp _pluginVersionPattern = RegExp(
  r'^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+\d+)?$',
);

bool _validPluginVersion(String input) {
  var s = input.trim();
  if (s.startsWith('v')) s = s.substring(1).trim(); // 兼容旧 tag 形态
  return _pluginVersionPattern.hasMatch(s);
}

/// 版本比较：a < b → 负；相等 → 0；a > b → 正。先比 major/minor/patch，再比 build。
int compareAppVersion(AppVersion a, AppVersion b) {
  for (final pair in [
    (a.major, b.major),
    (a.minor, b.minor),
    (a.patch, b.patch),
    (a.build, b.build),
  ]) {
    if (pair.$1 != pair.$2) return pair.$1.compareTo(pair.$2);
  }
  return 0;
}

/// 更新判定结果。
enum UpdateVerdict {
  upToDate, // 版本相等：不需要更新
  updateAvailable, // 远端更新：需要更新
  remoteOlder, // 远端低于本地：异常（防降级）
}

/// 比较 major/minor/patch 三段（不含 build）。
int compareMainVersion(AppVersion a, AppVersion b) {
  for (final pair in [
    (a.major, b.major),
    (a.minor, b.minor),
    (a.patch, b.patch),
  ]) {
    if (pair.$1 != pair.$2) return pair.$1.compareTo(pair.$2);
  }
  return 0;
}

/// 判定本地是否需要按远端更新。
/// build 语义：仅当远端显式带 `+build`（buildSet）时才参与 build 比较；
/// 远端无 build（如 GitHub tag v3.0.0）时主版本相等即视为「不提示」——本地热修 build 不会误判为降级。
UpdateVerdict verdictFor({required AppVersion local, required AppVersion remote}) {
  final c = compareMainVersion(local, remote);
  if (c != 0) return c < 0 ? UpdateVerdict.updateAvailable : UpdateVerdict.remoteOlder;
  // 主版本相等：远端未显式带 build → 不提示；都带 build → 按 build 判
  if (!remote.buildSet) return UpdateVerdict.upToDate;
  if (remote.build > local.build) return UpdateVerdict.updateAvailable;
  if (remote.build < local.build) return UpdateVerdict.remoteOlder;
  return UpdateVerdict.upToDate;
}

/// Immutable identities from one normalized publishing manifest, not a source/latest pointer.
@immutable
class ReleaseArtifact {
  const ReleaseArtifact({required this.version, required this.file, required this.size,
    required this.sha256, required this.url, this.contentSha256 = ''});
  final String version;
  final String file;
  final int size;
  final String sha256;
  final String url;
  final String contentSha256;

  static ReleaseArtifact? fromJson(Object? value, {bool plugin = false}) {
    if (value is! Map) return null;
    final version = value['version'];
    final file = value['file'];
    final size = value['size'];
    final hash = value['sha256'];
    final url = value['url'];
    final content = value['contentSha256'];
    if (version is! String ||
        (plugin ? !_validPluginVersion(version) : parseAppVersion(version) == null) ||
        file is! String || file.isEmpty || size is! int || size <= 0 ||
        hash is! String || !_digest.hasMatch(hash) || url is! String || !_absoluteHttp(url) ||
        (plugin && (content is! String || !_digest.hasMatch(content)))) {
      return null;
    }
    return ReleaseArtifact(version: version, file: file, size: size, sha256: hash.toLowerCase(),
      url: url, contentSha256: plugin ? (content as String).toLowerCase() : '');
  }
  Map<String, dynamic> toJson() => {'version': version, 'file': file, 'size': size,
    'sha256': sha256, 'url': url, if (contentSha256.isNotEmpty) 'contentSha256': contentSha256};
}
final _digest = RegExp(r'^[0-9a-fA-F]{64}$');
bool _absoluteHttp(String value) {
  final uri = Uri.tryParse(value);
  return uri != null && const {'http', 'https'}.contains(uri.scheme) && uri.host.isNotEmpty && uri.userInfo.isEmpty;
}

@immutable
class ReleaseSnapshot {
  const ReleaseSnapshot({required this.manifestUrl, required this.app, required this.plugin});
  final String manifestUrl;
  final ReleaseArtifact app;
  final ReleaseArtifact plugin;
  static ReleaseSnapshot? fromJson(Object? value) {
    if (value is! Map || value['schema'] != 1) return null;
    final manifest = value['manifestUrl'];
    final app = ReleaseArtifact.fromJson(value['app']);
    final plugin = ReleaseArtifact.fromJson(value['plugin'], plugin: true);
    if (manifest is! String || !_absoluteHttp(manifest) || app == null || plugin == null) return null;
    return ReleaseSnapshot(manifestUrl: manifest, app: app, plugin: plugin);
  }
  Map<String, dynamic> toJson() => {'schema': 1, 'manifestUrl': manifestUrl,
    'app': app.toJson(), 'plugin': plugin.toJson()};
  UpdateCandidate get candidate => UpdateCandidate(version: app.version, downloadUrl: app.url,
    sizeBytes: app.size, sha256: app.sha256, source: Uri.parse(manifestUrl).host, release: this);
  bool containsCandidate(UpdateCandidate candidate) => candidate.version == app.version &&
    candidate.downloadUrl == app.url && candidate.sizeBytes == app.size && candidate.sha256?.toLowerCase() == app.sha256;
}

/// Resolve a publishing manifest once; callers then persist the normalized snapshot.
ReleaseSnapshot? normalizedReleaseFromManifest(Map<String, dynamic> manifest, {
  required String manifestUrl, String? appUrl, String? pluginUrl,
}) {
  final base = Uri.tryParse(manifestUrl);
  if (base == null || !_absoluteHttp(manifestUrl) || manifest['schema'] != 1) return null;
  Map<String, dynamic>? artifact(Object? value, String? fallback) {
    if (value is! Map) return null;
    final map = Map<String, dynamic>.from(value);
    final explicit = map['url'];
    final location = explicit is String && explicit.isNotEmpty ? explicit : fallback ?? map['file'];
    if (location is! String) return null;
    map['url'] = base.resolve(location).toString();
    return map;
  }
  return ReleaseSnapshot.fromJson({'schema': 1, 'manifestUrl': manifestUrl,
    'app': artifact(manifest['app'], appUrl), 'plugin': artifact(manifest['plugin'], pluginUrl)});
}

/// 宿主下发的**发布定位**（bootstrap 的 `currentRelease` / `updateTarget`，§5.3）。
///
/// App 只消费宿主给出的完整快照与固定地址：`release.app.url` / `release.plugin.url`
/// 都必须是手机可达的宿主地址；固定目标的下载 query 由宿主拼好，App 不自行构造。
@immutable
class ReleasePointer {
  const ReleasePointer({required this.releaseId, required this.release});

  /// 不依赖外部地址的发布标识（宿主计算，用于存储与传输定位）。
  final String releaseId;

  /// 完整 schema 1 快照（两端身份 + 宿主投影后的下载地址）。
  final ReleaseSnapshot release;

  static ReleasePointer? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['releaseId'];
    final release = ReleaseSnapshot.fromJson(value['release']);
    if (id is! String || id.isEmpty || release == null) return null;
    return ReleasePointer(releaseId: id, release: release);
  }

  Map<String, dynamic> toJson() => {'releaseId': releaseId, 'release': release.toJson()};
}

/// **当前发布**的健康确认（bootstrap 的 `currentReleaseHealth`，§5.3）。
///
/// “健康”不是文件指针或哈希相同的别名：既不可是在飞/回滚事务，也要以本实例实际
/// 运行内容为准。缺失（旧宿主）时 App 按“运行内容 + 无矛盾事务”兜底判定。
@immutable
class ReleaseHealth {
  const ReleaseHealth({
    required this.state,
    this.runningContentSha256 = '',
    this.instanceId = '',
    this.transactionOpId = '',
    this.transactionGeneration = 0,
  });

  /// `confirmed` / `waiting` / `failed`；空串表示宿主未给出该字段。
  final String state;

  /// 本实例**实际运行**的插件内容标识（不是磁盘字节）。
  final String runningContentSha256;

  /// 服务实例身份：换实例后旧健康结论不能冒充新的。
  final String instanceId;

  /// 关联事务身份与代际（在飞/回滚矛盾判据）。
  final String transactionOpId;
  final int transactionGeneration;

  bool get confirmed => state == 'confirmed';
  bool get waiting => state == 'waiting';
  bool get failed => state == 'failed' || state == 'error';

  static ReleaseHealth? fromJson(Object? value) {
    if (value is! Map) return null;
    final state = ((value['state'] as String?) ?? '').toLowerCase();
    if (state.isEmpty && value['runningContentSha256'] is! String) return null;
    final tx = value['transaction'];
    var opId = '';
    var generation = 0;
    if (tx is Map) {
      opId = (tx['opId'] as String?) ?? '';
      final g = tx['generation'];
      if (g is int) {
        generation = g;
      } else if (g is num) {
        generation = g.toInt();
      } else if (g is String) {
        generation = int.tryParse(g) ?? 0;
      }
    }
    return ReleaseHealth(
      state: state,
      runningContentSha256: (((value['runningContentSha256'] as String?) ?? '')).toLowerCase(),
      instanceId: (value['instanceId'] as String?) ?? '',
      transactionOpId: opId,
      transactionGeneration: generation,
    );
  }
}

/// APK 分发就绪诊断（`appArtifact`：`ok` / `missing` / `mismatch` + 稳定 reason）。
///
/// 插件健康与 APK 就绪是两件事（§5.10）：缺失/镜像滞后只降级 APK 分发，不影响控制面。
@immutable
class AppArtifactDiagnostic {
  const AppArtifactDiagnostic({required this.state, this.reason = ''});

  final String state;
  final String reason;

  bool get ok => state == 'ok';
  bool get missing => state == 'missing';
  bool get mismatch => state == 'mismatch';

  static AppArtifactDiagnostic? fromJson(Object? value) {
    if (value is! Map) return null;
    final state = ((value['state'] as String?) ?? '').toLowerCase();
    if (state.isEmpty) return null;
    return AppArtifactDiagnostic(state: state, reason: (value['reason'] as String?) ?? '');
  }
}

/// 旧版 App/旧宿主可能留下**外部 Release 资产地址**（GitHub 直连）。
///
/// 新流程只允许宿主投影的固定目标地址（§5.6/§5.9、F19）：遇到外部资产地址时
/// 明确拒绝并提示重新检查，绝不把它再拼成可用下载地址。
String? fixedArtifactUrlIssue(ReleaseSnapshot release) {
  final uri = Uri.tryParse(release.app.url);
  if (uri == null || uri.host.isEmpty || !const {'http', 'https'}.contains(uri.scheme) || uri.userInfo.isNotEmpty) {
    return '固定发布缺少可下载的绝对地址；请重新检查两端版本或升级电脑端插件';
  }
  final host = uri.host.toLowerCase();
  if (host == 'github.com' || host.endsWith('.github.com') || host == 'githubusercontent.com' || host.endsWith('.githubusercontent.com')) {
    return '该固定快照仍指向外部 Release 资产地址（旧流程）；新版 App 只从电脑端固定目标下载，请重新检查两端版本或升级电脑端插件';
  }
  return null;
}

/// 更新候选：App 展示与下载所需的最小集合。
@immutable
class UpdateCandidate {
  final String version; // 展示用版本串（含 build，如 3.0.0+8）
  final String downloadUrl;
  final int? sizeBytes;
  final String? sha256;
  final String? notes;
  final String source; // 展示用来源名：GitHub / 主机
  final ReleaseSnapshot? release;
  const UpdateCandidate({
    required this.version,
    required this.downloadUrl,
    this.sizeBytes,
    this.sha256,
    this.notes,
    required this.source,
    this.release,
  });
}

/// 主机源 API base：baseUrl + 插件挂载路径（与 api._uri 同规则：空/`/` 回退 `/m`，去尾斜杠）。
/// 检查与下载必须用同一 base——挂载路径非默认 `/m` 时硬编码会 404。
String hostApiBase({required String baseUrl, required String mountPath}) {
  var base = baseUrl.trim();
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  var m = mountPath.trim();
  if (m.isEmpty || m == '/') m = '/m';
  while (m.length > 1 && m.endsWith('/')) {
    m = m.substring(0, m.length - 1);
  }
  return '$base$m';
}

/// 从主机源 manifest 构建候选（baseUrl 如 `http://<host>:3080/m`；下载走插件 /api/update/apk）。
UpdateCandidate? candidateFromHostManifest(Map<String, dynamic> manifest,
    {required String baseUrl}) {
  final version = manifest['version'] as String? ?? '';
  final apk = manifest['apk'] as String? ?? '';
  final digest = manifest['sha256'] as String? ?? '';
  if (parseAppVersion(version) == null || apk.isEmpty || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(digest)) return null;
  final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
  return UpdateCandidate(
    version: version,
    downloadUrl: '$base/api/update/apk',
    sizeBytes: (manifest['size'] as num?)?.toInt(),
    sha256: digest,
    notes: manifest['notes'] as String?,
    source: '主机',
  );
}