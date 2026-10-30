// 更新接续（plugin_update_resume.dart）的纯逻辑单测。
// 评审 #32 note 1286 的 R7 要求：判定必须依据**事务 + 正在运行的内容标识**，
// 只比 X.Y.Z 会在"同版本不同内容"上两头误判。这里把那四种情形钉死。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';
import 'package:dsh_mobile_app/update_core.dart';

void main() {
  final started = DateTime.utc(2026, 10, 10, 12, 0, 0);
  const hashOld =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hashNew =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  ReleaseSnapshot releaseSnapshot({
    String pluginVersion = '3.2.2-alpha.1',
    String pluginContentHash = hashNew,
    String appVersion = '3.2.2+27',
  }) => ReleaseSnapshot(
    manifestUrl: 'https://host.example/m/api/update/manifest',
    app: ReleaseArtifact(
      version: appVersion,
      file: 'app.apk',
      size: 4096,
      sha256: hashOld,
      url: 'https://host.example/m/api/update/apk?release=r1',
    ),
    plugin: ReleaseArtifact(
      version: pluginVersion,
      file: 'plugin.tgz',
      size: 2048,
      sha256: hashOld,
      contentSha256: pluginContentHash,
      url: 'https://host.example/m/api/update/plugin',
    ),
  );

  ReleasePointer releasePointer({
    String releaseId = 'r1',
    String pluginVersion = '3.2.2-alpha.1',
    String pluginContentHash = hashNew,
    String appVersion = '3.2.2+27',
  }) => ReleasePointer(
    releaseId: releaseId,
    release: releaseSnapshot(
      pluginVersion: pluginVersion,
      pluginContentHash: pluginContentHash,
      appVersion: appVersion,
    ),
  );

  PluginUpdateJournal journal({
    String opId = 'op-1',
    String target = hashNew,
    String version = '3.2.0',
  }) => PluginUpdateJournal(
    opId: opId,
    targetVersion: version,
    targetContentSha256: target,
    startedAt: started,
  );

  PluginTransaction tx({
    String opId = 'op-1',
    String phase = 'restart-pending',
    String target = hashNew,
    String version = '3.2.0',
    bool rolledBack = false,
    String? reason,
  }) => PluginTransaction(
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
  }) => decidePluginUpdateResume(
    journal: j,
    loadedContentSha256: loaded,
    transaction: transaction,
    now: started.add(elapsed ?? const Duration(seconds: 20)),
  );

  group('PluginUpdateJournal 序列化', () {
    test('prepared legacy update round-trips prepareId and candidate version/build for recovery', () {
      final prepared = PluginUpdateJournal(
        opId: 'op-prepare',
        targetVersion: '4.0.0',
        targetContentSha256: hashNew,
        startedAt: started,
        phase: UpdatePhase.pluginPrepared,
        prepareId: 'prepare-proof-1',
        carrierVersion: '4.0.0-app',
        appVersion: '4.0.0+9',
      );

      final recovered = PluginUpdateJournal.fromJson(prepared.toJson())!;
      expect(recovered.opId, 'op-prepare');
      expect(recovered.prepareId, 'prepare-proof-1');
      expect(recovered.targetVersion, '4.0.0');
      expect(recovered.targetContentSha256, hashNew);
      expect(recovered.carrierVersion, '4.0.0-app');
      expect(recovered.appVersion, '4.0.0+9');
      expect(recovered.phase, UpdatePhase.pluginPrepared);
    });

    test('old journal without prepareId remains readable', () {
      final old = PluginUpdateJournal.fromJson({
        'opId': 'old-op',
        'targetVersion': '3.0.0',
        'startedAt': started.toIso8601String(),
      })!;
      expect(old.prepareId, isNull);
      expect(old.carrierVersion, isEmpty);
    });

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
      expect(
        PluginUpdateJournal.fromJson({'startedAt': started.toIso8601String()})!
            .opId,
        '',
      );
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

    test('parses the target App version from a modern NPM transaction', () {
      final t = PluginTransaction.fromJson({
        'opId': 'op-npm',
        'phase': 'settled',
        'targetVersion': '3.2.2-alpha.1',
        'targetContentSha256': hashNew,
        'targetAppVersion': '3.2.2+27',
      })!;
      expect(t.targetAppVersion, '3.2.2+27');
    });
  });

  group('host release recovery for NPM transactions', () {
    PluginUpdateJournal makeJournal({
      String opId = 'op-npm',
      String version = '3.2.2-alpha.1',
      String contentHash = hashNew,
      String appVersion = '3.2.2+27',
    }) => PluginUpdateJournal(
      opId: opId,
      targetVersion: version,
      targetContentSha256: contentHash,
      startedAt: started,
      appVersion: appVersion,
    );

    PluginTransaction makeTransaction({
      String opId = 'op-npm',
      String phase = 'settled',
      String version = '3.2.2-alpha.1',
      String contentHash = hashNew,
      String appVersion = '3.2.2+27',
      bool rolledBack = false,
    }) => PluginTransaction(
      opId: opId,
      phase: phase,
      targetVersion: version,
      targetContentSha256: contentHash,
      targetAppVersion: appVersion,
      rolledBack: rolledBack,
      reason: null,
    );

    final targetJournal = makeJournal();
    final settledTransaction = makeTransaction();

    test('uses an exact matching host updateTarget when transaction release is null', () {
      final expected = releaseSnapshot();
      final resolved = resolveHostReleaseForPluginUpdate(
        journal: targetJournal,
        transaction: settledTransaction,
        loadedContentSha256: hashNew,
        updateTarget: ReleasePointer(releaseId: 'r-npm', release: expected),
      );
      expect(resolved?.toJson(), expected.toJson());
    });

    test(
      'falls through a mismatched updateTarget to an exact currentRelease',
      () {
        final expected = releaseSnapshot();
        final resolved = resolveHostReleaseForPluginUpdate(
          journal: targetJournal,
          transaction: settledTransaction,
          loadedContentSha256: hashNew,
          updateTarget: releasePointer(appVersion: '3.2.2+26'),
          currentRelease: ReleasePointer(
            releaseId: 'r-current',
            release: expected,
          ),
        );
        expect(resolved?.toJson(), expected.toJson());
      },
    );

    test('rejects missing, un-settled, rolled-back, or mismatched transaction/pointers', () {
      final exactPointer = ReleasePointer(
        releaseId: 'r-exact',
        release: releaseSnapshot(),
      );
      ReleaseSnapshot? resolve({
        PluginUpdateJournal? journal,
        PluginTransaction? transaction,
        String loadedHash = hashNew,
        ReleasePointer? updateTarget,
        ReleasePointer? currentRelease,
        bool defaultTarget = true,
      }) => resolveHostReleaseForPluginUpdate(
        journal: journal ?? targetJournal,
        transaction: transaction ?? settledTransaction,
        loadedContentSha256: loadedHash,
        updateTarget: defaultTarget
            ? (updateTarget ?? exactPointer)
            : updateTarget,
        currentRelease: currentRelease,
      );

      expect(
        resolveHostReleaseForPluginUpdate(
          journal: targetJournal,
          transaction: null,
          loadedContentSha256: hashNew,
          updateTarget: exactPointer,
        ),
        isNull,
      );
      expect(resolve(transaction: makeTransaction(opId: 'other-op')), isNull);
      expect(
        resolve(transaction: makeTransaction(phase: 'installing')),
        isNull,
      );
      expect(resolve(transaction: makeTransaction(rolledBack: true)), isNull);
      expect(
        resolve(transaction: makeTransaction(version: '3.2.2-alpha.2')),
        isNull,
      );
      expect(resolve(journal: makeJournal(version: '3.2.2-alpha.2')), isNull);
      expect(
        resolve(transaction: makeTransaction(contentHash: hashOld)),
        isNull,
      );
      expect(resolve(journal: makeJournal(contentHash: hashOld)), isNull);
      expect(resolve(loadedHash: hashOld), isNull);
      expect(
        resolve(transaction: makeTransaction(appVersion: '3.2.2+26')),
        isNull,
      );
      expect(resolve(journal: makeJournal(appVersion: '3.2.2+26')), isNull);
      expect(
        resolve(
          transaction: makeTransaction(appVersion: ''),
          journal: makeJournal(appVersion: ''),
        ),
        isNull,
      );
      expect(
        resolve(updateTarget: null, currentRelease: null, defaultTarget: false),
        isNull,
        reason: 'without a host pointer, never look up latest/GitHub',
      );
      expect(
        resolve(
          updateTarget: ReleasePointer(
            releaseId: 'r-wrong',
            release: releaseSnapshot(pluginContentHash: hashOld),
          ),
          currentRelease: null,
        ),
        isNull,
      );
    });

    test('can use the journal App target when an older transaction omits targetAppVersion', () {
      final olderTransaction = makeTransaction(appVersion: '');
      final resolved = resolveHostReleaseForPluginUpdate(
        journal: targetJournal,
        transaction: olderTransaction,
        loadedContentSha256: hashNew,
        currentRelease: ReleasePointer(
          releaseId: 'r-current',
          release: releaseSnapshot(),
        ),
      );
      expect(resolved?.app.version, '3.2.2+27');
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
      final d = decide(
        j: journal(),
        loaded: hashNew,
        transaction: tx(phase: 'settled'),
      );
      expect(d.action, ResumeAction.completed);
      expect(d.reason, 'transaction-settled');
    });

    test('同版本、电脑端已回滚 → rolledBack（不是"完成"，也不是"版本不符"）', () {
      final d = decide(
        j: journal(),
        loaded: hashOld,
        transaction: tx(phase: 'rolled-back', rolledBack: true),
      );
      expect(d.action, ResumeAction.rolledBack);
    });

    test('事务明确失败 → failed，并带上电脑端给的原因', () {
      final d = decide(
        j: journal(),
        loaded: hashOld,
        transaction: tx(phase: 'failed', reason: 'rollback-exhausted'),
      );
      expect(d.action, ResumeAction.failed);
      expect(d.reason, 'rollback-exhausted');
    });

    test('事务身份不匹配（另一次更新）→ 不据它下结论，走内容兜底', () {
      final d = decide(
        j: journal(opId: 'op-A'),
        loaded: hashOld,
        transaction: tx(opId: 'op-B', phase: 'settled'),
      );
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
      final d = decide(
        j: journal(),
        loaded: hashOld,
        transaction: tx(phase: 'restart-pending', rolledBack: true),
      );
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
      expect(
        decide(
          j: journal(),
          loaded: hashNew,
          transaction: tx(phase: 'settled'),
        ).isTerminal,
        isTrue,
      );
      expect(
        decide(j: journal(), loaded: hashOld, transaction: tx()).isTerminal,
        isFalse,
      );
      expect(
        decide(
          j: journal(),
          loaded: hashOld,
          transaction: tx(phase: 'rolled-back'),
        ).isTerminal,
        isTrue,
      );
      expect(decide().isTerminal, isFalse);
    });
  });
}
