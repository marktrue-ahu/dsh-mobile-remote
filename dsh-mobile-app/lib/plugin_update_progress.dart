/// 宿主更新事务 → 面向用户的阶段视图（手机/桌面使用同一套语义）。
library;

/// 进度步骤（粗粒度，对应事务内部阶段）。
class PluginUpdateProgressView {
  const PluginUpdateProgressView({
    required this.step,
    required this.stageText,
    required this.terminal,
    required this.failed,
  });

  /// 六步时间线：检查候选 → 下载校验 → 安装依赖 → 重启宿主 → 健康确认 → 完成。
  static const List<String> steps = [
    '检查候选',
    '下载校验',
    '安装依赖',
    '重启宿主',
    '健康确认',
    '完成',
  ];

  /// 0..5；-1 表示无法判断。
  final int step;
  final String stageText;
  final bool terminal;
  final bool failed;

  static bool _isTerminal(String phase) =>
      phase == 'settled' || phase == 'failed' || phase == 'rolled-back';

  /// 依据事务阶段与最新日志 stage 计算当前步骤与文案。
  static PluginUpdateProgressView describe({
    String phase = '',
    bool rolledBack = false,
    bool? resultOk,
    String? logStage,
  }) {
    final normalizedPhase = phase.trim();
    final stage = (logStage ?? '').trim().toLowerCase();
    if (rolledBack ||
        normalizedPhase == 'rolled-back' ||
        normalizedPhase == 'failed' ||
        (normalizedPhase == 'settled' && resultOk == false)) {
      return const PluginUpdateProgressView(
        step: 4,
        stageText: '更新失败/已回滚',
        terminal: true,
        failed: true,
      );
    }
    if (normalizedPhase == 'settled') {
      return const PluginUpdateProgressView(
        step: 5,
        stageText: '更新完成',
        terminal: true,
        failed: false,
      );
    }
    if (normalizedPhase == 'rolling-back') {
      return const PluginUpdateProgressView(
        step: 4,
        stageText: '健康确认失败，正在回滚',
        terminal: false,
        failed: true,
      );
    }
    // 日志 stage 比粗粒度事务阶段更细：以最新日志为准。
    final byStage = <String, (int, String)>{
      'staging': (0, '准备更新'),
      'prepare': (0, '准备更新'),
      'download': (1, '下载插件与载体'),
      'verify': (1, '校验下载产物'),
      'extract': (1, '校验插件内容'),
      'snapshot': (1, '生成安装快照'),
      'switch': (2, '写入 profile 依赖'),
      'install': (2, '安装依赖（pnpm install）'),
      'restart': (3, '重启宿主'),
      'restart-pending': (3, '等待宿主重启'),
      'supervisor': (4, '等待健康确认'),
      'worker': (2, '电脑端工人进程处理中'),
      'finished': (5, '更新完成'),
      'failed': (4, '更新失败'),
    };
    if (byStage.containsKey(stage)) {
      final (step, text) = byStage[stage]!;
      return PluginUpdateProgressView(
        step: step,
        stageText: text,
        terminal: _isTerminal(normalizedPhase),
        failed: false,
      );
    }
    final byPhase = <String, (int, String)>{
      'staging': (0, '准备更新'),
      'installing': (2, '安装依赖（pnpm install）'),
      'restart-pending': (3, '等待宿主重启'),
    };
    if (byPhase.containsKey(normalizedPhase)) {
      final (step, text) = byPhase[normalizedPhase]!;
      return PluginUpdateProgressView(
        step: step,
        stageText: text,
        terminal: false,
        failed: false,
      );
    }
    return const PluginUpdateProgressView(
      step: 0,
      stageText: '准备中',
      terminal: false,
      failed: false,
    );
  }

  /// 界面展示用的步骤短名（用于时间线）。
  String get stepName => step >= 0 && step < steps.length ? steps[step] : '处理中';
}
