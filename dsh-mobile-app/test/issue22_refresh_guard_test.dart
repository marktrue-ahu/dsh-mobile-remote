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

  /// 按**会话轮次**冻结的响应：`frozen[n]` 一旦设定，第 n 个会话请求就返回它，
  /// 不再读 `payload`。
  ///
  /// 注意必须按「会话轮次」而不是「请求序号」索引——中间会夹着 bootstrap 等其它请求
  /// （实测两个会话请求的请求序号是 0 和 2）。这是评审指出的漏洞：此前闸门之后才读
  /// payload，于是"两轮返回不同数据"根本没被真正构造出来。
  final Map<int, List<Map<String, dynamic>>> frozen = {};

  /// 第 n 个**会话**请求可用的闸门（按会话轮次）。
  final Map<int, Completer<void>> _sessionGates = {};

  /// 给第 n 个会话请求装闸门（按会话轮次，0 起）。
  Completer<void> gateSessionAt(int n) =>
      _sessionGates[n] ??= Completer<void>();

  /// 会话请求里第 n 个（从 0 起）的**请求序号**；bootstrap 等其它请求不计入。
  final List<int> sessionIndexes = [];

  /// 第 n 个**会话**请求的请求序号（等它到达用）。
  Future<int> waitSessionArrived(int n) async {
    while (sessionIndexes.length <= n) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return sessionIndexes[n];
  }

  Future<void> _handle(HttpRequest req) async {
    final index = requests++;
    final path = req.uri.path;
    await req.drain<void>();
    while (_arrived.length <= index) {
      _arrived.add(Completer<void>());
    }
    _arrived[index].complete();
    while (_gates.length <= index) {
      _gates.add(Completer<void>()..complete());
    }
    // **到达即登记**（在闸门之前）：否则"等请求到达"与"闸门挂住请求"会互相死锁——
    // 请求卡在闸门上，而测试在等它被登记。
    var sessionOrdinal = -1;
    if (path.endsWith('/sessions')) {
      sessionOrdinal = sessionIndexes.length;
      sessionIndexes.add(index);
    }
    final sessionGate = _sessionGates[sessionOrdinal];
    if (sessionGate != null) await sessionGate.future;
    await _gates[index].future;
    // bootstrap 等非会话请求：给一个最小可用响应，让 refreshAll 能走到 _refreshAllInner
    if (!path.endsWith('/sessions')) {
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({'ok': true}));
      await req.response.close();
      return;
    }
    if (failNext) {
      failNext = false;
      req.response.statusCode = 500;
      req.response.write('boom');
      await req.response.close();
      return;
    }
    req.response.headers.contentType = ContentType.json;
    final body = frozen[sessionOrdinal] ?? payload;
    req.response.write(jsonEncode({'ok': true, 'sessions': body}));
    await req.response.close();
  }

  Future<void> stop() => _server.close(force: true);
}

Map<String, dynamic> sessionJson(String id) => {
  'id': id,
  'title': id,
  'cwd': '/tmp',
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeHost host;

  setUp(() async {
    // 绑定默认把所有 HTTP 请求短路成 400，loopback 假服务端必须显式恢复真实 HttpClient
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    host = await FakeHost.start();
    api.baseUrl = host.baseUrl;
    // `api` 是全局单例：候选地址会从**上一条测试**残留，refreshAll 的 rotateBaseUrl()
    // 于是可能跳到已关闭的端口。必须按用例隔离。
    api.baseUrls = [host.baseUrl];
    api.token = '';
  });

  tearDown(() async {
    await host.stop();
  });

  test('在途期间的多次刷新被合并：只发一个请求，且合并调用等到补发结束才完成', () async {
    // 评审指出的原缺口：此前先把 payload 从 old 改成 new 再放行首轮，而夹具在闸门**之后**
    // 才读 payload，于是两轮实际都返回 new——"补发拿到新数据"从未被真正构造出来。
    // 现在**按请求序号冻结**两轮响应，并显式挂住补发轮。
    final store = AppStore();
    addTearDown(store.disposeBridge);

    // 第 0 个会话请求返回 old，第 1 个（补发）返回 new
    host.frozen[0] = [sessionJson('old')];
    host.frozen[1] = [sessionJson('new')];
    final g1 = host.gateSessionAt(0); // 挂住第一轮
    final first = store.refreshSessions();
    await host.waitSessionArrived(0);

    // 用**真实的 owner 路径**（refreshAll 内部 await refreshSessions(notify: false)
    // 之后自行 notifyListeners）来验证：它的通知必须发生在补发之后。
    final notified = <List<Session>>[];
    store.addListener(() => notified.add(List<Session>.of(store.sessions)));
    final owner = store.refreshAll();

    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(host.sessionIndexes.length, 1, reason: '在途期间的调用必须被合并——这正是请求堆积的源头');
    expect(
      store.sessions.map((s) => s.id).toList(),
      isEmpty,
      reason: '首轮尚未放行，不应有数据',
    );

    final g2 = host.gateSessionAt(1); // 挂住补发轮
    g1.complete(); // 放行首轮 → 补发启动
    await first;
    await host.waitSessionArrived(1);
    expect(host.sessionIndexes.length, 2, reason: '合并后只补发一次（不是 5 次）');

    // 补发仍在途：owner 不得已经发布
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(store.sessions.map((s) => s.id).toList(), [
      'old',
    ], reason: '补发在途时只有首轮的 old 结果');
    // 首轮是 notify=true，它会带着 old 正常通知一次；关键是**新数据**的通知必须等到
    // 补发结束（owner 的 notify=false 那一轮要真正发布），不能提前。
    expect(
      notified.any((l) => l.any((x) => x.id == 'new')),
      isFalse,
      reason: 'owner 的最终通知必须等补发结束，不得提前发布新数据',
    );

    g2.complete(); // 放行补发
    await owner;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(store.sessions.map((s) => s.id).toList(), [
      'new',
    ], reason: '补发的结果必须真正应用');
    expect(notified, isNotEmpty, reason: '最终必须有通知，否则 UI 停在旧数据');
    expect(notified.last.map((s) => s.id).toList(), [
      'new',
    ], reason: '最后一次通知的内容必须是补发后的新数据');
  });

  test('销毁后不得再补发新请求（评审 WARNING 2）', () async {
    final store = AppStore();

    final g1 = host.gateSessionAt(0);
    final first = store.refreshSessions();
    await host.waitSessionArrived(0);

    unawaited(store.refreshSessions()); // 登记待补
    await Future<void>.delayed(const Duration(milliseconds: 40));

    store.dispose(); // 销毁：待补必须失效
    g1.complete();
    await first;
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(host.requests, 1, reason: '销毁之后不得再派生请求——那会延续本应停止的全语料扫描');
  });

  test('切换连接后旧地址的在途请求不阻塞新地址（评审 WARNING 3）', () async {
    final hostA = await FakeHost.start();
    addTearDown(() async => hostA.stop());
    final hostB = await FakeHost.start();
    addTearDown(() async => hostB.stop());

    api.baseUrl = hostA.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = hostA.gateSessionAt(0);
    final slowA = store.refreshSessions(); // A 上的慢请求
    await hostA.waitArrived(0);

    // 切到健康的新地址 B（disposeBridge 会走连接代变更）
    api.baseUrl = hostB.baseUrl;
    store.disposeBridge();

    final refreshed = store.refreshSessions(); // 必须立刻打到 B
    // 带超时的等待并给出明确断言：旧地址若阻塞了新地址，这里 3 秒内就失败，
    // 而不是挂到测试全局超时（超时是弱的失败信号，也可能是抖动）。
    await hostB
        .waitArrived(0)
        .timeout(
          const Duration(seconds: 3),
          onTimeout: () =>
              fail('旧地址的在途请求阻塞了新地址：B 在 3 秒内没有收到请求（head-of-line 阻塞）'),
        );
    expect(hostB.requests, 1, reason: '旧地址的在途请求不得阻塞新地址的首屏刷新（head-of-line 阻塞）');

    // 放行 A 的迟到响应：不得阻塞、也不得覆盖 B 的结果
    hostB.payload = [sessionJson('from-b')];
    hostA.payload = [sessionJson('from-a')];
    gA.complete();
    await slowA;
    await refreshed;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(store.sessions.map((s) => s.id).toList(), [
      'from-b',
    ], reason: '旧代的迟到结果不得覆盖新代');
  });

  test('失败后守卫必须复位，且补发不形成重试风暴', () async {
    final store = AppStore();
    addTearDown(store.disposeBridge);

    host.failNext = true; // 第一轮以 500 收场
    final g1 = host.gateSessionAt(0);
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

  // ───────── 第二轮评审补的回归 ─────────
  //
  // WARNING 1：连接归属不能只在 disposeBridge 时失效——自动轮换（connect.onError /
  // _scheduleReconnect / refreshAll 候选切换）与手动切换都只改 api.baseUrl。
  // WARNING 2：补发已经启动后关闭 bridge，必须立刻释放该轮的共享等待 Future。

  test('轮换到健康新地址后：B 立即收到刷新，旧地址在途不阻塞（评审 WARNING 1）', () async {
    final a = await FakeHost.start();
    addTearDown(() async => a.stop());
    final b = await FakeHost.start();
    addTearDown(() async => b.stop());

    api.baseUrls = [a.baseUrl, b.baseUrl];
    api.baseUrl = a.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = a.gateSessionAt(0);
    final slowA = store.refreshSessions(); // A 上的慢请求
    await a.waitSessionArrived(0);

    // 走真实的轮换机制（自动轮换路径调用的就是它）
    expect(api.rotateBaseUrl(), isTrue, reason: '应真正轮换到 B');

    // **先冻结再发请求**：B 无闸门，请求内会立刻读响应；若等它到达后才设 frozen，
    // 它已经返回了默认（空）列表——这正是评审要求"按请求序号冻结"要防的错。
    a.frozen[0] = [sessionJson('from-a')];
    b.frozen[0] = [sessionJson('from-b')];
    final refreshed = store.refreshSessions();
    await b
        .waitSessionArrived(0)
        .timeout(
          const Duration(seconds: 3),
          onTimeout: () => fail('轮换后 B 未收到刷新：旧地址的在途请求仍在阻塞（评审 WARNING 1）'),
        );

    gA.complete();
    await slowA;
    await refreshed;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(store.sessions.map((s) => s.id).toList(), [
      'from-b',
    ], reason: '旧地址的迟到结果不得应用（即使期间没有发生过刷新）');
  });

  test('地址在无刷新期间被轮换：旧地址的迟到结果不得应用（评审 WARNING 1 的窗口）', () async {
    // 这是连接身份检查**不可替代**的场景：地址被自动轮换，但期间没有任何刷新调用，
    // 于是 `_syncConnectionGeneration()` 没跑过、generation 没变——只看 generation
    // 的旧轮次会顺利通过检查，把旧地址的数据应用上去。必须比对**实时**连接身份。
    final a = await FakeHost.start();
    addTearDown(() async => a.stop());
    final b = await FakeHost.start();
    addTearDown(() async => b.stop());

    api.baseUrls = [a.baseUrl, b.baseUrl];
    api.baseUrl = a.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = a.gateSessionAt(0);
    final slowA = store.refreshSessions(); // A 上的慢请求
    await a.waitSessionArrived(0);

    // 只轮换地址，**不做任何刷新**
    expect(api.rotateBaseUrl(), isTrue);

    a.frozen[0] = [sessionJson('from-a')];
    gA.complete(); // 旧 A 迟到
    await slowA;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(
      store.sessions,
      isEmpty,
      reason: '旧地址的结果不得应用——期间没有刷新，generation 未变，只能靠连接身份识别',
    );
  });

  test('B 在途时放行旧 A：B 仍只有一条同代在途，A 的 finally 不得清掉 B 的守卫（评审 WARNING 1）', () async {
    final a = await FakeHost.start();
    addTearDown(() async => a.stop());
    final b = await FakeHost.start();
    addTearDown(() async => b.stop());

    api.baseUrls = [a.baseUrl, b.baseUrl];
    api.baseUrl = a.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = a.gateSessionAt(0);
    final slowA = store.refreshSessions();
    await a.waitSessionArrived(0);
    api.rotateBaseUrl();

    final gB = b.gateSessionAt(0);
    final refB = store.refreshSessions();
    await b.waitSessionArrived(0);

    // B 在途时，再触发一次 → 应被合并（不得并发）
    unawaited(store.refreshSessions());
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(b.sessionIndexes.length, 1, reason: '同代仍只允许一条在途');

    // 放行旧 A：它的 finally 不得清掉 B 的守卫（否则会放出同代并发）
    gA.complete();
    await slowA;
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(
      b.sessionIndexes.length,
      1,
      reason: '旧 A 的 finally 清掉 B 的守卫 → 会立刻多打一条并发请求',
    );

    gB.complete();
    await refB;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(b.sessionIndexes.length, 2, reason: 'B 结束后应补发一次');
  });

  test('B 完成后旧 A 迟到：不覆盖 B 数据、不产生额外补发（评审 WARNING 1）', () async {
    final a = await FakeHost.start();
    addTearDown(() async => a.stop());
    final b = await FakeHost.start();
    addTearDown(() async => b.stop());

    api.baseUrls = [a.baseUrl, b.baseUrl];
    api.baseUrl = a.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    final gA = a.gateSessionAt(0);
    final slowA = store.refreshSessions();
    await a.waitSessionArrived(0);
    api.rotateBaseUrl();

    b.frozen[0] = [sessionJson('from-b')];
    a.frozen[0] = [sessionJson('from-a')];
    await store.refreshSessions();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(store.sessions.map((s) => s.id).toList(), ['from-b']);

    gA.complete(); // 旧 A 迟到
    await slowA;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(store.sessions.map((s) => s.id).toList(), [
      'from-b',
    ], reason: '旧 A 不得覆盖 B');
    expect(b.sessionIndexes.length, 1, reason: '旧 A 迟到不得触发额外补发');
  });

  test('补发已在途时关闭 bridge：该轮共享等待者必须立刻释放（评审 WARNING 2）', () async {
    final store = AppStore();

    final g1 = host.gateSessionAt(0);
    final r1 = store.refreshSessions();
    await host.waitSessionArrived(0);

    final w1 = store.refreshSessions(notify: false); // 登记待补 W1
    var w1Done = false;
    unawaited(w1.then((_) => w1Done = true));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    host.frozen[1] = [sessionJson('r2')];
    final g2 = host.gateSessionAt(1);
    g1.complete(); // R1 结束 → 补发 R2 启动（W1 转为 active）
    await r1;
    await host.waitSessionArrived(1);
    expect(w1Done, isFalse, reason: 'W1 应等补发结束');

    store.disposeBridge(); // 关闭：必须立刻释放 W1，而不是等 R2 响应或逻辑超时
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(w1Done, isTrue, reason: '关闭后 W1 不得再等待 R2（评审 WARNING 2）');

    g2.complete(); // 迟到的 R2：不得二次完成、不得产生未捕获异常、不得再补发
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(host.sessionIndexes.length, 2, reason: '关闭后不得再派生请求');
  });

  test('失效时 active W1 与新 pending W2 都要释放（评审 WARNING 2）', () async {
    final store = AppStore();

    final g1 = host.gateSessionAt(0);
    final r1 = store.refreshSessions();
    await host.waitSessionArrived(0);

    final w1 = store.refreshSessions(notify: false);
    var d1 = false;
    unawaited(w1.then((_) => d1 = true));
    await Future<void>.delayed(const Duration(milliseconds: 30));

    host.frozen[1] = [sessionJson('r2')];
    final g2 = host.gateSessionAt(1);
    g1.complete();
    await r1;
    await host.waitSessionArrived(1); // R2 在途，W1 已转 active

    final w2 = store.refreshSessions(notify: false); // 新的 pending W2
    var d2 = false;
    unawaited(w2.then((_) => d2 = true));
    await Future<void>.delayed(const Duration(milliseconds: 30));

    store.disposeBridge();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(d1, isTrue, reason: 'active W1 必须释放');
    expect(d2, isTrue, reason: 'pending W2 必须释放');
    g2.complete();
  });

  test('切到新代后，旧 R2 的收尾不得动新代的等待者与守卫（评审 WARNING 2）', () async {
    final a = await FakeHost.start();
    addTearDown(() async => a.stop());
    final b = await FakeHost.start();
    addTearDown(() async => b.stop());

    api.baseUrls = [a.baseUrl, b.baseUrl];
    api.baseUrl = a.baseUrl;
    final store = AppStore();
    addTearDown(store.disposeBridge);

    // A 上：R1 结束 → R2 补发在途
    final g1 = a.gateSessionAt(0);
    final r1 = store.refreshSessions();
    await a.waitSessionArrived(0);
    final w1 = store.refreshSessions(notify: false);
    var d1 = false;
    unawaited(w1.then((_) => d1 = true));
    a.frozen[0] = [sessionJson('a1')];
    a.frozen[1] = [sessionJson('a2')];
    final g2 = a.gateSessionAt(1);
    g1.complete();
    await r1;
    await a.waitSessionArrived(1);
    expect(d1, isFalse);

    // 切到 B（新代），并在 B 上发起刷新
    api.rotateBaseUrl();
    final gB = b.gateSessionAt(0);
    final refB = store.refreshSessions();
    await b.waitSessionArrived(0);
    expect(d1, isTrue, reason: '切代后旧 W1 必须释放');

    // B 在途时再触发 → 合并（新代守卫有效）
    unawaited(store.refreshSessions());
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(b.sessionIndexes.length, 1, reason: '新代应仍只允许一条在途');

    g2.complete(); // 旧 R2 迟到：不得清新代守卫、不得动新代等待者
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(b.sessionIndexes.length, 1, reason: '旧 R2 的收尾不得清掉新代守卫');

    // B 的第 0 轮与**补发的第 1 轮**都要冻结：否则补发会用默认空 payload 覆盖结果
    b.frozen[0] = [sessionJson('from-b')];
    b.frozen[1] = [sessionJson('from-b')];
    gB.complete();
    await refB;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(b.sessionIndexes.length, 2, reason: 'B 结束后应补发一次');
    expect(store.sessions.map((s) => s.id).toList(), ['from-b']);
  });
}
