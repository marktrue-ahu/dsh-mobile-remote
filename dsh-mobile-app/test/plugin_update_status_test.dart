// 插件自更新状态的模型契约（评审 #32 note 1286 的 R11/W3）：
// **内容状态驱动"要不要/能不能更新"**；检查失败不得被说成"无需更新"。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';

void main() {
  test('内容状态驱动更新动作，与版本号无关', () {
    final byContent = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'reason': 'content-differs-same-version',
      'installShape': 'file-clone',
      'canSelfUpdate': true,
    });
    expect(byContent.contentUpdateAvailable, isTrue, reason: '同版本不同内容也要能操作');
    expect(byContent.checkUnavailable, isFalse);

    final upToDate = PluginUpdateStatus.fromJson({'state': 'up-to-date'});
    expect(upToDate.contentUpdateAvailable, isFalse);
    expect(upToDate.upToDate, isTrue);
  });

  test('检查没做成 → checkUnavailable（不能显示成"无需更新"）', () {
    for (final s in ['unavailable', 'unknown', 'disabled']) {
      final st = PluginUpdateStatus.fromJson({'state': s});
      expect(st.checkUnavailable, isTrue, reason: s);
      expect(st.upToDate, isFalse, reason: s);
    }
  });

  test('安装形态 / 能否自更新 / 降级指引都被保留', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'installShape': 'tgz-file',
      'restartForm': 'unsupported',
      'canSelfUpdate': false,
      'guidance': {
        'mode': 'guidance',
        'summary': 'tgz 安装升级：换上新版 tgz 后重新安装',
        'steps': ['下载新版 tgz 并替换', '重新安装依赖', '重启 DSH 让插件生效'],
        'commands': ['pnpm install'],
      },
      'remote': {'version': '3.3.0', 'contentSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
    });
    expect(st.canSelfUpdate, isFalse);
    expect(st.installShape, 'tgz-file');
    expect(st.guidance!.commands, ['pnpm install']);
    expect(st.guidance!.steps.length, 3);
    expect(st.remoteVersion, '3.3.0');
  });

  test('事务摘要被解析（接续判定的权威来源）', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'transaction': {
        'opId': 'op-1',
        'phase': 'restart-pending',
        'targetVersion': '3.3.0',
        'targetContentSha256': 'BBBB',
        'rolledBack': false,
      },
    });
    expect(st.transaction!.opId, 'op-1');
    expect(st.transaction!.phase, 'restart-pending');
    expect(st.transaction!.targetContentSha256, 'bbbb', reason: '统一小写后再比较');
  });

  test('缺字段/非法输入 → 未知态，不抛异常', () {
    expect(PluginUpdateStatus.fromJson(null).state, 'unknown');
    expect(PluginUpdateStatus.fromJson('nonsense').state, 'unknown');
    expect(PluginUpdateStatus.fromJson({}).checkUnavailable, isTrue);
    expect(PluginUpdateStatus.fromJson({'guidance': 'nope'}).guidance, isNull);
    expect(PluginUpdateStatus.fromJson({'transaction': 42}).transaction, isNull);
  });
}
