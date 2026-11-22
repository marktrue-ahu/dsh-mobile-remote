// issue #150：密集任务消息卡（sourceKind=agent-message）滚到底后，最后一项应贴底。
//
// 回归根因：live SliverList 的最后一个子项保留 12dp 尾距 + SliverPadding 6dp，
// 最后一张任务卡底部与视口底部相距 18dp；用户在底部松手后仍能观察到该空白。
// 修复：列表最后一项不再保留尾距（设计底距 6dp 保留），贴底容差 ≤8dp。
//
// 覆盖：折叠/长卡混合展开/live 连续追加/多轮/最后一项是任务卡/隐藏尾随注入/
// 320+深色+1.5x；使用真实 SliverList 懒构建路径。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _session = 'session-150';
const double _designBottomInset = 6;

class _Backend {
  _Backend(this.events);
  final List<Map<String, dynamic>> events;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue150.test'
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
    if (request.url.path == '/m/api/history') {
      body = {'ok': true, 'events': events, 'hasMore': false};
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

List<Map<String, dynamic>> _dense({
  int cards = 40,
  bool long = false,
  bool endWithCard = false,
  int hiddenTail = 0,
}) {
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
    'text': '开始处理密集任务',
    'sourceKind': 'user',
  });
  for (var i = 0; i < cards; i++) {
    final body = StringBuffer('任务消息 $i');
    final lines = long ? 40 : 2;
    for (var line = 0; line < lines; line++) {
      body.write('\n第 $line 行：请检查密集任务卡的底部空白');
    }
    add('user/message', {
      'messageId': 'agent-$i',
      'text': body.toString(),
      'sourceKind': 'agent-message',
    });
  }
  if (!endWithCard) {
    add('assistant/message', {
      'turn': 1,
      'step': 1,
      'messageId': 'a-last',
      'text': '全部任务已处理完成',
    });
    add('turn/end', {
      'turn': 1,
      'reason': {'kind': 'completed'},
    });
  } else {
    add('user/message', {
      'messageId': 'agent-final',
      'text': '最后一条任务消息',
      'sourceKind': 'agent-message',
    });
  }
  for (var i = 0; i < hiddenTail; i++) {
    add('user/message', {
      'messageId': 'hidden-tail-$i',
      'text': '内部注入 hidden tail $i',
      'sourceKind': 'runtime-context',
    });
  }
  return events;
}

List<Map<String, dynamic>> _denseTurns({int turns = 40}) {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  void add(String type, Map<String, dynamic> data) => events.add({
    'seq': seq++,
    'type': type,
    'data': data,
    'time': 1000 + seq * 10,
  });
  for (var t = 1; t <= turns; t++) {
    add('turn/start', {'turn': t});
    add('user/message', {
      'messageId': 'agent-turn-$t',
      'text': '第 $t 个任务消息\n第二行内容',
      'sourceKind': 'agent-message',
    });
    add('assistant/message', {
      'turn': t,
      'step': 1,
      'messageId': 'a-$t',
      'text': '任务 $t 已完成',
    });
    add('turn/end', {
      'turn': t,
      'reason': {'kind': 'completed'},
    });
  }
  return events;
}

Future<AppStore> _mount(
  WidgetTester tester,
  _Backend backend, {
  Size size = const Size(390, 844),
  double scale = 1.0,
  bool dark = false,
  Set<int> expandedCards = const {},
}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)];
  for (final index in expandedCards) {
    await store.setReasoningOverride(_session, 'inj:agent-$index', true);
  }
  await tester.pumpWidget(
    MaterialApp(
      theme: dark ? ThemeData.dark() : null,
      home: ChatScreen(
        key: ValueKey('issue150-${size.width}-$scale-$dark'),
        store: store,
        apiClient: backend.api,
        onTitleChanged: () {},
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pumpAndSettle();
  return store;
}

ScrollPosition _position(WidgetTester tester) => tester
    .state<ScrollableState>(
      find
          .descendant(
            of: find.byType(CustomScrollView),
            matching: find.byType(Scrollable, skipOffstage: false),
          )
          .first,
    )
    .position;

double? _lastItemBottom(WidgetTester tester) {
  final lists = find
      .byType(SliverList, skipOffstage: false)
      .evaluate()
      .toList()
      .reversed
      .toList();
  if (lists.isEmpty) return null;
  final sliver = lists.first.renderObject;
  if (sliver is! RenderSliverMultiBoxAdaptor) return null;
  RenderBox? child = sliver.firstChild;
  RenderBox? last;
  while (child != null) {
    last = child;
    child = sliver.childAfter(child);
  }
  if (last == null) return null;
  final origin = last.localToGlobal(Offset.zero);
  return origin.dy + last.size.height;
}

Future<void> _toBottom(WidgetTester tester) async {
  final pos = _position(tester);
  pos.jumpTo(pos.maxScrollExtent);
  await tester.pumpAndSettle();
  // 再给懒列表一次布局修正机会。
  pos.jumpTo(pos.maxScrollExtent);
  await tester.pumpAndSettle();
}

Future<void> _dragToBottom(WidgetTester tester) async {
  for (var i = 0; i < 80; i++) {
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -600));
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle();
}

double _tailResidual(WidgetTester tester) {
  final actual = _lastItemBottom(tester);
  expect(actual, isNotNull);
  final viewport = tester.getRect(find.byType(CustomScrollView));
  return viewport.bottom - _designBottomInset - actual!;
}

void _expectTouchesBottom(WidgetTester tester, String reason) {
  final pos = _position(tester);
  final residual = _tailResidual(tester);
  expect(
    residual,
    lessThanOrEqualTo(8.0),
    reason:
        '$reason：最后一项 bottom 偏差=${residual.toStringAsFixed(1)}dp，'
        'pixels=${pos.pixels} max=${pos.maxScrollExtent}',
  );
}

void _expectCardTouchesBottom(WidgetTester tester, Key cardKey, String reason) {
  final rect = tester.getRect(find.byKey(cardKey));
  final viewport = tester.getRect(find.byType(CustomScrollView));
  final residual = viewport.bottom - _designBottomInset - rect.bottom;
  expect(
    residual,
    lessThanOrEqualTo(8.0),
    reason: '$reason：最后一张任务卡 bottom 偏差=${residual.toStringAsFixed(1)}dp',
  );
}

void main() {
  testWidgets('密集任务卡滚到底：最后一项贴底（390/浅色/1.0x）', (tester) async {
    await _mount(tester, _Backend(_dense()));
    await _toBottom(tester);
    _expectTouchesBottom(tester, '折叠态');
  });

  testWidgets('最后一项是任务卡：真实手势滚到底后贴底', (tester) async {
    await _mount(tester, _Backend(_dense(endWithCard: true)));
    await _dragToBottom(tester);
    _expectTouchesBottom(tester, '最后任务卡');
    _expectCardTouchesBottom(
      tester,
      const Key('injected-agent-final'),
      '最后任务卡',
    );
  });

  testWidgets('密集长任务卡混合展开：滚到底仍贴底（390/1.0x）', (tester) async {
    await _mount(
      tester,
      _Backend(_dense(cards: 60, long: true)),
      expandedCards: {for (var i = 0; i < 60; i += 3) i},
    );
    await _toBottom(tester);
    _expectTouchesBottom(tester, '混合展开');
  });

  testWidgets('live 连续追加密集任务卡：最后一张贴底', (tester) async {
    final backend = _Backend([
      {
        'seq': 1,
        'type': 'turn/start',
        'data': {'turn': 1},
        'time': 1000,
      },
      {
        'seq': 2,
        'type': 'user/message',
        'data': {'messageId': 'u1', 'text': '开始', 'sourceKind': 'user'},
        'time': 1100,
      },
    ]);
    final store = await _mount(tester, backend);
    var seq = 3;
    for (var i = 0; i < 40; i++) {
      store.injectFrame({
        'type': 'session/event',
        'sessionId': _session,
        'event': {
          'seq': seq++,
          'type': 'user/message',
          'data': {
            'messageId': 'live-agent-$i',
            'text': '实时任务消息 $i\n第二行内容',
            'sourceKind': 'agent-message',
          },
          'time': 1000 + seq * 10,
        },
      });
      await tester.pump(const Duration(milliseconds: 40));
    }
    await tester.pump(const Duration(milliseconds: 400));
    await _toBottom(tester);
    _expectTouchesBottom(tester, 'live 追加');
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('多轮密集任务卡：滚到底贴底', (tester) async {
    await _mount(tester, _Backend(_denseTurns()));
    await _toBottom(tester);
    _expectTouchesBottom(tester, '多轮');
  });

  testWidgets('最后一张任务卡后隐藏注入：不得留 phantom 空白', (tester) async {
    await _mount(tester, _Backend(_dense(endWithCard: true, hiddenTail: 160)));
    await _toBottom(tester);
    _expectTouchesBottom(tester, '隐藏尾随注入');
    _expectCardTouchesBottom(
      tester,
      const Key('injected-agent-final'),
      '隐藏尾随注入',
    );
  });

  testWidgets('密集任务卡 320/深色/1.5x：真实手势滚到底贴底', (tester) async {
    await _mount(
      tester,
      _Backend(_dense(cards: 120, long: true)),
      size: const Size(320, 640),
      scale: 1.5,
      dark: true,
      expandedCards: {for (var i = 0; i < 120; i += 5) i},
    );
    await _dragToBottom(tester);
    _expectTouchesBottom(tester, '320/1.5x');
  });
}
