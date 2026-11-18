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
  final List<Map<String, dynamic>> history;
  final int initialLimit;

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
