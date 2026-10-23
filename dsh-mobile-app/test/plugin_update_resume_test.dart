// 更新接续（plugin_update_resume.dart）的纯逻辑单测。
// 评审 #32 note 1286 的 R7 要求：判定必须依据**事务 + 正在运行的内容标识**，
// 只比 X.Y.Z 会在"同版本不同内容"上两头误判。这里把那四种情形钉死。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';

void main() {
  final started = DateTime.utc(2026, 10, 10, 12, 0, 0);
  const hashOld = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hashNew = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  PluginUpdateJournal journal({String opId = 'op-1', String target = hashNew, String version = '3.2.0'}) =>
      PluginUpdateJournal(opId: opId, targetVersion: version, targetContentSha256: target, startedAt: started);

  PluginTransaction tx({
    String opId = 'op-1',
    String phase = 'restart-pending',
    String target = hashNew,
    String version = '3.2.0',
    bool rolledBack = false,
    String? reason,
  }) =>
      PluginTransaction(
        opId: opId,
        phase: phase,
        targetVersion: version,
        targetContentSha256: target,
        rolledBack: rolledBack,
        reason: reason,
      );

  ResumeDecision decide({
    PluginUpdateJournal? j,
    String loaded = '',
    PluginTransaction? transaction,
    Duration? elapsed,
  }) =>
      decidePluginUpdateResume(
        journal: j,
        loadedContentSha256: loaded,
        transaction: transaction,
        now: started.add(elapsed ?? const Duration(seconds: 20)),
      );

  group('PluginUpdateJournal 序列化', () {
    test('往返保留 opId / 目标内容标识 / 版本', () {
      final j = journal();
      final back = PluginUpdateJournal.fromJson(j.toJson())!;
      expect(back.opId, 'op-1');
      expect(back.targetContentSha256, hashNew);
      expect(back.targetVersion, '3.2.0');
      expect(back.startedAt.toUtc(), started);
    });

    test('缺 startedAt / 坏时间 → 丢弃（不阻塞启动）', () {
      expect(PluginUpdateJournal.fromJson(null), isNull);
      expect(PluginUpdateJournal.fromJson({'opId': 'x'}), isNull);
      expect(PluginUpdateJournal.fromJson({'startedAt': 'not-a-date'}), isNull);
      expect(PluginUpdateJournal.fromJson({'startedAt': started.toIso8601String()})!.opId, '');
    });
  });

  group('PluginTransaction', () {
    test('解析事务摘要；缺 phase 视为无效', () {
      final t = PluginTransaction.fromJson({
        'opId': 'op-1',
        'phase': 'failed',
        'targetVersion': '3.3.0',
        'targetContentSha256': hashNew.toUpperCase(),
        'rolledBack': true,
        'result': {'reason': 'rollback-exhausted'},
      })!;
      expect(t.phase, 'failed');
      expect(t.targetContentSha256, hashNew, reason: '统一小写');
      expect(t.rolledBack, isTrue);
      expect(t.reason, 'rollback-exhausted');
      expect(PluginTransaction.fromJson({}), isNull);
      expect(PluginTransaction.fromJson({'phase': ''}), isNull);
    });
  });

  group('decidePluginUpdateResume', () {
    test('没有记录 → none', () {
      expect(decide().action, ResumeAction.none);
    });

    test('同版本、旧内容仍在服务（重启前旧实例响应）→ wait，不误报完成', () {
      final d = decide(j: journal(), loaded: hashOld, transaction: tx());
      expect(d.action, ResumeAction.wait);
      expect(d.reason, 'restart-in-progress');
    });

    test('同版本、已加载新内容但事务未 settled → 仍 wait（字节本身不算健康确认）', () {
      final d = decide(j: journal(), loaded: hashNew, transaction: tx());
      expect(d.action, ResumeAction.wait);
      expect(d.reason, 'restart-in-progress');
    });

    test('事务已 settled → completed（即使 App 还没看到新内容标识）', () {
      final d = decide(j: journal(), loaded: hashNew, transaction: tx(phase: 'settled'));
      expect(d.action, ResumeAction.completed);
      expect(d.reason, 'transaction-settled');
    });

    test('同版本、电脑端已回滚 → rolledBack（不是"完成"，也不是"版本不符"）', () {
      final d = decide(j: journal(), loaded: hashOld, transaction: tx(phase: 'rolled-back', rolledBack: true));
      expect(d.action, ResumeAction.rolledBack);
    });

    test('事务明确失败 → failed，并带上电脑端给的原因', () {
      final d = decide(j: journal(), loaded: hashOld, transaction: tx(phase: 'failed', reason: 'rollback-exhausted'));
      expect(d.action, ResumeAction.failed);
      expect(d.reason, 'rollback-exhausted');
    });

    test('事务身份不匹配（另一次更新）→ 不据它下结论，走内容兜底', () {
      final d = decide(j: journal(opId: 'op-A'), loaded: hashOld, transaction: tx(opId: 'op-B', phase: 'settled'));
      expect(d.action, ResumeAction.wait);
      expect(d.reason, 'awaiting-transaction');
    });

    test('没有事务信息（旧插件）→ 一律等待，不据已加载字节判成功', () {
      expect(decide(j: journal(), loaded: hashNew).action, ResumeAction.wait);
      expect(decide(j: journal(), loaded: hashOld).action, ResumeAction.wait);
    });

    test('F7：回滚中间态（rolling-back）绝不被判成功——哪怕此刻内容恰好等于原目标', () {
      final d = decide(
        j: journal(),
        loaded: hashNew, // 恰好等于原升级目标（矛盾的中间态）
        transaction: tx(phase: 'rolling-back', rolledBack: true),
      );
      expect(d.action, ResumeAction.rolledBack);
      expect(d.reason, 'transaction-rolling-back');
    });

    test('F7：rolledBack 标记优先于阶段判定（不改写原始目标也要判回滚）', () {
      final d = decide(j: journal(), loaded: hashOld, transaction: tx(phase: 'restart-pending', rolledBack: true));
      expect(d.action, ResumeAction.rolledBack);
    });

    test('等太久仍无法确认 → timedOut（不无限等）', () {
      final d = decide(
        j: journal(),
        loaded: hashOld,
        transaction: tx(),
        elapsed: const Duration(minutes: 6),
      );
      expect(d.action, ResumeAction.timedOut);
      expect(d.reason, 'reconnect-timeout');
    });

    test('终态集合：completed / rolledBack / failed / timedOut', () {
      expect(decide(j: journal(), loaded: hashNew, transaction: tx(phase: 'settled')).isTerminal, isTrue);
      expect(decide(j: journal(), loaded: hashOld, transaction: tx()).isTerminal, isFalse);
      expect(decide(j: journal(), loaded: hashOld, transaction: tx(phase: 'rolled-back')).isTerminal, isTrue);
      expect(decide().isTerminal, isFalse);
    });
  });
}
