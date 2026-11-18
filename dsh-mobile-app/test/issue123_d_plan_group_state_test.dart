// issue #123（方案 D）：组折叠状态由 widget `State` 持有（对齐 DSH 本体
// `useDisclosure(version)`）。本文件锁 task-29 的 6 条验收：
//   1. 点击展开/收起 → 同一 identity 下状态保持；
//   2. 档位切换 → 未操作过的组跟随新默认；
//   3. 档位切换 → 操作过的组保持用户选择：
//      「档位默认值变化但已有 State 不被改写」由独立 Flutter 探针
//      （`/tmp/issue123-d-plan-probe` 的 test 6）证明——App 层两档默认值同向，
//      无法在 ChatScreen 里构造「用户选择 ≠ 新默认」的可判别场景；
//   4. 补页（identity 不变）→ 状态保持：
//      由 `issue123_p2_partial_segment_state_test.dart` 的 P2/P2b/P2c/P2d 覆盖
//      （边界迟到 / call 覆盖 seq / step 迟到；identity 都不变，全部保持）；
//   5. 补页（identity 变）→ 回落 defaultExpanded，不串状态：
//      由 `groupIdentityOf` 单测（identity 变化）+ 独立 Flutter 探针
//      （`/tmp/issue123-d-plan-probe`：State 销毁重建 → 回落默认，不串状态）证明；
//   6. 段级折叠仍正常：由 `issue79_interjection_fold_test.dart`、
//      `issue75_process_group_test.dart`（段收起/摘要行/展开）覆盖。
//
// 本文件只锁「真实 ChatScreen 里 widget State 的折叠保持 + 档位默认联动」。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue123_d_plan_group_state_test.dart

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _session = 'session-123-dplan';
const Size _surface = Size(390, 844);

/// 长夹具（D4/D5 用）：step 1..6（可被补页）+ step7 的 c7a（补页才到）/c7b +
/// step 8..12 + 末条回答。窗口 = 最后 19 条（seq23..41）：
/// - step7 组初始只有 c7b（identity `1#tool:c7b`）；补页补入 c7a → 首工具变 c7a
///   → identity 变化（D5：回落默认）；
/// - step10 组（c10）在窗口中间；补页只加更早的 step → identity 不变（D4：保持）。
List<Map<String, dynamic>> _history() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  void add(String type, Map<String, dynamic> data) => events.add({
    'seq': seq++,
    'type': type,
    'data': data,
    'time': 1000 + seq * 10,
  });

  add('turn/start', {'turn': 1});
  add('user/message', {
    'messageId': 'u1',
    'text': '先看滚动问题',
    'sourceKind': 'user',
  });
  void step(int stepNo, String callId) {
    add('assistant/message', {
      'turn': 1,
      'step': stepNo,
      'messageId': 'r$stepNo',
      'text': '',
      'reasoning': '第 $stepNo 步思考',
      'reasoningChars': 6,
    });
    add('tool/call', {
      'turn': 1,
      'step': stepNo,
      'callId': callId,
      'name': 'shell-${callId.toUpperCase()}',
      'arguments': 'echo $callId',
    });
    add('tool/result', {
      'turn': 1,
      'step': stepNo,
      'callId': callId,
      'name': 'shell-${callId.toUpperCase()}',
      'text': 'ok $callId',
    });
  }

  for (var i = 1; i <= 6; i++) {
    step(i, 'c$i');
  }
  // step7：c7a 在补页、c7b 在窗口内。
  step(7, 'c7a');
  step(7, 'c7b');
  for (var i = 8; i <= 12; i++) {
    step(i, 'c$i');
  }
  add('assistant/message', {
    'turn': 1,
    'step': 13,
    'messageId': 'a1',
    'text': '检查中……',
  });
  return events;
}

class _Backend {
  _Backend(this.history, {required this.initialLimit});
  /// 可变：用于测试「turn 数据被移除后，身份条目按存在性清理」。
  final List<Map<String, dynamic>> history;
  final int initialLimit;

  /// 非空时，下一次 `/api/history` 请求会等待该 Completer（模拟慢响应）。
  Completer<void>? historyGate;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue123-dplan.test'
    ..path = '/m'
    ..token = ''
    ..timelineCapabilities = const TimelineCapabilities(
      version: 1,
      live: true,
      history: true,
      detail: true,
      unknownEvents: true,
      callCorrelation: true,
    );

  Future<http.Response> _handle(http.Request request) async {
    Map<String, dynamic> body;
    final path = request.url.path;
    if (path == '/m/api/history') {
      final gate = historyGate;
      if (gate != null) {
        historyGate = null; // 只挂起下一次请求
        await gate.future;
      }
      final params = request.url.queryParameters;
      final limit = int.tryParse(params['limit'] ?? '') ?? 50;
      if (params.containsKey('before')) {
        final before = int.tryParse(params['before'] ?? '') ?? 0;
        final preceding = history
            .where((e) => (e['seq'] as int) < before)
            .toList();
        body = {
          'ok': true,
          'events': preceding.length > limit
              ? preceding.sublist(preceding.length - limit)
              : preceding,
          'hasMore': preceding.length > limit,
        };
      } else if (params.containsKey('after')) {
        body = {'ok': true, 'events': <Object>[], 'hasMore': false};
      } else {
        body = {
          'ok': true,
          'events': history.length > initialLimit
              ? history.sublist(history.length - initialLimit)
              : history,
          'hasMore': history.length > initialLimit,
        };
      }
    } else if (path == '/m/api/event-detail') {
      body = {'ok': true, 'event': null};
    } else {
      body = {'ok': true};
    }
    return http.Response(
      jsonEncode(body),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
}

Finder get _groupHeaders => find.byWidgetPredicate(
  (widget) => widget.runtimeType.toString() == '_ProcessGroupHeader',
);

int _headerCount(WidgetTester tester) => _groupHeaders.evaluate().length;

bool _headerExpanded(WidgetTester tester, int index) {
  final state = tester.state(_groupHeaders.at(index));
  // ignore: avoid_dynamic_calls
  return (state as dynamic).debugExpanded as bool;
}

Future<void> _tapHeader(WidgetTester tester, int index) async {
  await tester.tap(
    find
        .descendant(of: _groupHeaders.at(index), matching: find.byType(InkWell))
        .first,
  );
  await tester.pump(const Duration(milliseconds: 120));
  await tester.pump(const Duration(milliseconds: 60));
}

/// 两个已完成/运行中的轮次，用于「存在性过滤」用例（按 turn 前缀区分 identity）。
List<Map<String, dynamic>> _twoTurnHistory() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  void add(String type, Map<String, dynamic> data) => events.add({
    'seq': seq++,
    'type': type,
    'data': data,
    'time': 1000 + seq * 10,
  });
  for (final turn in [1, 2]) {
    add('turn/start', {'turn': turn});
    add('user/message', {
      'messageId': 'u$turn',
      'text': '第 $turn 轮',
      'sourceKind': 'user',
    });
    add('tool/call', {
      'turn': turn,
      'step': 1,
      'callId': 't$turn',
      'name': 'shell-T$turn',
      'arguments': 'echo $turn',
    });
    add('tool/result', {
      'turn': turn,
      'step': 1,
      'callId': 't$turn',
      'name': 'shell-T$turn',
      'text': 'ok $turn',
    });
    if (turn == 1) {
      add('turn/end', {'turn': turn, 'reason': {'kind': 'completed'}});
    }
  }
  return events;
}

Future<AppStore> _mount(
  WidgetTester tester,
  _Backend backend, {
  WorkStepDisplayMode mode = WorkStepDisplayMode.detailed,
  String suffix = '',
}) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)]
    ..stepDisplayMode = mode
    ..turnFoldTiming = TurnFoldTiming.afterAnswer;
  await tester.binding.setSurfaceSize(_surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(() async {
    await tester.pump(const Duration(seconds: 1));
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => MediaQuery(
          data: const MediaQueryData(size: _surface),
          child: ChatScreen(
            key: ValueKey<String>('issue123-dplan$suffix'),
            store: store,
            apiClient: backend.api,
            onTitleChanged: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    // setStepDisplayMode 会持久化偏好；没有 mock 时 SharedPreferences.getInstance()
    // 会在平台通道上一直等待（实测挂起）。
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('D1 点击展开/收起：同一 identity 下状态保持', (tester) async {
    final backend = _Backend(_history(), initialLimit: 50);
    await _mount(tester, backend);
    final index = _headerIndexAboveMarker(tester, 'shell-C10');
    expect(_headerExpanded(tester, index), isTrue, reason: '详细档运行中默认展开');
    await _tapHeader(tester, index);
    expect(_headerExpanded(tester, index), isFalse, reason: '点击应收起');
    // 触发一次父级重建（时间推进），State 仍复用 → 状态保持。
    await tester.pump(const Duration(milliseconds: 300));
    expect(_headerExpanded(tester, index), isFalse);
  });

  testWidgets('D2 档位切换：未操作过的组跟随新默认', (tester) async {
    final backend = _Backend(_history(), initialLimit: 50);
    final store = await _mount(tester, backend);
    final index = _headerIndexAboveMarker(tester, 'shell-C10');
    expect(_headerExpanded(tester, index), isTrue, reason: '详细档默认展开');
    await store.setStepDisplayMode(WorkStepDisplayMode.standard);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(_headerExpanded(tester, index), isFalse,
        reason: '没操作过 → 跟随标准档默认（折叠）');
  });
  testWidgets('D3 不因普通工具事件重置（与废弃的保守失效方案的关键区别）', (tester) async {
    final backend = _Backend(_history(), initialLimit: 50);
    final store = await _mount(tester, backend);
    // 按 identity 定位（不用注入前的 index——结构变化后 index 可能指错组）。
    const target = '1#tool:c10';
    expect(_headerByIdentity(target), findsOneWidget);
    expect(_headerExpandedByIdentity(tester, target), isTrue);
    await _tapHeaderByIdentity(tester, target);
    expect(_headerExpandedByIdentity(tester, target), isFalse,
        reason: '用户手动收起');
    expect(_cachedIdentities(tester), contains(target));

    // 注入普通工具事件：新工具 call + result（该轮组集合增长）。
    store.injectFrame({
      'type': 'session/event',
      'sessionId': _session,
      'event': {
        'seq': 9000,
        'type': 'tool/call',
        'data': {
          'turn': 1,
          'step': 14,
          'callId': 'c14',
          'name': 'shell-C14',
          'arguments': 'echo c14',
        },
        'time': 90000,
      },
    });
    await tester.pump();
    store.injectFrame({
      'type': 'session/event',
      'sessionId': _session,
      'event': {
        'seq': 9001,
        'type': 'tool/result',
        'data': {
          'turn': 1,
          'step': 14,
          'callId': 'c14',
          'name': 'shell-C14',
          'text': 'ok c14',
        },
        'time': 90010,
      },
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));

    // 断言注入的事件**确实进入了过程计划**（不只断言 UI 状态）：
    // 新工具组以 identity `1#tool:c14` 出现，且其工具卡已渲染。
    expect(_headerByIdentity('1#tool:c14'), findsOneWidget,
        reason: '注入的 tool/call+tool/result 必须真的生成过程组');
    expect(find.textContaining('shell-C14'), findsOneWidget,
        reason: '注入的工具卡必须进入渲染计划');
    // 目标组仍保持用户收起（identity 仍在 → 不被过滤、不被重置）。
    expect(_headerExpandedByIdentity(tester, target), isFalse,
        reason: '普通工具事件只增删 identity 集合，不得重置已有用户选择');
    expect(_cachedIdentities(tester), contains(target),
        reason: '目标组的用户选择仍在缓存（新组未被用户操作，不应入缓存）');
    // 收尾：泵掉事件注入产生的 800ms sessions debounce 计时器。
    await tester.pump(const Duration(seconds: 1));
  });
  testWidgets('D4 存在性过滤：turn 数据被移除后其 identity 条目被清理', (tester) async {
    final history = _twoTurnHistory();
    final backend = _Backend(history, initialLimit: 50);
    final store = await _mount(tester, backend);
    // 两个轮次各做一次手动操作：turn1（已完成，默认折叠）→ 展开；
    // turn2（运行中，详细档默认展开）→ 收起。identity 分别是 1#tool:t1 / 2#tool:t2。
    // 两个过程块各一个组：文档顺序 [turn1, turn2]（turn1 已完成 → 默认折叠，
    // 工具卡不渲染，不能用 marker 定位）。
    await _tapHeader(tester, 0); // turn1：展开（用户选择 true）
    await _tapHeader(tester, 1); // turn2：收起（用户选择 false）
    final screen = tester.state(find.byType(ChatScreen));
    // ignore: avoid_dynamic_calls
    final keys = (screen as dynamic).debugGroupUserExpandedKeys as Set<String>;
    expect(keys, containsAll(<String>['1#tool:t1', '2#tool:t2']));
    // 后端历史移除 turn2（turn1 保留），触发 compaction 重同步（reset reload）。
    history.removeWhere((e) => (e['data']?['turn'] as num?)?.toInt() == 2);
    store.injectFrame({
      'type': 'session/event',
      'sessionId': _session,
      'event': {
        'seq': 9100,
        'type': 'compaction/end',
        'data': const <String, dynamic>{},
        'time': 91000,
      },
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    // ignore: avoid_dynamic_calls
    final keysAfter = (screen as dynamic).debugGroupUserExpandedKeys as Set<String>;
    expect(keysAfter, isNot(contains('2#tool:t2')),
        reason: 'turn2 已不在当前数据里 → 按存在性过滤删除其条目');
    expect(keysAfter, contains('1#tool:t1'),
        reason: 'turn1 仍存在 → 其条目保留（证明不是整表清空）');
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('D5 真实空历史 → 空帧 → 同 identity 再现 → 回落默认（不继承）', (tester) async {
    final history = _history();
    final backend = _Backend(history, initialLimit: 50);
    final store = await _mount(tester, backend);
    const target = '1#tool:c10';
    await _tapHeaderByIdentity(tester, target);
    expect(_headerExpandedByIdentity(tester, target), isFalse);
    expect(_cachedIdentities(tester), contains(target));

    // 后端历史变为**空**：compaction 重同步 → 空帧。
    history.clear();
    _injectCompaction(tester, store, 9200);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(_headerCount(tester), 0, reason: '空历史 → 空帧（组全部消失）');
    expect(_cachedIdentities(tester), isEmpty,
        reason: '空计划下 existing 为空 → 存在性过滤清空缓存');

    // 历史恢复为原内容（同一 identity 再次出现）→ 新 State 回落默认。
    history.addAll(_history());
    _injectCompaction(tester, store, 9300);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(_headerByIdentity(target), findsOneWidget, reason: '同 identity 再现');
    expect(_headerExpandedByIdentity(tester, target), isTrue,
        reason: '旧缓存已清、旧 State 已卸载 → 回落默认（详细档展开），不继承旧收起');
    expect(_cachedIdentities(tester), isNot(contains(target)),
        reason: '再现后用户尚未操作 → 缓存里不应有该条目');
  });

  testWidgets('D6 慢历史响应：请求等待期旧选择必须保留（不得提前清空）', (tester) async {
    final history = _history();
    final backend = _Backend(history, initialLimit: 50);
    final store = await _mount(tester, backend);
    const target = '1#tool:c10';
    await _tapHeaderByIdentity(tester, target);
    expect(_headerExpandedByIdentity(tester, target), isFalse);

    // 挂起下一次 history 响应，触发 compaction 重同步。
    final gate = Completer<void>();
    backend.historyGate = gate;
    _injectCompaction(tester, store, 9400);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    // 请求仍在等待：旧列表/旧选择必须保留（_load 在 await 之后才 clear）。
    expect(_cachedIdentities(tester), contains(target),
        reason: '请求未回时不得清空用户选择');
    expect(_headerByIdentity(target), findsOneWidget,
        reason: '请求未回时旧列表仍在（clear 发生在 await 之后）');
    expect(_headerExpandedByIdentity(tester, target), isFalse);

    // 响应返回 → 重载完成，identity 不变 → 选择保留。
    gate.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(_cachedIdentities(tester), contains(target),
        reason: '重载后 identity 仍存在 → 保留用户选择');
    expect(_headerExpandedByIdentity(tester, target), isFalse);
    await tester.pump(const Duration(seconds: 1));
  });

}

/// 按 identity 找组抬头（方案 D 的 ValueKey 就是 identity）。
Finder _headerByIdentity(String identity) =>
    find.byKey(ValueKey<String>('process-group:$identity'));

bool _headerExpandedByIdentity(WidgetTester tester, String identity) {
  final state = tester.state(_headerByIdentity(identity));
  // ignore: avoid_dynamic_calls
  return (state as dynamic).debugExpanded as bool;
}

Future<void> _tapHeaderByIdentity(WidgetTester tester, String identity) async {
  await tester.tap(
    find
        .descendant(of: _headerByIdentity(identity), matching: find.byType(InkWell))
        .first,
  );
  await tester.pump(const Duration(milliseconds: 120));
  await tester.pump(const Duration(milliseconds: 60));
}

/// 触发一次 compaction 重同步（`_load(reset: true)`）。
void _injectCompaction(WidgetTester tester, dynamic store, int seq) {
  // ignore: avoid_dynamic_calls
  (store as dynamic).injectFrame({
    'type': 'session/event',
    'sessionId': _session,
    'event': {
      'seq': seq,
      'type': 'compaction/end',
      'data': const <String, dynamic>{},
      'time': seq * 10,
    },
  });
}

Set<String> _cachedIdentities(WidgetTester tester) {
  final screen = tester.state(find.byType(ChatScreen));
  // ignore: avoid_dynamic_calls
  return (screen as dynamic).debugGroupUserExpandedKeys as Set<String>;
}

int _headerIndexAboveMarker(WidgetTester tester, String marker) {
  final markerRect = tester.getRect(find.textContaining(marker).first);
  var bestIndex = -1;
  var bestBottom = double.negativeInfinity;
  final count = _headerCount(tester);
  for (var i = 0; i < count; i++) {
    final rect = tester.getRect(_groupHeaders.at(i));
    if (rect.top < markerRect.top && rect.bottom > bestBottom) {
      bestBottom = rect.bottom;
      bestIndex = i;
    }
  }
  expect(bestIndex, greaterThanOrEqualTo(0), reason: '必须能定位行标记所属组抬头');
  return bestIndex;
}
