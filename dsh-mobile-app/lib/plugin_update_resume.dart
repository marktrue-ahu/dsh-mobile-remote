/// 插件自更新的**接续**（CONTEXT「更新接续」）。
///
/// 插件更新必然包含一次宿主重启，而重启会**断开手机与电脑的连接**——这是正常环节，
/// 不是失败。手机端必须把"我正在更新插件"这件事记住（跨进程、跨断线），
/// 重连后再确认新版本是否真的生效，然后继续推进（例如接着更新 App）。
///
/// 本文件只放纯逻辑与序列化，方便在没有界面树、没有真实连接的测试里钉死。
library;

/// 接续状态机所处的阶段。
enum ResumePhase {
  /// 没有进行中的更新。
  idle,

  /// 已发出更新请求，等待宿主机重启回来（断线属预期）。
  waitingPlugin,

  /// 插件已回来且版本符合预期，接下来该看 App 自己要不要更新。
  pluginReady,

  /// 全程结束。
  done,

  /// 失败（超时或版本不符）。
  failed,
}

/// 接续判定结果。
enum ResumeAction {
  /// 无事可做。
  none,

  /// 还在等宿主回来（断线中，继续等，不报错）。
  wait,

  /// 插件已更新到目标版本 → 可以收尾/继续。
  completed,

  /// 等太久了 → 按失败处理，给出指引。
  timedOut,

  /// 宿主回来了，但插件版本不是目标版本 → 按失败处理。
  versionMismatch,
}

/// 一次插件更新的记录（持久化在手机上）。
class PluginUpdateJournal {
  const PluginUpdateJournal({
    required this.targetVersion,
    required this.startedAt,
    this.attempts = 0,
  });

  /// 期望更新到的插件版本（来自发布清单的 `plugin.version`）。
  final String targetVersion;

  /// 发起时间（ISO8601，用于超时判定）。
  final DateTime startedAt;

  /// 已尝试次数（重试上限由调用方决定）。
  final int attempts;

  Map<String, dynamic> toJson() => {
        'targetVersion': targetVersion,
        'startedAt': startedAt.toUtc().toIso8601String(),
        'attempts': attempts,
      };

  static PluginUpdateJournal? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final target = json['targetVersion'];
    final started = json['startedAt'];
    if (target is! String || target.isEmpty || started is! String) return null;
    final at = DateTime.tryParse(started);
    if (at == null) return null;
    final attempts = json['attempts'];
    return PluginUpdateJournal(
      targetVersion: target,
      startedAt: at,
      attempts: attempts is int ? attempts : 0,
    );
  }

  PluginUpdateJournal withAttempt() => PluginUpdateJournal(
        targetVersion: targetVersion,
        startedAt: startedAt,
        attempts: attempts + 1,
      );
}

/// 判定"现在该做什么"。
///
/// - [pluginVersion] 为空表示**还没连上**（宿主重启中）→ 继续等，不报错；
/// - 连上且版本等于目标 → 完成；
/// - 连上但版本不符 → 立刻失败（不空等到超时，用户更早得到明确结论）；
/// - 超过 [timeout] → 超时失败。
ResumeDecision decidePluginUpdateResume({
  required PluginUpdateJournal? journal,
  required String pluginVersion,
  required DateTime now,
  Duration timeout = const Duration(minutes: 5),
}) {
  if (journal == null) return const ResumeDecision(ResumeAction.none, ResumePhase.idle, 'no-journal');

  final elapsed = now.difference(journal.startedAt.toUtc());
  final target = journal.targetVersion;

  if (pluginVersion.isEmpty) {
    if (elapsed > timeout) {
      return ResumeDecision(ResumeAction.timedOut, ResumePhase.failed, 'reconnect-timeout');
    }
    return const ResumeDecision(ResumeAction.wait, ResumePhase.waitingPlugin, 'host-restarting');
  }
  // 语义版本相同即视为生效（插件版本不带 build；手机端只比 X.Y.Z）
  if (_semantic(pluginVersion) == _semantic(target)) {
    return const ResumeDecision(ResumeAction.completed, ResumePhase.pluginReady, 'plugin-version-matched');
  }
  return ResumeDecision(ResumeAction.versionMismatch, ResumePhase.failed, 'plugin-version-mismatch');
}

/// 判定结果。
class ResumeDecision {
  const ResumeDecision(this.action, this.phase, this.reason);
  final ResumeAction action;
  final ResumePhase phase;
  final String reason;

  @override
  String toString() => 'ResumeDecision(${action.name}, ${phase.name}, $reason)';
}

String _semantic(String raw) {
  final v = raw.trim();
  final plus = v.indexOf('+');
  return plus == -1 ? v : v.substring(0, plus);
}
