// 更新接续（plugin_update_resume.dart）的纯逻辑单测：
// 插件更新必然包含一次宿主重启，重启会断开连接——那是**正常环节**，不是失败。
// 这里钉死"什么时候继续等、什么时候算完成、什么时候明确失败"。
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_mobile_app/plugin_update_resume.dart';

void main() {
  final started = DateTime.utc(2026, 10, 10, 12, 0, 0);
  PluginUpdateJournal journal({String target = '3.3.0'}) =>
      PluginUpdateJournal(targetVersion: target, startedAt: started);

  group('PluginUpdateJournal 序列化', () {
    test('往返保持字段', () {
      final j = journal().withAttempt();
      final back = PluginUpdateJournal.fromJson(j.toJson())!;
      expect(back.targetVersion, '3.3.0');
      expect(back.attempts, 1);
      expect(back.startedAt.toUtc(), started);
    });

    test('缺字段/坏时间/非法输入一律丢弃（不阻塞启动）', () {
      expect(PluginUpdateJournal.fromJson(null), isNull);
      expect(PluginUpdateJournal.fromJson({}), isNull);
      expect(PluginUpdateJournal.fromJson({'targetVersion': '', 'startedAt': 'x'}), isNull);
      expect(PluginUpdateJournal.fromJson({'targetVersion': '3.3.0', 'startedAt': 'not-a-date'}), isNull);
      expect(PluginUpdateJournal.fromJson({'targetVersion': '3.3.0'}), isNull);
      expect(
        PluginUpdateJournal.fromJson({'targetVersion': '3.3.0', 'startedAt': started.toIso8601String()})
            ?.attempts,
        0,
      );
    });
  });

  group('decidePluginUpdateResume', () {
    test('没有记录 → 什么都不做', () {
      final d = decidePluginUpdateResume(
        journal: null,
        pluginVersion: '',
        now: started,
      );
      expect(d.action, ResumeAction.none);
      expect(d.phase, ResumePhase.idle);
    });

    test('连不上（宿主重启中）且在超时内 → 继续等，不报错', () {
      final d = decidePluginUpdateResume(
        journal: journal(),
        pluginVersion: '',
        now: started.add(const Duration(seconds: 20)),
      );
      expect(d.action, ResumeAction.wait);
      expect(d.phase, ResumePhase.waitingPlugin);
      expect(d.reason, 'host-restarting');
    });

    test('超过超时仍连不上 → 明确失败（不无限等）', () {
      final d = decidePluginUpdateResume(
        journal: journal(),
        pluginVersion: '',
        now: started.add(const Duration(minutes: 6)),
        timeout: const Duration(minutes: 5),
      );
      expect(d.action, ResumeAction.timedOut);
      expect(d.phase, ResumePhase.failed);
      expect(d.reason, 'reconnect-timeout');
    });

    test('回来了且版本符合预期 → 完成', () {
      final d = decidePluginUpdateResume(
        journal: journal(),
        pluginVersion: '3.3.0',
        now: started.add(const Duration(seconds: 40)),
      );
      expect(d.action, ResumeAction.completed);
      expect(d.phase, ResumePhase.pluginReady);
    });

    test('版本比较只看语义版本（+build 不参与）', () {
      final d = decidePluginUpdateResume(
        journal: journal(target: '3.3.0'),
        pluginVersion: '3.3.0+7',
        now: started.add(const Duration(seconds: 30)),
      );
      expect(d.action, ResumeAction.completed);
    });

    test('回来了但版本不符 → 立刻失败（不空等到超时，用户更早得到结论）', () {
      final d = decidePluginUpdateResume(
        journal: journal(),
        pluginVersion: '3.2.0',
        now: started.add(const Duration(seconds: 10)),
      );
      expect(d.action, ResumeAction.versionMismatch);
      expect(d.phase, ResumePhase.failed);
      expect(d.reason, 'plugin-version-mismatch');
    });
  });
}
