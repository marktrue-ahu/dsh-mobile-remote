// issue #22 第三轮评审核定：owner 收尾窗口。
//
// 评审给出的两条回归（实跑失败），覆盖现有用例没测到的状态机窗口：
// 地址被自动轮换、且**期间没有任何刷新或 disposeBridge** 时，旧 owner 的收尾必须
// 清掉自身残留并释放等待者——既不能把旧 pending 补发到新地址，也不能留下假的
// in-flight（否则轮换回原地址后会永久卡住，再也不发请求）。
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';

import 'issue22_refresh_guard_test.dart' show FakeHost, sessionJson;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    api.path = '/m';
    api.token = '';
    api.baseUrls = [];
  });

  test('轮换后没有新刷新：旧请求结束仍必须释放待补等待者', () async {
    final a = await FakeHost.start();
    final b = await FakeHost.start();
    addTearDown(a.stop);
    addTearDown(b.stop);
    api.baseUrl = a.baseUrl;
    api.baseUrls = [a.baseUrl, b.baseUrl];
    final store = AppStore();
    addTearDown(store.disposeBridge);
    a.frozen[0] = [sessionJson('old-a')];
    final gate = a.gateSessionAt(0);
    final first = store.refreshSessions();
    await a.waitSessionArrived(0);

    var mergedDone = false;
    final merged = store.refreshSessions(notify: false);
    unawaited(merged.then((_) => mergedDone = true));
    expect(api.rotateBaseUrl(), isTrue); // A -> B，不调用刷新或 disposeBridge
    gate.complete();
    await first; // 旧 HTTP 已结束，不是等待网络/15 秒超时
    await Future<void>.delayed(Duration.zero);

    expect(store.sessions, isEmpty, reason: '旧地址结果必须丢弃');
    expect(b.sessionIndexes, isEmpty, reason: '旧代 pending 不得自动发到 B');
    expect(mergedDone, isTrue,
        reason: '旧轮次已结束且身份失效，待补 Future 必须释放；当前 finally 跳过全部收尾');
  });

  test('A到B再回A：没有实际在途请求时守卫必须恢复，不能永久卡住', () async {
    final a = await FakeHost.start();
    final b = await FakeHost.start();
    addTearDown(a.stop);
    addTearDown(b.stop);
    api.baseUrl = a.baseUrl;
    api.baseUrls = [a.baseUrl, b.baseUrl];
    final store = AppStore();
    addTearDown(store.disposeBridge);
    a.frozen[0] = [sessionJson('old-a')];
    a.frozen[1] = [sessionJson('fresh-a')];
    final gate = a.gateSessionAt(0);
    final first = store.refreshSessions();
    await a.waitSessionArrived(0);

    expect(api.rotateBaseUrl(), isTrue); // A -> B；期间没有 B 刷新
    gate.complete();
    await first;
    expect(store.sessions, isEmpty);
    expect(api.rotateBaseUrl(), isTrue); // B -> A
    final retry = store.refreshSessions();
    unawaited(retry);

    // 有界观测，不用 waitSessionArrived(...).timeout 留下无限轮询 Future。
    final clock = Stopwatch()..start();
    while (a.sessionIndexes.length < 2 && clock.elapsed < const Duration(seconds: 1)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(a.sessionIndexes.length, 2,
        reason: '旧 HTTP 已结束，返回 A 后必须真正发出新请求；当前仍保持 phantom in-flight');
    await retry.timeout(const Duration(seconds: 1));
    expect(store.sessions.single.id, 'fresh-a');
  });
}
