// issue #25 二期：宿主轮次大纲接进对话页的集成测试（Seam 3）。
//
// `turn_outline_logic_test.dart` 覆盖纯逻辑（合并/翻页终止/说明文字）；本文件把真实
// `ChatScreen` 接上假后端，验证"未加载刻度长什么样、点它会怎样、不可达时说什么、
// 能力位为假时退不退回一期"这些**用户可观察**行为。不锁死内部实现。

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

/// 造 `from..turns` 轮事件：每轮 = turn/start + 用户消息 + 助手长回复（够长才能上翻）。
/// 第 n 轮的起始序号 = `1 + (n-1)*3`。
List<Map<String, dynamic>> _turnsEvents({required int turns, int from = 1}) {
  final events = <Map<String, dynamic>>[];
  var seq = 1 + (from - 1) * 3;
  for (var turn = from; turn <= turns; turn++) {
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
        'text': '第 $turn 轮的问题',
        'sourceKind': 'user',
      },
    });
    events.add({
      'seq': seq++,
      'type': 'assistant/message',
      'data': {
        'turn': turn,
        'messageId': 'assistant-$turn',
        'text': '第 $turn 轮的回答' * 40,
      },
    });
  }
  return events;
}

int _seqOfTurn(int turn) => 1 + (turn - 1) * 3;

/// 假后端：会话共 [sessionTurns] 轮，客户端只加载**最近** [loadedTurns] 轮
/// （真实场景就是如此：初始只拉最近一页），更早的轮次靠大纲补进刻度轨。
class _OutlineBackend {
  _OutlineBackend({
    this.sessionTurns = 10,
    this.loadedTurns = 2,
    this.outlineState = 'available',
    this.supported = true,
    this.exhaustedOlder = false,
  }) {
    api = Api(client: MockClient(_handle))
      ..baseUrl = 'http://outline.test'
      ..path = '/m'
      ..token = ''
      ..timelineCapabilities = const TimelineCapabilities(
        version: 1,
        live: true,
        history: true,
        detail: true,
        unknownEvents: true,
        callCorrelation: true,
      )
      ..turnOutlineCapabilities = TurnOutlineCapabilities(
        version: 1,
        supported: supported,
        unloaded: supported,
        truncated: supported,
      );
  }

  final int sessionTurns;
  final int loadedTurns;
  final String outlineState;
  final bool supported;

  /// 更早历史已到顶端（上翻返回空页）。
  final bool exhaustedOlder;

  late final Api api;

  /// 记录带 `before` 的上翻请求（页大小用于断言"跨页跳转一次翻足够多"）。
  final List<Map<String, String>> olderRequests = [];
  int outlineRequests = 0;

  int get _firstLoadedTurn => (sessionTurns - loadedTurns + 1).clamp(1, sessionTurns);

  /// 更早的一页：**服务端最多返回 `limit` 条事件**（每轮 3 条），所以一次上翻覆盖
  /// 的轮数与 limit 成正比——这正是 issue #25 要"一次翻足够多"的原因。
  Map<String, dynamic> _olderPage(int beforeSeq, int limit) {
    final cursorTurn = ((beforeSeq + 2) ~/ 3); // before 之前的那一轮
    final last = cursorTurn - 1;
    if (exhaustedOlder || last < 1) {
      return {'ok': true, 'events': <Object>[], 'hasMore': false};
    }
    final maxTurns = (limit ~/ 3).clamp(1, sessionTurns);
    final first = (last - maxTurns + 1).clamp(1, sessionTurns);
    return {
      'ok': true,
      'events': _turnsEvents(turns: last, from: first),
      'hasMore': first > 1,
    };
  }

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    Map<String, dynamic> body;
    if (path == '/m/api/turn-outline') {
      outlineRequests += 1;
      body = switch (outlineState) {
        'empty' => {'ok': true, 'state': 'empty', 'turns': <Object>[]},
        'read-failed' => {
            'ok': true,
            'state': 'read-failed',
            'code': 'turn-outline-timeout',
            'degraded': true,
            'turns': <Object>[],
          },
        _ => {
            'ok': true,
            'state': 'available',
            'asOfSeq': _seqOfTurn(sessionTurns),
            'turns': [
              for (var turn = 1; turn <= sessionTurns; turn++)
                {
                  'turn': turn,
                  'seq': _seqOfTurn(turn),
                  'prompt': '大纲第 $turn 轮提示',
                  'response': '大纲第 $turn 轮回复',
                },
            ],
          },
      };
    } else if (path == '/m/api/history') {
      final params = request.url.queryParameters;
      if (params.containsKey('before')) {
        olderRequests.add(params);
        final before = int.tryParse(params['before'] ?? '') ?? 0;
        final limit = int.tryParse(params['limit'] ?? '') ?? 30;
        body = _olderPage(before, limit);
      } else {
        body = {
          'ok': true,
          'events': _turnsEvents(turns: sessionTurns, from: _firstLoadedTurn),
          'hasMore': false,
        };
      }
    } else if (path == '/m/api/queue') {
      body = {'ok': true, 'rows': <Object>[]};
    } else if (path == '/m/api/todos') {
      body = {'ok': true, 'todos': <Object>[]};
    } else if (path == '/m/api/session-config') {
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

Future<void> _pumpChat(
  WidgetTester tester, {
  required _OutlineBackend backend,
  required AppStore store,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: ChatScreen(
      key: const ValueKey('outline-chat'),
      store: store,
      apiClient: backend.api,
      onTitleChanged: () {},
    ),
  ));
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pump(const Duration(milliseconds: 350));
}

Future<void> _scrollUp(WidgetTester tester, {double by = 600}) async {
  await tester.drag(find.byType(CustomScrollView), Offset(0, by));
  await tester.pumpAndSettle();
}

/// 轨道内第 [index] 个刻度（0 基）的中心在轨道本地坐标里的 y。
double _tickLocalY(int index) => 6 + index * 10 + 5;

void main() {
  testWidgets('宿主大纲带来未加载刻度：刻度数覆盖整个会话而不只是已加载窗口', (tester) async {
    final backend = _OutlineBackend(sessionTurns: 10, loadedTurns: 2);
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    expect(backend.outlineRequests, greaterThan(0), reason: '会话打开后应拉一次大纲');
    expect(find.byType(TurnNavigatorRail), findsOneWidget);
    for (var turn = 1; turn <= 10; turn++) {
      expect(find.byKey(ValueKey<String>('turn-tick-$turn')), findsOneWidget,
          reason: '第 $turn 轮应有刻度（9/10 已加载，1..8 来自宿主大纲）');
    }
    expect(find.byKey(const ValueKey<String>('turn-tick-11')), findsNothing);
  });

  testWidgets('未加载刻度的预览来自大纲：不必先跳过去就知道那是哪一轮', (tester) async {
    // 会话 20 轮、只加载最近 2 轮（19/20）；上翻一页（30 条 ≈ 10 轮）后仍有 1..8 未加载。
    final backend = _OutlineBackend(sessionTurns: 20, loadedTurns: 2);
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    // 长按第 6 轮那个刻度（0 基 index 5）：它的提示词本地没有，应由大纲补齐。
    final railRect = tester.getRect(find.byType(TurnNavigatorRail));
    final gesture = await tester.startGesture(
      Offset(railRect.center.dx, railRect.top + _tickLocalY(5)),
    );
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.textContaining('大纲第 6 轮提示'), findsOneWidget,
        reason: '未加载轮次的预览应由大纲补齐');
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.takeException(), isNull);
  });

  testWidgets('点未加载刻度：按 200 条/页跨页加载，覆盖后定位到该轮', (tester) async {
    final backend = _OutlineBackend(sessionTurns: 20, loadedTurns: 2);
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    await tester.tap(
      find.byKey(const ValueKey<String>('turn-tick-6')),
      warnIfMissed: false,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    expect(
      backend.olderRequests.any((r) => r['limit'] == '200'),
      isTrue,
      reason: '未加载刻度必须用跨页跳转的 200 条/页（不改动既有 30 条/页），'
          '实际请求：${backend.olderRequests}',
    );
    expect(find.text('第 6 轮的问题'), findsOneWidget,
        reason: '翻页完成后应落在目标轮');
    expect(tester.takeException(), isNull);
  });

  testWidgets('到达顶端仍不覆盖：明确说明不可达，不静默', (tester) async {
    final backend = _OutlineBackend(
      sessionTurns: 20,
      loadedTurns: 2,
      exhaustedOlder: true,
    );
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    await tester.tap(
      find.byKey(const ValueKey<String>('turn-tick-1')),
      warnIfMissed: false,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.textContaining('不可达'), findsOneWidget,
        reason: '目标不可达必须明确告知（ADR 0018 有意偏离电脑端的静默停下）');
    expect(tester.takeException(), isNull);
  });

  testWidgets('大纲读取失败：退回一期行为并说明原因', (tester) async {
    final backend = _OutlineBackend(
      sessionTurns: 6,
      loadedTurns: 6,
      outlineState: 'read-failed',
    );
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    // 仍按一期渲染已加载轮次（不是空白、也不是报错）。
    expect(find.byType(TurnNavigatorRail), findsOneWidget);
    for (var turn = 1; turn <= 6; turn++) {
      expect(find.byKey(ValueKey<String>('turn-tick-$turn')), findsOneWidget);
    }
    expect(find.byKey(const ValueKey<String>('turn-tick-7')), findsNothing);
    expect(find.textContaining('超时'), findsOneWidget, reason: '读取失败要有明确说明');
    expect(tester.takeException(), isNull);
  });

  testWidgets('能力位为假：不发大纲请求，退回一期行为', (tester) async {
    final backend = _OutlineBackend(
      sessionTurns: 6,
      loadedTurns: 6,
      supported: false,
    );
    final store = AppStore()..sessionId = 'session-outline';
    await _pumpChat(tester, backend: backend, store: store);
    await _scrollUp(tester);

    expect(backend.outlineRequests, 0, reason: '声明不支持就不该发请求');
    expect(find.byType(TurnNavigatorRail), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('turn-tick-6')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('turn-tick-7')), findsNothing);
  });
}
