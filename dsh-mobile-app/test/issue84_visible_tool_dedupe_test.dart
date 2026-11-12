// issue #84（#51 回归）：活动条只对「真正可见」的运行中工具去重。
//
// 根因：活动条用的是 renderedCallIds（过程块承载集合）——它包含被组折叠、50 行分批
// 隐藏、以及离屏不确定的行，导致运行中工具在界面上看不见、活动条也被吞掉。
// 修复：新增 `_ProcessPlan.visibleToolCallIds`（segment 展开 + 组展开 + visibleRowSeqs），
// 活动条只对其中 callId 去重；折叠/分批隐藏/离屏/无锚点仍保留活动条。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-84';
const _activityBarToolsKey = ValueKey<String>('activity-bar-tools');

class _Backend {
  _Backend({required this.events});
  final List<Map<String, dynamic>> events;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue84.test'
    ..path = '/m'
    ..token = ''
    ..timelineCapabilities = const TimelineCapabilities(
      version: 1,
      live: true,
      history: true,
      detail: false,
      unknownEvents: true,
      callCorrelation: true,
    );

  Future<http.Response> _handle(http.Request request) async {
    Map<String, dynamic> body;
    final path = request.url.path;
    if (path == '/m/api/history') {
      body = {'ok': true, 'events': events, 'hasMore': false};
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

/// 运行中的一轮：turn/start + user + [completed] 个已完成工具 + 1 个运行中工具。
List<Map<String, dynamic>> _runningEvents({
  int completedTools = 0,
  String runningTool = 'shell',
  bool withTurnStart = true,
  String? longAssistant,
}) {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  if (withTurnStart) {
    events.add({'seq': seq++, 'type': 'turn/start', 'data': {'turn': 1}});
  }
  events.add({
    'seq': seq++,
    'type': 'user/message',
    'data': {'messageId': 'u1', 'text': '问题', 'sourceKind': 'user'},
  });
  if (longAssistant != null) {
    events.add({
      'seq': seq++,
      'type': 'assistant/message',
      'data': {'turn': 1, 'step': 1, 'messageId': 'a-long', 'text': longAssistant},
    });
  }
  for (var i = 0; i < completedTools; i++) {
    events.add({
      'seq': seq++,
      'type': 'tool/call',
      'data': {
        'turn': 1,
        'step': i + 1,
        'callId': 'done-$i',
        'name': 'bash',
        'arguments': 'echo $i',
      },
    });
    events.add({
      'seq': seq++,
      'type': 'tool/result',
      'data': {
        'turn': 1,
        'step': i + 1,
        'callId': 'done-$i',
        'name': 'bash',
        'text': 'ok $i',
      },
    });
  }
  events.add({
    'seq': seq++,
    'type': 'tool/call',
    'data': {
      'turn': 1,
      'step': completedTools + 1,
      'callId': 'running-tool',
      'name': runningTool,
      'arguments': 'sleep 1',
    },
  });
  return events;
}

Future<AppStore> _pumpChat(WidgetTester tester, _Backend backend) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [
      Session(id: _session, title: 'S', cwd: null, createdAt: 1),
    ];
  await tester.pumpWidget(MaterialApp(
    home: ChatScreen(
      key: const ValueKey('issue84-chat'),
      store: store,
      apiClient: backend.api,
      onTitleChanged: () {},
    ),
  ));
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pump();
  return store;
}

void main() {
  testWidgets('运行工具在过程块中真实可见：活动条不重复（组抬头/工具行仍在）', (tester) async {
    await _pumpChat(tester, _Backend(events: _runningEvents()));
    expect(find.textContaining('正在调用工具'), findsOneWidget);
    expect(find.text('shell'), findsWidgets);
    expect(
      find.byKey(_activityBarToolsKey),
      findsNothing,
      reason: '工具行可见时活动条不应重复同一运行工具',
    );
    expect(find.textContaining('正在调用 shell…'), findsNothing);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('运行工具在第 51 行被 50 行分批隐藏：活动条保留', (tester) async {
    await _pumpChat(
      tester,
      _Backend(events: _runningEvents(completedTools: 50)),
    );
    // 底部（钉住）时运行工具在第 51 行被分批隐藏：工具行不可见 → 活动条必须保留。
    expect(
      find.byKey(_activityBarToolsKey),
      findsOneWidget,
      reason: '工具行被分批隐藏时活动条必须保留，避免运行状态完全不可见',
    );
    expect(find.textContaining('正在调用 shell…'), findsOneWidget);
    // 懒构建 extent 会随构建修正：分帧把视口收敛到真实底部，确认「显示更多」入口。
    final pos = tester
        .state<ScrollableState>(find.descendant(
          of: find.byType(CustomScrollView),
          matching: find.byType(Scrollable),
        ))
        .position;
    for (var i = 0; i < 12; i++) {
      pos.jumpTo(pos.maxScrollExtent);
      await tester.pump(const Duration(milliseconds: 120));
      if (find.textContaining('显示更多').evaluate().isNotEmpty) break;
    }
    expect(
      find.textContaining('显示更多'),
      findsOneWidget,
      reason: '51 行应触发 50 行分批（显示更多入口）',
    );
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('手动收起运行中的组：工具行隐藏，活动条恢复', (tester) async {
    await _pumpChat(tester, _Backend(events: _runningEvents()));
    expect(find.byKey(_activityBarToolsKey), findsNothing);
    // 运行中的组默认展开；点组抬头手动收起。
    await tester.tap(find.textContaining('正在调用工具'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(
      find.byKey(_activityBarToolsKey),
      findsOneWidget,
      reason: '组收起后运行工具不可见 → 活动条恢复',
    );
    expect(find.textContaining('正在调用 shell…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('无过程块锚点/旧数据：活动条仍显示运行工具', (tester) async {
    await _pumpChat(
      tester,
      _Backend(events: _runningEvents(withTurnStart: false)),
    );
    expect(
      find.byKey(_activityBarToolsKey),
      findsOneWidget,
      reason: '无 turn/start 锚点时过程块不承载工具 → 活动条保留',
    );
    expect(find.textContaining('正在调用 shell…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('上翻离开底部（钉住失效）：活动条恢复显示运行工具', (tester) async {
    await _pumpChat(
      tester,
      _Backend(
        events: _runningEvents(
          completedTools: 3,
          longAssistant: '长回复内容。' * 400,
        ),
      ),
    );
    expect(find.byKey(_activityBarToolsKey), findsNothing,
        reason: '仍在底部时工具可见 → 不重复');
    final pos = tester
        .state<ScrollableState>(find.descendant(
          of: find.byType(CustomScrollView),
          matching: find.byType(Scrollable),
        ))
        .position;
    pos.jumpTo(pos.maxScrollExtent * 0.5);
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.byKey(_activityBarToolsKey),
      findsOneWidget,
      reason: '离开底部后活动条作为固定状态提醒恢复',
    );
    await tester.pump(const Duration(milliseconds: 900));
  });
}
