/// 插件自更新的**接续**（CONTEXT「更新接续」；评审 #32 note 1286 的 R7）。
///
/// 插件更新必然包含一次宿主重启，而重启会**断开手机与电脑的连接**——那是正常环节。
/// 但只比 `X.Y.Z` 会两头误判：
///   - 同版本不同内容时，旧进程还没重启就判"完成"；
///   - 服务端重启延迟内刷新到旧实例，就立刻判"版本不符"并清掉记录。
///
/// 所以判定必须依据**事务**（电脑端下发的 `pluginUpdate.transaction`）与
/// **正在运行的内容标识**（`plugin.contentSha256`）：只有新实例健康、且目标内容匹配才算成功；
/// 明确回滚/失败结果或超时才失败。版本号继续只管对齐文案。
library;

/// 接续判定结果。
enum ResumeAction {
  /// 没有进行中的更新。
  none,

  /// 还在等（宿主重启中，或旧实例仍在服务）——**不是失败**。
  wait,

  /// 新实例健康且目标内容已生效。
  completed,

  /// 电脑端明确回滚到旧版本。
  rolledBack,

  /// 电脑端明确失败。
  failed,

  /// 等太久仍无法确认。
  timedOut,
}

/// 电脑端下发的事务摘要（bootstrap 的 `pluginUpdate.transaction`）。
class PluginTransaction {
  const PluginTransaction({
    required this.opId,
    required this.phase,
    required this.targetVersion,
    required this.targetContentSha256,
    required this.rolledBack,
    required this.reason,
  });

  final String opId;
  final String phase;
  final String targetVersion;
  final String targetContentSha256;
  final bool rolledBack;
  final String? reason;

  static PluginTransaction? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final phase = json['phase'];
    if (phase is! String || phase.isEmpty) return null;
    final result = json['result'];
    return PluginTransaction(
      opId: (json['opId'] as String?) ?? '',
      phase: phase,
      targetVersion: (json['targetVersion'] as String?) ?? '',
      targetContentSha256: ((json['targetContentSha256'] as String?) ?? '').toLowerCase(),
      rolledBack: json['rolledBack'] == true,
      reason: result is Map ? (result['reason'] as String?) : null,
    );
  }
}

/// 一次插件更新的记录（持久化在手机上，跨断线、跨进程）。
class PluginUpdateJournal {
  const PluginUpdateJournal({
    required this.opId,
    required this.targetVersion,
    required this.targetContentSha256,
    required this.startedAt,
    this.attempts = 0,
  });

  /// 提交意图时就生成的 operation id：重连后据此查询**同一个**事务（评审 R6/R7）。
  final String opId;

  /// 期望的插件版本（提交时未知则为空串，随后由事务补齐）。
  final String targetVersion;

  /// 期望的内容标识（同上）。
  final String targetContentSha256;

  final DateTime startedAt;
  final int attempts;

  PluginUpdateJournal copyWith({String? targetVersion, String? targetContentSha256}) => PluginUpdateJournal(
        opId: opId,
        targetVersion: targetVersion ?? this.targetVersion,
        targetContentSha256: targetContentSha256 ?? this.targetContentSha256,
        startedAt: startedAt,
        attempts: attempts,
      );

  Map<String, dynamic> toJson() => {
        'opId': opId,
        'targetVersion': targetVersion,
        'targetContentSha256': targetContentSha256,
        'startedAt': startedAt.toUtc().toIso8601String(),
        'attempts': attempts,
      };

  static PluginUpdateJournal? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final started = json['startedAt'];
    if (started is! String) return null;
    final at = DateTime.tryParse(started);
    if (at == null) return null;
    final attempts = json['attempts'];
    return PluginUpdateJournal(
      opId: (json['opId'] as String?) ?? '',
      targetVersion: (json['targetVersion'] as String?) ?? '',
      targetContentSha256: ((json['targetContentSha256'] as String?) ?? '').toLowerCase(),
      startedAt: at,
      attempts: attempts is int ? attempts : 0,
    );
  }
}

/// 判定结果。
class ResumeDecision {
  const ResumeDecision(this.action, this.reason);
  final ResumeAction action;
  final String reason;

  bool get isTerminal =>
      action == ResumeAction.completed ||
      action == ResumeAction.rolledBack ||
      action == ResumeAction.failed ||
      action == ResumeAction.timedOut;

  @override
  String toString() => 'ResumeDecision(${action.name}, $reason)';
}

/// 判定"现在该做什么"。
///
/// - [loadedContentSha256]：电脑端正在运行的插件内容标识（bootstrap 的 `plugin.contentSha256`）；
/// - [transaction]：电脑端当前事务摘要（可能为 null：旧插件或状态丢失）。
ResumeDecision decidePluginUpdateResume({
  required PluginUpdateJournal? journal,
  required String loadedContentSha256,
  PluginTransaction? transaction,
  required DateTime now,
  Duration timeout = const Duration(minutes: 5),
}) {
  if (journal == null) return const ResumeDecision(ResumeAction.none, 'no-journal');

  final loaded = loadedContentSha256.toLowerCase();
  ResumeDecision waitOrTimeout(String reason) {
    final elapsed = now.difference(journal.startedAt.toUtc());
    if (elapsed > timeout) return const ResumeDecision(ResumeAction.timedOut, 'reconnect-timeout');
    return ResumeDecision(ResumeAction.wait, reason);
  }

  // 有事务且身份一致：以事务为准（这才是"结果待确认"的权威来源）
  if (transaction != null && (journal.opId.isEmpty || transaction.opId.isEmpty || transaction.opId == journal.opId)) {
    switch (transaction.phase) {
      case 'settled':
        return const ResumeDecision(ResumeAction.completed, 'transaction-settled');
      case 'rolled-back':
        return const ResumeDecision(ResumeAction.rolledBack, 'transaction-rolled-back');
      case 'failed':
        return ResumeDecision(ResumeAction.failed, transaction.reason ?? 'transaction-failed');
      case 'restart-pending':
      case 'installing':
      case 'staging':
        // 关键：**新实例健康且内容匹配**才算完成；否则旧实例仍在服务 → 继续等
        if (loaded.isNotEmpty && loaded == transaction.targetContentSha256) {
          return const ResumeDecision(ResumeAction.completed, 'loaded-target-content');
        }
        return waitOrTimeout('restart-in-progress');
      default:
        return waitOrTimeout('transaction-phase-${transaction.phase}');
    }
  }

  // 没有事务信息（旧插件/状态丢失）：退化为"已加载内容 == 目标内容"的兜底判定
  final target = journal.targetContentSha256;
  if (target.isNotEmpty && loaded == target) {
    return const ResumeDecision(ResumeAction.completed, 'loaded-target-content');
  }
  return waitOrTimeout('awaiting-transaction');
}
