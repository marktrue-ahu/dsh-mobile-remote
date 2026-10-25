/// 两端对齐状态（CONTEXT「对齐提示」）。
///
/// 判据是**版本号**，且只决定提示文案——不参与任何能力可用性判定
/// （能力看声明，见 ADR 0017 与 ADR 0019 的三条判据分离）。
///
/// 电脑端会算好一份随 bootstrap 下发；但**旧插件不会下发**，而"插件旧于 App"
/// 恰恰是旧插件自己说不出来的那一侧，所以客户端必须能自己算一份。
///
/// 比较只看语义版本 core `X.Y.Z`：App 的 `+build` 是它自己的构建号，同一发布周期内
/// 每次构建都不同，比进去会把提示刷成噪声；插件版本的 SemVer prerelease
/// （如 `3.2.1-alpha.1`）同样不参与配对，只按 core `3.2.1` 与 App 对齐。
library;

/// 对齐状态。取值与电脑端 `lib/app-alignment.js` 的 `ALIGNMENT_STATE` 一一对应。
enum AlignmentState {
  /// 两端语义版本一致。
  ok,

  /// 手机 App 落后于插件：应更新 App。
  appOutdated,

  /// 插件落后于手机 App：应更新插件。
  pluginOutdated,

  /// 无法判定（未连接、旧插件未上报、版本不可解析）——如实说明，不猜。
  unknown,
}

/// 一次对齐判定的结果。
class AppAlignment {
  const AppAlignment({
    required this.state,
    required this.appVersion,
    required this.pluginVersion,
    required this.reason,
  });

  /// 尚未连接/尚未拿到版本时的初值。
  const AppAlignment.unknown()
      : state = AlignmentState.unknown,
        appVersion = '',
        pluginVersion = '',
        reason = 'not-connected';

  final AlignmentState state;

  /// 手机端自身版本（`X.Y.Z+build`）；空串表示尚未取得。
  final String appVersion;

  /// 电脑端插件版本（`X.Y.Z`，可带 SemVer prerelease 如 `3.2.1-alpha.1`）；
  /// 空串表示尚未取得。
  final String pluginVersion;

  /// 判定依据（稳定代码；文案由界面按 state 本地化）。
  final String reason;

  /// 需要用户注意（非对齐）。
  bool get needsAttention => state != AlignmentState.ok;

  /// 判定身份：状态或版本一变就应重新提示（用于"已忽略"的记忆）。
  String get signature => '${state.name}:$pluginVersion:$appVersion';

  /// 解析电脑端下发的 `alignment` 段；字段不全时按未知处理。
  static AppAlignment fromServerJson(Map<String, dynamic> json) {
    return AppAlignment(
      state: stateFromWire(json['state']),
      appVersion: (json['appVersion'] as String?) ?? '',
      pluginVersion: (json['pluginVersion'] as String?) ?? '',
      reason: (json['reason'] as String?) ?? 'unknown',
    );
  }

  /// 电脑端的线上取值 → 本地枚举；无法识别一律归到 unknown（不猜）。
  static AlignmentState stateFromWire(Object? wire) {
    switch (wire) {
      case 'ok':
        return AlignmentState.ok;
      case 'app-outdated':
        return AlignmentState.appOutdated;
      case 'plugin-outdated':
        return AlignmentState.pluginOutdated;
      default:
        return AlignmentState.unknown;
    }
  }
}

/// 取语义版本 core `X.Y.Z`：先剥离 `+build`，再剥离 SemVer prerelease（`-alpha.1`）；
/// 不可解析返回空串。
///
/// 插件 prerelease 与 App 的 build 版本按同一个 core 配对（`3.2.1-alpha.1` ↔ `3.2.1+24`）；
/// prerelease 之间的先后顺序不影响两端对齐判定。
String semanticVersion(String raw) {
  var v = raw.trim();
  if (v.isEmpty) return '';
  final plus = v.indexOf('+');
  if (plus != -1) v = v.substring(0, plus).trim();
  final dash = v.indexOf('-');
  if (dash != -1) v = v.substring(0, dash).trim();
  final m = RegExp(r'^(\d+)\.(\d+)\.(\d+)$').firstMatch(v);
  if (m == null) return '';
  return '${int.parse(m.group(1)!)}.${int.parse(m.group(2)!)}.${int.parse(m.group(3)!)}';
}

/// 比较两个语义版本：-1 / 0 / 1；任一不可解析返回 null。
int? compareSemanticVersion(String a, String b) {
  final sa = semanticVersion(a);
  final sb = semanticVersion(b);
  if (sa.isEmpty || sb.isEmpty) return null;
  final pa = sa.split('.').map(int.parse).toList();
  final pb = sb.split('.').map(int.parse).toList();
  for (var i = 0; i < 3; i++) {
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/// 计算对齐状态。
///
/// 优先采用电脑端下发的判定（它同时能看见 App 上报的版本头）；电脑端没给（旧插件）
/// 时本地自己算——这正是"插件旧于 App"能被检出的原因。
AppAlignment computeAlignment({
  required String pluginVersion,
  required String appVersion,
  Map<String, dynamic>? server,
}) {
  if (server != null && server['state'] is String) {
    return AppAlignment.fromServerJson(server);
  }
  if (pluginVersion.isEmpty) {
    return AppAlignment(
      state: AlignmentState.unknown,
      appVersion: appVersion,
      pluginVersion: pluginVersion,
      reason: 'plugin-version-missing',
    );
  }
  final cmp = compareSemanticVersion(pluginVersion, appVersion);
  if (cmp == null) {
    return AppAlignment(
      state: AlignmentState.unknown,
      appVersion: appVersion,
      pluginVersion: pluginVersion,
      reason: appVersion.isEmpty ? 'app-version-missing' : 'version-unparseable',
    );
  }
  if (cmp == 0) {
    return AppAlignment(
      state: AlignmentState.ok,
      appVersion: appVersion,
      pluginVersion: pluginVersion,
      reason: 'aligned',
    );
  }
  // 电脑端版本更高 → 手机落后；否则手机更高 → 电脑端插件落后
  return AppAlignment(
    state: cmp > 0 ? AlignmentState.appOutdated : AlignmentState.pluginOutdated,
    appVersion: appVersion,
    pluginVersion: pluginVersion,
    reason: cmp > 0 ? 'app-older-than-plugin' : 'plugin-older-than-app',
  );
}
