// issue #80：轮次导航 Gutter 36。
//
// 规格（note 2264）：
// - 轨道宽 28dp + 右侧 8dp gutter；轨道可见时消息列表右 padding 36dp，隐藏时恢复 16dp；
// - 390/320 都不自动缩轨；轨道仅真实轨框范围命中，gutter 右侧 8dp 留白不命中；
// - 显隐与 padding 同帧；右下「回到底部」圆钮与轨道下界至少 12dp 避让；
// - 保留点按/长按扫掠/高亮/未加载刻度/轨内自动滚动（导航行为不改）。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/widgets/turn_navigator_rail.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _longUserText = '这是一条足够长的用户消息，用来把气泡撑到可用宽度以验证右侧 gutter ';

/// 多轮 + 足够长的内容：可滚动、轨道可显形；用户消息刻意加长以撑满气泡
/// （便于量正文右缘）。
List<Map<String, dynamic>> _turnsEvents({int turns = 6}) {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  for (var turn = 1; turn <= turns; turn++) {
    events.add({
      'seq': seq++,
      'type': 'turn/start',
      'data': {'turn': turn},
    });
    events.add({
      'seq': seq++,
      'type': 'user/message',
      'data': {
        'messageId': 'user-$turn',
        'text': '$_longUserText（第 $turn 轮）',
        'sourceKind': 'user',
      },
    });
    events.add({
      'seq': seq++,
      'type': 'assistant/message',
      'data': {
        'turn': turn,
        'messageId': 'assistant-$turn',
        'text': '第 $turn 轮的回答${'补充说明' * 30}',
      },
    });
  }
  return events;
}

class _TurnBackend {
  _TurnBackend({this.turns = 6});

  final int turns;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue80.test'
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
      body = request.url.queryParameters.containsKey('before')
          ? {'ok': true, 'events': <Object>[], 'hasMore': false}
          : {
              'ok': true,
              'events': _turnsEvents(turns: turns),
              'hasMore': false,
            };
    } else if (request.url.path == '/m/api/queue') {
      body = {'ok': true, 'rows': <Object>[]};
    } else if (request.url.path == '/m/api/todos') {
      body = {'ok': true, 'todos': <Object>[]};
    } else if (request.url.path == '/m/api/session-config') {
      body = {'ok': true, 'config': <String, dynamic>{}};
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

Future<AppStore> _pumpChat(
  WidgetTester tester,
  _TurnBackend backend, {
  String sessionId = 'session-issue80',
  String keySuffix = '',
}) async {
  final store = AppStore()..sessionId = sessionId;
  store.sessions = [
    Session(id: sessionId, title: 'S', cwd: null, createdAt: 1),
  ];
  await tester.pumpWidget(MaterialApp(
    home: ChatScreen(
      key: ValueKey('issue80-$keySuffix'),
      store: store,
      apiClient: backend.api,
      onTitleChanged: () {},
    ),
  ));
  await tester.pump(const Duration(milliseconds: 350));
  return store;
}

/// 上翻离开底部（轨道显形条件之一）。
Future<void> _scrollUp(WidgetTester tester, {double by = 600}) async {
  await tester.drag(find.byType(CustomScrollView), Offset(0, by));
  await tester.pumpAndSettle();
}

double _screenWidth(WidgetTester tester) =>
    tester.view.physicalSize.width / tester.view.devicePixelRatio;

Finder get _rail => find.byType(TurnNavigatorRail);

ScrollPosition _pos(WidgetTester tester) => tester
    .state<ScrollableState>(find.descendant(
      of: find.byType(CustomScrollView),
      matching: find.byType(Scrollable),
    ))
    .position;

/// 消息列表第一条 live SliverPadding 的右 padding（与轨道显隐同帧）。
double _liveRightPadding(WidgetTester tester) {
  final paddings = tester
      .widgetList<SliverPadding>(find.descendant(
        of: find.byType(CustomScrollView),
        matching: find.byType(SliverPadding),
      ))
      .toList();
  return paddings.first.padding.resolve(TextDirection.ltr).right;
}

/// 视口内可见的用户消息文本右缘（测试用长用户消息会撑满气泡宽度）。
double? _visibleUserTextRight(WidgetTester tester) {
  final screenW = _screenWidth(tester);
  for (final element in find.textContaining('这是一条足够长的用户消息').evaluate()) {
    final rect = tester.getRect(find.byWidget(element.widget));
    if (rect.top >= 0 && rect.bottom <= 900 && rect.left >= 0) {
      if (rect.right <= screenW && rect.right > screenW - 120) return rect.right;
    }
  }
  return null;
}

Finder get _jumpButton => find.byWidgetPredicate(
      (w) => w.runtimeType.toString() == '_JumpToLatestButton',
    );

void main() {
  testWidgets('390：轨道 28/右 8、正文右让 36、gutter 不命中', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend());
    await _scrollUp(tester);

    expect(_rail, findsOneWidget);
    final railRect = tester.getRect(_rail);
    expect(railRect.width, 28, reason: '轨道宽 28dp');
    expect(railRect.right, closeTo(390 - 8, 0.5), reason: '轨道右侧留 8dp gutter');
    expect(_liveRightPadding(tester), 36, reason: '轨道可见时列表右 padding 36');

    final textRight = _visibleUserTextRight(tester);
    expect(textRight, isNotNull, reason: '需要可见的长用户气泡');
    // 气泡右缘 = 屏宽-36，文本再内缩 12（气泡内边距）。
    expect(textRight!, closeTo(390 - 36 - 12, 2),
        reason: '正文不进入 gutter（右缘 $textRight）');

    // gutter 右侧 8dp 留白不命中：点它不触发导航（滚动位置不变）。
    final before = _pos(tester).pixels;
    await tester.tapAt(Offset(390 - 4, railRect.center.dy));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_pos(tester).pixels, closeTo(before, 1),
        reason: 'gutter 留白不命中轨道、不触发导航');

    // 真实轨道仍可点按跳转（导航行为保留）：点轨道上的刻度会移动阅读位置。
    await tester.tapAt(Offset(railRect.center.dx, railRect.bottom - 8));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(_pos(tester).pixels, isNot(closeTo(before, 1)),
        reason: '轨道点按仍能跳转（末个刻度 → 最新轮）');
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('320：不自动缩轨；正文宽 268（屏宽-16-36）', (tester) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend());
    await _scrollUp(tester);

    expect(_rail, findsOneWidget);
    final railRect = tester.getRect(_rail);
    expect(railRect.width, 28, reason: '320 也不自动缩轨');
    expect(railRect.right, closeTo(320 - 8, 0.5));
    expect(_liveRightPadding(tester), 36);

    final textRight = _visibleUserTextRight(tester);
    expect(textRight, isNotNull);
    expect(textRight!, closeTo(320 - 36 - 12, 2),
        reason: '320 正文右缘应为 272（屏宽-16-36-12）');

    final before = _pos(tester).pixels;
    await tester.tapAt(Offset(320 - 4, railRect.center.dy));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_pos(tester).pixels, closeTo(before, 1));
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('轨道隐藏（<2 轮）时 padding 恢复 16，无轨道', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend(turns: 1));
    await _scrollUp(tester);

    expect(_rail, findsNothing, reason: '<2 轮不渲染轨道');
    expect(_liveRightPadding(tester), 16, reason: '轨道隐藏时恢复默认 16dp');
    final textRight = _visibleUserTextRight(tester);
    expect(textRight, isNotNull);
    expect(textRight!, closeTo(390 - 16 - 12, 2));
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('显隐与 padding 同帧：离开底部出现轨道→36；回底后一帧内轨道消失→16', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend());
    // 留在底部：无轨道 + 16dp。
    expect(_rail, findsNothing);
    expect(_liveRightPadding(tester), 16);

    await _scrollUp(tester);
    expect(_rail, findsOneWidget);
    expect(_liveRightPadding(tester), 36, reason: '同一帧内轨道+padding 一起出现');

    // 点「回到底部」圆钮：只 pump 一帧（不 settle），轨道与 padding 必须同帧恢复。
    expect(_jumpButton, findsOneWidget);
    await tester.tap(_jumpButton, warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_rail, findsNothing, reason: '回底后轨道隐藏');
    expect(_liveRightPadding(tester), 16, reason: 'padding 与轨道同帧恢复 16dp');
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('轨道下界与「回到底部」圆钮至少 12dp 避让', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend());
    await _scrollUp(tester);
    expect(_rail, findsOneWidget);
    expect(_jumpButton, findsOneWidget);
    final railRect = tester.getRect(_rail);
    final buttonRect = tester.getRect(_jumpButton);
    expect(buttonRect.top - railRect.bottom, greaterThanOrEqualTo(12),
        reason: '轨道下界 ${railRect.bottom} 与圆钮 top ${buttonRect.top} 至少 12dp');
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('长会话：轨框不超过 420dp，轨框外不响应点按', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend(turns: 60));
    await _scrollUp(tester);
    expect(_rail, findsOneWidget);
    final railRect = tester.getRect(_rail);
    expect(railRect.height, lessThanOrEqualTo(420), reason: '轨框上限 420dp');
    // 轨框上方（同一 x）不属于轨道：点它不应触发导航。
    final before = _pos(tester).pixels;
    await tester.tapAt(Offset(railRect.center.dx, railRect.top - 10));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_pos(tester).pixels, closeTo(before, 1),
        reason: '只有真实轨框范围响应点按');
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('切换会话：新会话轮次不足时轨道隐藏、padding 恢复', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await _pumpChat(tester, _TurnBackend(turns: 6), keySuffix: 'multi');
    await _scrollUp(tester);
    expect(_rail, findsOneWidget);
    expect(_liveRightPadding(tester), 36);

    await _pumpChat(
      tester,
      _TurnBackend(turns: 1),
      sessionId: 'session-issue80-single',
      keySuffix: 'single',
    );
    expect(_rail, findsNothing);
    expect(_liveRightPadding(tester), 16);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('320 + textScale1.3：轨道仍 28、无 overflow', (tester) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1.0;
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await _pumpChat(tester, _TurnBackend());
    await _scrollUp(tester);
    expect(_rail, findsOneWidget);
    expect(tester.getRect(_rail).width, 28);
    expect(_liveRightPadding(tester), 36);
    expect(tester.takeException(), isNull, reason: '320+1.3 不应 overflow');
    await tester.pump(const Duration(milliseconds: 900));
  });
}
