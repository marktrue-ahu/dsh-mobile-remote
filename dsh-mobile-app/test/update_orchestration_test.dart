// 两端编排与阶段持久化的契约（评审 #32 note 1288 的 F8/F9/G3）：
//   - App 更新入口的**唯一门禁**在 store.appUpdateGate()；
//   - 阶段必须持久化，App 被杀掉后仍知道走到哪一步。
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';

PluginUpdateStatus status({
  String state = 'up-to-date',
  bool canSelfUpdate = true,
  PluginTransaction? transaction,
}) =>
    PluginUpdateStatus.fromJson({
      'state': state,
      'canSelfUpdate': canSelfUpdate,
      if (transaction != null)
        'transaction': {
          'opId': transaction.opId,
          'phase': transaction.phase,
          'targetContentSha256': transaction.targetContentSha256,
          'rolledBack': transaction.rolledBack,
        },
    });

PluginUpdateJournal journal({String phase = UpdatePhase.pluginPending, String manifest = 'github:201222-L/dsh-mobile-remote'}) =>
    PluginUpdateJournal(
      opId: 'op-1',
      targetVersion: '3.3.0',
      targetContentSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      startedAt: DateTime.utc(2026, 10, 11),
      phase: phase,
      manifestUrl: manifest,
    );

void main() {
  setUp(() {
    // markAppUpdateConfirmed 会落盘阶段，单测里用内存实现
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  group('F8：App 更新门禁（唯一判据）', () {
    test('插件有内容更新 → 不允许先升 App（可自更新 / 需指引分别给理由）', () {
      final store = AppStore();
      api.pluginUpdate = status(state: 'update-available', canSelfUpdate: true);
      expect(store.appUpdateGate().allowed, isFalse);
      expect(store.appUpdateGate().reason, 'plugin-update-available');

      api.pluginUpdate = status(state: 'update-available', canSelfUpdate: false);
      expect(store.appUpdateGate().reason, 'plugin-update-guidance');
    });

    test('已有在飞的两端更新 → 不允许（即使 state 说没更新）', () {
      final store = AppStore();
      api.pluginUpdate = status();
      store.pluginUpdateJournal = journal();
      expect(store.appUpdateGate().allowed, isFalse);
      expect(store.appUpdateGate().reason, 'plugin-update-in-progress');
    });

    test('检查没做成 → 不允许，也不能当成"无需更新"（W3/F8）', () {
      final store = AppStore();
      api.pluginUpdate = status(state: 'unavailable');
      expect(store.appUpdateGate().allowed, isFalse);
      expect(store.appUpdateGate().reason, 'plugin-check-unavailable');
    });

    test('插件事务未到终态 → 不允许（含 restarting）', () {
      final store = AppStore();
      api.pluginUpdate = status(
        transaction: const PluginTransaction(
          opId: 'op-1',
          phase: 'restart-pending',
          targetVersion: '3.3.0',
          targetContentSha256: '',
          rolledBack: false,
          reason: null,
        ),
      );
      expect(store.appUpdateGate().allowed, isFalse);
      expect(store.appUpdateGate().reason, 'plugin-transaction-pending');
    });

    test('插件已对齐且无在飞事务 → 允许', () {
      final store = AppStore();
      api.pluginUpdate = status();
      expect(store.appUpdateGate().allowed, isTrue);
    });
  });

  group('F9：阶段与固定清单身份', () {
    test('阶段与清单身份往返持久化', () {
      final j = journal(phase: UpdatePhase.appPending, manifest: 'host:http://192.168.1.5:3080/m');
      final back = PluginUpdateJournal.fromJson(j.toJson())!;
      expect(back.phase, UpdatePhase.appPending);
      expect(back.manifestUrl, 'host:http://192.168.1.5:3080/m');
    });

    test('旧记录（无 phase/manifestUrl）按 plugin-pending 处理，不崩', () {
      final back = PluginUpdateJournal.fromJson({
        'opId': 'op-old',
        'targetVersion': '3.2.0',
        'startedAt': DateTime.utc(2026, 10, 10).toIso8601String(),
      })!;
      expect(back.phase, UpdatePhase.pluginPending);
      expect(back.manifestUrl, '');
    });

    test('copyWith 保留 opId/起始时间，只改阶段与目标', () {
      final j = journal();
      final next = j.copyWith(phase: UpdatePhase.pluginConfirmed, targetVersion: '3.4.0');
      expect(next.opId, j.opId);
      expect(next.startedAt, j.startedAt);
      expect(next.phase, UpdatePhase.pluginConfirmed);
      expect(next.targetVersion, '3.4.0');
      expect(next.manifestUrl, j.manifestUrl);
    });

    test('markAppUpdateConfirmed 清掉记录（App 阶段已确认）', () async {
      final store = AppStore();
      store.pluginUpdateJournal = journal(phase: UpdatePhase.appPending);
      await store.markAppUpdateConfirmed();
      expect(store.pluginUpdateJournal, isNull);
    });
  });
}
