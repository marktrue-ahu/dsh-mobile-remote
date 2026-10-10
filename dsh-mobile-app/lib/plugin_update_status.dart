/// 电脑端下发的**插件自更新状态**（bootstrap/diagnostics 的 `pluginUpdate`）。
///
/// 关键区分（评审 #32 note 1286 的 R11/W3）：**内容状态驱动"能不能/要不要更新"**，
/// 版本号只驱动对齐文案。因此这里保存 `state`（来自内容标识比较）与 `installShape` /
/// `canSelfUpdate` / `guidance`，让界面能在不支持自更新的形态下给出**对应那一条**指引，
/// 而不是先诱导点"一键更新"再吐错误码。
library;

import 'plugin_update_resume.dart';

/// 不能自更新时给电脑端操作指引（只含**与实际安装方式对应**的那一条）。
class PluginUpdateGuidance {
  const PluginUpdateGuidance({required this.mode, required this.summary, required this.steps, required this.commands});

  /// `auto`（可自行完成）或 `guidance`（只能给指引）。
  final String mode;
  final String summary;
  final List<String> steps;
  final List<String> commands;

  static PluginUpdateGuidance? fromJson(Object? json) {
    if (json is! Map) return null;
    return PluginUpdateGuidance(
      mode: (json['mode'] as String?) ?? '',
      summary: (json['summary'] as String?) ?? '',
      steps: ((json['steps'] as List?) ?? const []).whereType<String>().toList(),
      commands: ((json['commands'] as List?) ?? const []).whereType<String>().toList(),
    );
  }
}

/// 插件自更新状态。
class PluginUpdateStatus {
  const PluginUpdateStatus({
    required this.state,
    required this.reason,
    required this.installShape,
    required this.restartForm,
    required this.canSelfUpdate,
    required this.guidance,
    required this.transaction,
    required this.remoteVersion,
    required this.remoteContentSha256,
  });

  const PluginUpdateStatus.unknown()
      : state = 'unknown',
        reason = 'not-checked',
        installShape = '',
        restartForm = '',
        canSelfUpdate = false,
        guidance = null,
        transaction = null,
        remoteVersion = '',
        remoteContentSha256 = '';

  /// 检查结论：`up-to-date` / `update-available` / `local-ahead` / `unavailable` / `disabled` / `unknown`。
  final String state;
  final String reason;
  final String installShape;
  final String restartForm;
  final bool canSelfUpdate;
  final PluginUpdateGuidance? guidance;
  final PluginTransaction? transaction;
  final String remoteVersion;
  final String remoteContentSha256;

  /// 内容状态说"有新版"——这是更新动作的唯一依据（不是版本号对齐）。
  bool get contentUpdateAvailable => state == 'update-available';

  /// 检查本身没做成（离线/HTTP 错误/解析失败/关闭）——**不能**显示成"无需更新"（W3）。
  bool get checkUnavailable => state == 'unavailable' || state == 'unknown' || state == 'disabled';

  /// 明确的"没有新版"。
  bool get upToDate => state == 'up-to-date' || state == 'local-ahead';

  static PluginUpdateStatus fromJson(Object? json) {
    if (json is! Map) return const PluginUpdateStatus.unknown();
    final remote = json['remote'];
    return PluginUpdateStatus(
      state: (json['state'] as String?) ?? 'unknown',
      reason: (json['reason'] as String?) ?? '',
      installShape: (json['installShape'] as String?) ?? '',
      restartForm: (json['restartForm'] as String?) ?? '',
      canSelfUpdate: json['canSelfUpdate'] == true,
      guidance: PluginUpdateGuidance.fromJson(json['guidance']),
      transaction: PluginTransaction.fromJson(json['transaction'] is Map ? Map<String, dynamic>.from(json['transaction'] as Map) : null),
      remoteVersion: remote is Map ? ((remote['version'] as String?) ?? '') : '',
      remoteContentSha256: remote is Map ? ((remote['contentSha256'] as String?) ?? '') : '',
    );
  }
}
