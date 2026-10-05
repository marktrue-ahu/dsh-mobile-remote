// issue #22：会话列表刷新的在途守卫。
//
// 结论要证明的两件事：
//   1. 在途期间的多次刷新**不会**再发请求（否则请求无界堆积，把宿主打到饱和）；
//   2. 在途结束后**恰好补发一次**——既不堆积，也不丢语义。
//
// 用真实的本机 HTTP 服务端驱动（与 sse_store_connect_test.dart 同款做法），
// 断言的是**可观察的请求次数**，不锁内部字段。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/store.dart';

void main() {
  // 需要绑定才能用 SharedPreferences 的 mock；不用 testWidgets → 无 fake async
  TestWidgetsFlutterBinding.ensureInitialized();

  late HttpServer server;
  var requests = 0;
  Completer<void>? gate; // 非 null 时挂住响应，模拟"服务端仍在扫描"
  var failNext = false;

  setUp(() async {
    // 绑定默认把所有 HTTP 请求短路成 400，loopback 假服务端必须显式恢复真实 HttpClient
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    requests = 0;
    gate = null;
    failNext = false;

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      requests++;
      await req.drain<void>();
      final g = gate;
      if (g != null) await g.future; // 挂住直到测试放行
      if (failNext) {
        failNext = false;
        req.response.statusCode = 500;
        req.response.write('boom');
        await req.response.close();
        return;
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({'ok': true, 'sessions': <dynamic>[]}));
      await req.response.close();
    });

    api.baseUrl = 'http://127.0.0.1:${server.port}';
    api.token = '';
  });

  tearDown(() async {
    gate?.complete();
    await server.close(force: true);
  });

  test('在途期间的多次刷新被合并：只发一个请求，结束后恰好补发一次', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    gate = Completer<void>(); // 让第一次刷新停在途
    final first = store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(requests, 1, reason: '首个刷新应发出请求');

    // 在途期间连续触发 5 次（模拟 _debounceSessions 被事件反复唤醒）
    for (var i = 0; i < 5; i++) {
      unawaited(store.refreshSessions());
    }
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(
      requests,
      1,
      reason: '在途期间的调用必须被合并——这正是请求堆积的源头',
    );

    // 放行第一次，等补发落定
    final g = gate!;
    gate = null;
    g.complete();
    await first;
    await Future<void>.delayed(const Duration(milliseconds: 250));

    expect(
      requests,
      2,
      reason: '合并后只补发一次（不是 5 次）：既不堆积，也不丢"事件期间有变化"的语义',
    );
  });

  test('补发之后若又有新调用，仍能正常发出请求（守卫不会永久卡住）', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(requests, 1);

    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(requests, 2, reason: '不在途时应正常发请求');
  });

  test('在途刷新失败后守卫必须复位：后续刷新仍能真正发出请求', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    failNext = true; // 第一次响应 500 → api.sessions() 抛错
    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(requests, 1);

    // 失败后若守卫没复位，这里会静默不发请求（比不加守卫更糟）
    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(
      requests,
      2,
      reason: '失败必须复位在途标志，否则列表从此再也不刷新',
    );
  });

  test('在途失败且期间有待补时：补发仍会发生，且不会无限重试', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    gate = Completer<void>();
    final first = store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));

    unawaited(store.refreshSessions()); // 登记待补
    failNext = true; // 第一次以失败收场

    final g = gate!;
    gate = null;
    g.complete();
    await first;
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(requests, 2, reason: '失败也要补发一次（待补不因异常而丢失）');
    expect(requests, lessThan(3), reason: '补发只能一次，不得因异常形成重试风暴');
  });
}
