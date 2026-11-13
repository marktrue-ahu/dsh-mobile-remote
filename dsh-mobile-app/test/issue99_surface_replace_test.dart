// issue #99：compaction surface replace replay（sourceEventSeqs + surfaceOp=replace）
// 必须按替换语义消费：不新增工具行、旧 shadowed 事件不显示、replay 不生成历史工具卡。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/timeline.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _callId = 'call_00_mx03kxx6nhrcr2xruau1vg9u';

ChatEvent _event(
  int seq,
  String type,
  Map<String, dynamic> data, {
  List<int>? sourceEventSeqs,
  Map<String, dynamic>? surfaceOp,
}) => ChatEvent(
  seq: seq,
  type: type,
  data: data,
  sourceEventSeqs: sourceEventSeqs ?? const [],
  surfaceOp: SurfaceOp.fromJson(surfaceOp),
);

Map<String, dynamic> _replayJson() => {
  'seq': 13283,
  'type': 'tool/result',
  'time': 1794490887536,
  'data': {'turn': 148, 'step': 1, 'callId': _callId, 'name': 'bash', 'text': 'note 2312'},
  'sourceEventSeqs': [9142],
  'surfaceOp': {'op': 'replace', 'startSeq': 9142, 'endSeq': 9142},
};

void main() {
  test('issue #99：ChatEvent 解析 surfaceOp/sourceEventSeqs（history/SSE 同一摘要）', () {
    final event = ChatEvent.fromJson(_replayJson());
    expect(event.isSurfaceReplace, isTrue);
    expect(event.surfaceAnchorSeq, 9142);
    expect(event.sourceEventSeqs, [9142]);
    expect(event.surfaceOp?.op, 'replace');
    expect(event.surfaceOp?.startSeq, 9142);
    expect(event.data?['callId'], _callId);
    // 旧 App 兼容：无字段时默认空/非 replace。
    final plain = ChatEvent.fromJson({'seq': 1, 'type': 'tool/result', 'data': {}});
    expect(plain.isSurfaceReplace, isFalse);
    expect(plain.sourceEventSeqs, isEmpty);
    expect(plain.surfaceAnchorSeq, 1);
  });

  test('issue #99：原 9142 + replace 13283 合并为同一工具行，不追加 replay 行', () {
    final reducer = TimelineReducer();
    reducer.apply(_event(9139, 'tool/call', {'turn': 148, 'step': 1, 'callId': _callId, 'name': 'bash', 'arguments': 'ls'}));
    reducer.apply(_event(9142, 'tool/result', {'turn': 148, 'step': 1, 'callId': _callId, 'name': 'bash', 'text': 'old'}));
    reducer.apply(ChatEvent.fromJson(_replayJson()));
    final toolItems = reducer.items.where((item) => item.kind == TimelineItemKind.tool).toList();
    expect(toolItems, hasLength(1), reason: 'surface replace 不得新增工具行');
    expect(toolItems.single.seq, 9139, reason: '工具行仍锚定原调用位置');
    expect(reducer.tools[_callId]?.result, contains('note 2312'), reason: '替换内容覆盖原结果');
    expect(reducer.tools.length, 1);
  });

  test('issue #99：只有 replay 时按 source seq 记录、不生成任何工具行（历史卡不出现）', () {
    final reducer = TimelineReducer();
    reducer.apply(ChatEvent.fromJson(_replayJson()));
    expect(reducer.items.where((item) => item.kind == TimelineItemKind.tool), isEmpty);
    expect(reducer.tools[_callId]?.seq, 9142, reason: 'replay-only 锚点回落到 source seq');
  });

  test('issue #99：晚到的旧 shadowed seq 不再显示', () {
    final reducer = TimelineReducer();
    reducer.apply(_event(1, 'turn/start', {'turn': 220}));
    reducer.apply(ChatEvent.fromJson(_replayJson()));
    reducer.apply(_event(9142, 'tool/result', {'turn': 148, 'step': 1, 'callId': _callId, 'name': 'bash', 'text': 'old'}));
    expect(reducer.items.where((item) => item.kind == TimelineItemKind.tool), isEmpty);
    // 原事件已在 replace 时记录替代内容，晚到旧内容不得覆盖。
    expect(reducer.tools[_callId]?.result, contains('note 2312'));
  });

  test('issue #99：tracker 不把 replay-only 工具生成历史过程组', () {
    final tracker = TurnProcessTracker();
    tracker.observe(_event(1, 'turn/start', {'turn': 220}));
    tracker.observe(_event(2, 'tool/call', {'turn': 220, 'step': 1, 'callId': 'c-now', 'name': 'bash', 'arguments': 'ls'}));
    tracker.observe(_event(3, 'tool/result', {'turn': 220, 'step': 1, 'callId': 'c-now', 'name': 'bash', 'text': 'ok'}));
    tracker.observe(ChatEvent.fromJson(_replayJson()));
    final processes = tracker.build();
    expect(processes.any((process) => process.turn == 148), isFalse,
        reason: 'surface replay 不得生成历史工具结果 partial 组');
    expect(processes.any((process) => process.turn == 220), isTrue);
  });

  group('issue #99 widget：当前轮 + replay-only 旧工具', () {
    List<Map<String, dynamic>> fixture() => [
      {'seq': 1, 'type': 'turn/start', 'data': {'turn': 220}},
      {'seq': 2, 'type': 'user/message', 'data': {'messageId': 'u1', 'text': '开始', 'sourceKind': 'user'}},
      {'seq': 3, 'type': 'tool/call', 'data': {'turn': 220, 'step': 1, 'callId': 'c-now', 'name': 'bash', 'arguments': 'ls'}},
      {'seq': 4, 'type': 'tool/result', 'data': {'turn': 220, 'step': 1, 'callId': 'c-now', 'name': 'bash', 'text': 'ok'}},
      _replayJson(),
      {'seq': 13284, 'type': 'assistant/message', 'data': {'turn': 220, 'step': 1, 'messageId': 'a1', 'text': '最终回答'}},
      {'seq': 13285, 'type': 'turn/end', 'data': {'turn': 220, 'reason': {'kind': 'completed'}}},
    ];

    Future<AppStore> pump(WidgetTester tester) async {
      final backend = _Backend(events: fixture());
      final store = AppStore()
        ..sessionId = 'session-99'
        ..sessions = [Session(id: 'session-99', title: 'S', cwd: null, createdAt: 1)];
      await tester.pumpWidget(MaterialApp(
        home: ChatScreen(store: store, apiClient: backend.api, onTitleChanged: () {}),
      ));
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pump(const Duration(milliseconds: 150));
      return store;
    }

    testWidgets('原 9142 + replace 13283 + 当前轮：note2312 最多一份', (tester) async {
      final events = fixture();
      // 在 replay 之前插入被替换的原始工具结果（同 callId，无 turn/start）。
      events.insert(4, {'seq': 9142, 'type': 'tool/result', 'data': {'turn': 148, 'step': 1, 'callId': _callId, 'name': 'bash', 'text': 'old note'}});
      final backend = _Backend(events: events);
      final store = AppStore()
        ..sessionId = 'session-99'
        ..sessions = [Session(id: 'session-99', title: 'S', cwd: null, createdAt: 1)];
      await tester.pumpWidget(MaterialApp(
        home: ChatScreen(store: store, apiClient: backend.api, onTitleChanged: () {}),
      ));
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pump(const Duration(milliseconds: 150));
      expect(find.byKey(const Key('historical-tool-results-148')), findsOneWidget,
          reason: '原 9142 与 replay 13283 必须合并为一份历史工具组，不能各生成一份');
      expect(find.text('1 组 · 1 次工具调用'), findsNWidgets(2), reason: '当前轮 1 组 + 历史 1 组');
    });

    testWidgets('SSE 路径：live frame 携带 surfaceOp 也不生成历史工具卡', (tester) async {
      final store = await pump(tester);
      store.injectFrame({'type': 'session/event', 'sessionId': 'session-99', 'event': _replayJson()});
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('历史工具结果（无过程上下文）'), findsNothing);
      expect(find.byKey(const Key('historical-tool-results-148')), findsNothing);
      expect(find.textContaining('note 2312'), findsNothing);
      store.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('不出现网页没有的历史工具结果卡/旧 note2312', (tester) async {
      await pump(tester);
      expect(find.text('历史工具结果（无过程上下文）'), findsNothing);
      expect(find.byKey(const Key('historical-tool-results-148')), findsNothing);
      expect(find.textContaining('note 2312'), findsNothing);
      // 当前轮工具只出现一次。
      expect(find.text('1 组 · 1 次工具调用'), findsOneWidget);
    });
  });
}

class _Backend {
  _Backend({required this.events});
  final List<Map<String, dynamic>> events;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue99.test'
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
    final path = request.url.path;
    Map<String, dynamic> body;
    if (path == '/m/api/history') {
      body = {'ok': true, 'events': events, 'hasMore': false};
    } else if (path == '/m/api/queue') {
      body = {'ok': true, 'rows': <Object>[]};
    } else if (path == '/m/api/todos') {
      body = {'ok': true, 'todos': <Object>[]};
    } else if (path == '/m/api/session-config') {
      body = {'ok': true, 'config': <String, dynamic>{}};
    } else if (path == '/m/api/commands' || path == '/m/api/skills') {
      body = {'ok': true, 'commands': <Object>[], 'skills': <Object>[]};
    } else {
      body = {'ok': true};
    }
    return http.Response(jsonEncode(body), 200,
        headers: {'content-type': 'application/json; charset=utf-8'});
  }
}
