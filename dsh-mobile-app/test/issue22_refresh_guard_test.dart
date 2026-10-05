// issue #22：会话列表刷新的在途守卫。
//
// 断言的是**可观察行为**：请求次数、被合并调用的完成时机、最终通知内容、
// 以及销毁/切换连接后的行为。用真实本机 HTTP 服务端 + 闸门（Completer）驱动，
// 不依赖固定延时，也不锁内部字段。
//
// 评审补充要求的三类覆盖：两轮返回**不同**的非空列表、listener 快照、
// 被合并调用的 Future 等待语义与生命周期。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/store.dart';

/// 可控的假宿主：每个请求可取一个闸门，未取到则立即放行。
class FakeHost {
  FakeHost._(this._server) {
    _server.listen(_handle);
  }

  static Future<FakeHost> start() async {
    final s = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    return FakeHost._(s);
  }

  final HttpServer _server;

  /// 本服务端收到的请求数。
  int requests = 0;

  /// 当前返回的会话列表（可在两轮之间改，模拟"期间有变化"）。
  List<Map<String, dynamic>> payload = [];

  /// 是否让下一个请求以 500 收场。
  bool failNext = false;

  final List<Completer<void>> _gates = [];
  final List<Completer<void>> _arrived = [];

  /// 为第 n 个（从 0 起）到达的请求装一个闸门。
  Completer<void> gateAt(int index) {
    while (_gates.length <= index) {
      _gates.add(Completer<void>()..complete());
    }
    _gates[index] = Completer<void>();
    return _gates[index];
  }

  /// 等第 n 个请求**到达服务端**（替代 sleep）。
  Future<void> waitArrived(int index) {
    while (_arrived.length <= index) {
      _arrived.add(Completer<void>());
    }
    return _arrived[index].future;
  }

  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  Future<void> _handle(HttpRequest req) async {
    final index = requests++;
    await req.drain<void>();
    while (_arrived.length <= index) {
      _arrived.add(Completer<void>());
    }
    _arrived[index].complete();
    while (_gates.length <= index) {
      _gates.add(Completer<void>()..complete());
    }
    await _gates[index].future;
    if (failNext) {
      failNext = false;
      req.response.statusCode = 500;
      req.response.write('boom');
      await req.response.close();
      return;
    }
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode({'ok': true, 'sessions': payload}));
    await req.response.close();
  }

  Future<void> stop() => _server.close(force: true);
}

Map<String, dynamic> sessionJson(String id) => {'id': id, 'title': id, 'cwd': '/tmp'};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeHost host;

  setUp(() async {
    // 绑定默认把所有 HTTP 请求短路成 400，loopback 假服务端必须显式恢复真实 HttpClient
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    host = await FakeHost.start();
    api.baseUrl = host.baseUrl;
    api.token = '';
  });

  tearDown(() async {
    await host.stop();
  });

  test('在途期间的多次刷新被合并：只发一个请求，且合并调用等到补发结束才完成', () async {
    // 这是评审 BLOCKING 那条的回归：被合并的调用**不得提前完成**。
    final store = AppStore();
    addTearDown(store.disposeBridge);

    host.payload = [sessionJson('old')];
    final g1 = host.gateAt(0); // 挂住第一轮
    final first = store.refreshSessions();
    await host.waitArrived(0);

    // 在途期间连续触发 5 次（模拟 _debounceSessions 被事件反复唤醒）
    var mergedDone = false;
    final merged = store.refreshSessions(notify: false);
    unawaited(merged.then((_) => mergedDone = true));
    for (var i = 0; i < 4; i++) {
      unawaited(store.refreshSessions(notify: false));
    }
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(host.requests, 1, reason: '在途期间的调用必须被合并——这正是请求堆积的源头');
    expect(mergedDone, isFalse, reason: '被合并的调用不得在补发结束前完成（评审 BLOCKING）');

    // 期间数据变了；放行第一轮 → 补发应拿到新数据
    host.payload = [sessionJson('new')];
    final notified = <List<Session>>[];
    store.addListener(() => notified.add(List<Session>.of(store.sessions)));
    g1.complete();

    await first;
    await merged; // 合并调用要等到补发结束
    await Future<void>.delayed(const Duration(milliseconds: 80));

    expect(host.requests, 2, reason: '合并后只补发一次（不是 5 次）');
    expect(store.sessions.map((s) => s.id).toList(), ['new'],
        reason: '补发的结果必须真正应用');
    expect(notified, isNotEmpty, reason: '最终必须有通知，否则 UI 停在旧数据');
    expect(notified.last.map((s) => s.id).toList(), ['new'],
        reason: '最后一次通知的内容必须是新数据');
  });

  test('销毁后不得再补发新请求（评审 WARNING 2）', () async {
    final store = AppStore();

    final g1 = host.gateAt(0);
    final first = store.refreshSessions();
    await host.waitArrived(0);

    unawaited(store.refreshSessions()); // 登记待补
    await Future<void>.delayed(const Duration(milliseconds: 40));

    store.dispose(); // 销毁：待补必须失效
    g1.complete();
    await first;
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(host.requests, 1,
        reason: '销毁之后不得再派生请求——那会延续本应停止的全语料扫描');
  });

  test('切换连接后旧地址的在途请求不阻塞新地址（评审 WARNING 3）', () async {
    final hostA = await FakeHost.start();
    addTearDown(() async => hostA.stop());
    final hostB = await FakeHost.start();
    addTearDown(() async => hostB.stop());

    api.baseUrl = hostA.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = hostA.gateAt(0);
    final slowA = store.refreshSessions(); // A 上的慢请求
    await hostA.waitArrived(0);

    // 切到健康的新地址 B（disposeBridge 会走连接代变更）
    api.baseUrl = hostB.baseUrl;
    store.disposeBridge();

    final refreshed = store.refreshSessions(); // 必须立刻打到 B
    // 带超时的等待并给出明确断言：旧地址若阻塞了新地址，这里 3 秒内就失败，
    // 而不是挂到测试全局超时（超时是弱的失败信号，也可能是抖动）。
    await hostB.waitArrived(0).timeout(
      const Duration(seconds: 3),
      onTimeout: () => fail('旧地址的在途请求阻塞了新地址：B 在 3 秒内没有收到请求（head-of-line 阻塞）'),
    );
    expect(hostB.requests, 1,
        reason: '旧地址的在途请求不得阻塞新地址的首屏刷新（head-of-line 阻塞）');

    // 放行 A 的迟到响应：不得阻塞、也不得覆盖 B 的结果
    hostB.payload = [sessionJson('from-b')];
    hostA.payload = [sessionJson('from-a')];
    gA.complete();
    await slowA;
    await refreshed;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(store.sessions.map((s) => s.id).toList(), ['from-b'],
        reason: '旧代的迟到结果不得覆盖新代');
  });

  test('失败后守卫必须复位，且补发不形成重试风暴', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    host.failNext = true; // 第一轮以 500 收场
    final g1 = host.gateAt(0);
    final first = store.refreshSessions();
    await host.waitArrived(0);

    final merged = store.refreshSessions(notify: false); // 登记待补
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(host.requests, 1, reason: '放行前仍应只有 1 个请求');

    g1.complete();
    await first;
    await merged; // 第一轮失败，但补发仍要发生并释放等待者
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(host.requests, 2, reason: '失败也要补发一次；补发只能一次，不得形成重试风暴');

    // 复位与否：再刷一次必须能真正发出请求
    host.payload = [sessionJson('after-fail')];
    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(host.requests, 3, reason: '失败后守卫必须复位，否则列表再也不刷新');
    expect(store.sessions.map((s) => s.id).toList(), ['after-fail']);
  });
}
