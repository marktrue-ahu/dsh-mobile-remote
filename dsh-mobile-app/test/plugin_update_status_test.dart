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

  // ── v3.5：更新通道（宿主原生管理器 / 重启 / 人工）──
  // 这两类更新对用户的体验完全不同（断不断连接），必须能从状态里读出来，
  // 而不是让界面自己按 installShape 猜。
  test('host-manager 通道 + HMR 可用 → 不重启', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': true,
      'updateChannel': 'host-manager',
      'updateChannelDescription': '由 DSH 插件管理器在进程内更新，无需重启宿主',
      'canRestartHost': false,
      'hostManager': {'available': true, 'state': 'ready', 'hmrAvailable': true},
    });
    expect(st.updateChannel, 'host-manager');
    expect(st.usesHostManager, isTrue);
    expect(st.updateRestartsHost, isFalse,
        reason: 'HMR 可用时宿主管理器更新不需要重启');
    expect(st.canSelfUpdate, isTrue);
    expect(st.canRestartHost, isFalse,
        reason: '容器里原先进程判不出重启形态，但现在能更新');
  });

  test('host-manager 通道但无 HMR → 装了要重启，界面要预告', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': true,
      'updateChannel': 'host-manager',
      'hostManager': {'available': true, 'hmrAvailable': false},
    });
    expect(st.usesHostManager, isTrue);
    expect(st.updateRestartsHost, isTrue);
  });

  test('restart 通道 → 必然重启', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': true,
      'updateChannel': 'restart',
    });
    expect(st.usesHostManager, isFalse);
    expect(st.updateRestartsHost, isTrue);
  });

  test('旧宿主未下发通道字段 → 沿用旧语义（能自更新即会重启）', () {
    final legacy = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': true,
    });
    expect(legacy.updateChannel, isEmpty);
    expect(legacy.usesHostManager, isFalse);
    expect(legacy.updateRestartsHost, isTrue);
    expect(legacy.hostManagerHmrAvailable, isNull);

    final oldNoSelfUpdate = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': false,
    });
    expect(oldNoSelfUpdate.updateRestartsHost, isFalse,
        reason: '旧宿主不能自更新时不存在重启预告');
  });

  test('guidance 通道 → 不可自动更新，仍保留人工指引', () {
    final st = PluginUpdateStatus.fromJson({
      'state': 'update-available',
      'canSelfUpdate': false,
      'updateChannel': 'guidance',
      'updateChannelDescription': '当前形态无法自动更新，需要人工处理',
      'guidance': {'mode': 'guidance', 'summary': '本地目录升级', 'steps': ['替换目录'], 'commands': ['pnpm install']},
    });
    expect(st.canSelfUpdate, isFalse);
    expect(st.updateRestartsHost, isFalse);
    expect(st.guidance?.commands, contains('pnpm install'));
  });
}
