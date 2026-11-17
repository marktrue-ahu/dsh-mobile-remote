// issue #116：App 侧读取 hostErrorCode/nextAction 并给出可执行文案（旧插件回退）。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue116_app_text_test.dart

import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => L10n.lang = 'zh');

  group('#116 文案：nextAction → 可执行提示', () {
    test('restart-host：明确“先重启 DSH”，并附宿主原码', () {
      final text = pluginUpdateFailureReasonText(
        'host-manager-rejected',
        hostErrorCode: 'stop-profile',
        nextAction: 'restart-host',
      );
      expect(text, contains('先重启 DSH'));
      expect(text, contains('stop-profile'));
      expect(text, isNot(contains('host-manager-rejected')),
          reason: '有可执行动作时不应只显示笼统原因码');
    });

    test('其余四个动作各有文案（维护者已定的 5 个枚举）', () {
      expect(
        pluginUpdateFailureReasonText('host-manager-rejected',
            hostErrorCode: 'incompatible-version',
            nextAction: 'version-incompatible'),
        contains('不兼容'),
      );
      expect(
        pluginUpdateFailureReasonText('host-manager-rejected',
            hostErrorCode: 'not-bundle', nextAction: 'invalid-target'),
        contains('不接受'),
      );
      expect(
        pluginUpdateFailureReasonText('host-manager-rejected',
            hostErrorCode: 'operation-error',
            nextAction: 'retry-or-diagnose'),
        contains('重试'),
      );
      expect(
        pluginUpdateFailureReasonText('host-manager-rejected',
            hostErrorCode: 'future-code', nextAction: 'diagnose'),
        contains('future-code'),
        reason: '未知 code 必须显示原码，不能丢',
      );
    });

    test('英文 i18n：restart-host 用英文文案', () {
      L10n.lang = 'en';
      final text = pluginUpdateFailureReasonText(
        'host-manager-rejected',
        hostErrorCode: 'bundle-in-use',
        nextAction: 'restart-host',
      );
      expect(text.toLowerCase(), contains('restart dsh'));
      expect(text, contains('bundle-in-use'));
    });

    test('未知 nextAction → 回退既有 reason 文案（不显示空白）', () {
      expect(
        pluginUpdateFailureReasonText('install-failed', nextAction: 'not-an-action'),
        contains('pnpm 安装失败'),
      );
      expect(
        pluginUpdateNextActionText('not-an-action', 'x'),
        isEmpty,
        reason: '动作映射器只认稳定枚举，未知返回空串',
      );
    });

    test('旧插件（无新字段）→ 保持现状：显示原 reason 码', () {
      expect(pluginUpdateFailureReasonText('host-manager-rejected'),
          'host-manager-rejected');
      // 旧 reason 白名单不受影响。
      expect(pluginUpdateFailureReasonText('restart-unsupported'),
          contains('宿主形态不支持自动重启'));
    });
  });

  group('#116 模型：事务结果解析新字段', () {
    test('PluginTransaction 从 result 读取 hostErrorCode/nextAction', () {
      final tx = PluginTransaction.fromJson({
        'opId': 'op-1',
        'phase': 'failed',
        'targetVersion': '3.2.5',
        'result': {
          'ok': false,
          'reason': 'host-manager-rejected',
          'hostErrorCode': 'stop-profile',
          'nextAction': 'restart-host',
        },
      });
      expect(tx, isNotNull);
      expect(tx!.reason, 'host-manager-rejected');
      expect(tx.hostErrorCode, 'stop-profile');
      expect(tx.nextAction, 'restart-host');
    });

    test('旧事务没有新字段时为空串（回退路径）', () {
      final tx = PluginTransaction.fromJson({
        'opId': 'op-1',
        'phase': 'failed',
        'result': {'ok': false, 'reason': 'install-failed'},
      });
      expect(tx!.hostErrorCode, '');
      expect(tx.nextAction, '');
    });

    test('PluginUpdateStatus 从 bootstrap JSON 读取顶层新字段', () {
      final status = PluginUpdateStatus.fromJson({
        'state': 'update-failed',
        'reason': 'host-manager-rejected',
        'hostErrorCode': 'stop-profile',
        'nextAction': 'restart-host',
      });
      expect(status.hostErrorCode, 'stop-profile');
      expect(status.nextAction, 'restart-host');
      final unknown = const PluginUpdateStatus.unknown();
      expect(unknown.hostErrorCode, '');
      expect(unknown.nextAction, '');
    });
  });
}
