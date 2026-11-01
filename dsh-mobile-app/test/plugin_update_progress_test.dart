import 'package:dsh_mobile_app/plugin_update_progress.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('settled 事务显示完成步骤', () {
    final view = PluginUpdateProgressView.describe(
      phase: 'settled',
      resultOk: true,
    );
    expect(view.terminal, isTrue);
    expect(view.failed, isFalse);
    expect(view.step, 5);
    expect(view.stageText, '更新完成');
  });

  test('failed / rolled-back / result.ok=false 显示失败', () {
    for (final view in [
      PluginUpdateProgressView.describe(phase: 'failed', resultOk: false),
      PluginUpdateProgressView.describe(phase: 'rolled-back', rolledBack: true),
      PluginUpdateProgressView.describe(phase: 'settled', resultOk: false),
    ]) {
      expect(view.failed, isTrue);
      expect(view.terminal, isTrue);
      expect(view.step, 4);
    }
  });

  test('事务阶段与日志 stage 映射到六步时间线', () {
    expect(PluginUpdateProgressView.describe(phase: 'staging').step, 0);
    expect(PluginUpdateProgressView.describe(phase: 'installing').step, 2);
    expect(PluginUpdateProgressView.describe(phase: 'restart-pending').step, 3);
    expect(
      PluginUpdateProgressView.describe(
        phase: 'staging',
        logStage: 'download',
      ).step,
      1,
    );
    expect(
      PluginUpdateProgressView.describe(
        phase: 'installing',
        logStage: 'install',
      ).stageText,
      contains('安装依赖'),
    );
    expect(
      PluginUpdateProgressView.describe(
        phase: 'restart-pending',
        logStage: 'supervisor',
      ).step,
      4,
    );
    expect(PluginUpdateProgressView.describe(phase: '').step, 0);
  });

  test('时间线步骤名固定', () {
    expect(PluginUpdateProgressView.steps, [
      '检查候选',
      '下载校验',
      '安装依赖',
      '重启宿主',
      '健康确认',
      '完成',
    ]);
  });
}
