// issue #144：消息索引 → 对话时间线 seq 跳转（真实 ChatScreen 链路）。
//
// 覆盖：面板「消息」页签读取当前已加载时间线、点按关闭面板并按 seq 定位到目标消息，
// 1.2s 高亮可见且不改变布局；目标不存在时明确 toast，不静默。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/message_index.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/agent_panel.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-144-jump';

http.Response _json(Map<String, dynamic> body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

List<Map<String, dynamic>> _history() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  for (var turn = 1; turn <= 20; turn++) {
    events.add({
      'seq': seq++,
      'type': 'user/message',
      'data': {
        'messageId': 'u$turn',
        'text': '问题 $turn：这是一段用于撑高消息区的用户消息。',
        'sourceKind': 'user',
      },
      'time': 1000 + turn * 100,
    });
    events.add({
      'seq': seq++,
      'type': 'assistant/message',
      'data': {
        'messageId': 'a$turn',
        'turn': turn,
        'text': '回答 $turn：这是用于验证滚动定位的长回复内容。',
      },
      'time': 1000 + turn * 100 + 10,
    });
  }
  return events;
}

class _Backend {
  _Backend({List<Map<String, dynamic>>? events})
    : events = events ?? _history();

  final List<Map<String, dynamic>> events;

  late final Api api =
      Api(
          client: MockClient((request) async {
            final path = request.url.path;
            if (path == '/m/api/history') {
              return _json({'ok': true, 'events': events, 'hasMore': false});
            }
            if (path == '/m/api/event-detail') {
              return _json({'ok': true, 'event': null});
            }
            return _json({'ok': true, 'subagents': <Object>[]});
          }),
        )
        ..baseUrl = 'http://issue144-jump.test'
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
}

Future<AppStore> _pumpChat(WidgetTester tester, _Backend backend) async {
  final store = AppStore(apiClient: backend.api)
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)]
    ..stepDisplayMode = WorkStepDisplayMode.expanded;
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(() async {
    await tester.pump(const Duration(seconds: 1));
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.light(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: const MediaQueryData(size: Size(390, 844)),
          child: ChatScreen(
            key: const ValueKey<String>('issue144-jump'),
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

bool _inChatViewport(WidgetTester tester, Finder finder) {
  if (finder.evaluate().isEmpty) return false;
  final rect = tester.getRect(finder);
  final viewport = tester.getRect(find.byType(CustomScrollView).first);
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

Future<void> _openMessagesTab(WidgetTester tester) async {
  final state = tester.state(find.byType(ChatScreen));
  final context = tester.element(find.byType(ChatScreen));
  unawaited(
    showAgentPanel(
      context,
      store: (state as dynamic).widget.store as AppStore,
      sessionId: _session,
      title: 'S',
      apiClient: (state as dynamic).widget.apiClient as Api?,
      messageIndexLoader: () =>
          (state as dynamic).debugLoadMessageIndex()
              as Future<MessageIndexSnapshot>,
      onOpenMessage: (seq) =>
          (state as dynamic).debugJumpToMessageSeq(seq) as Future<void>,
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey<String>('agent-tab-messages')));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => L10n.lang = 'zh');
  tearDown(() => L10n.lang = 'zh');

  testWidgets('点按消息索引行：关闭面板、按 seq 定位并高亮目标消息', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend);
    // 目标：第 17 轮用户消息（seq=33）；初始在底部视口之外。
    // （面板新→旧排序，该行在前 8 行内可直接点按。）
    const targetSeq = 33;
    final targetText = find.text('问题 17：这是一段用于撑高消息区的用户消息。');
    expect(_inChatViewport(tester, targetText), isFalse);

    final entries =
        (tester.state(
              find.byType(ChatScreen),
            ) as dynamic).debugMessageIndexEntries
            as List<Object?>;
    expect(entries, isNotEmpty);
    expect(
      (tester.state(find.byType(ChatScreen)) as dynamic)
              .debugMessageIndexEntries
              .any((e) => (e as dynamic).seq == targetSeq)
          as bool,
      isTrue,
      reason: '当前已加载消息应进入索引（含第 17 轮）',
    );

    await _openMessagesTab(tester);
    final row = find.byKey(
      const ValueKey<String>('message-index-row:$targetSeq'),
    );
    expect(row, findsOneWidget);
    await tester.tap(row);
    await tester.pump();
    // 路由 pop 有动画；先推进动画帧，再确认面板已关闭。
    await tester.pump(const Duration(milliseconds: 400));

    // 定位循环按帧推进，高亮在成功后的 1.2s 内出现。
    expect(find.byType(AgentPanelScreen), findsNothing);
    var sawHighlight = false;
    for (var i = 0; i < 120; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (find
          .byKey(const ValueKey<String>('message-highlight:$targetSeq'))
          .evaluate()
          .isNotEmpty) {
        sawHighlight = true;
      }
      if (_inChatViewport(tester, targetText)) break;
    }
    expect(_inChatViewport(tester, targetText), isTrue, reason: '目标消息必须进入视口');
    expect(sawHighlight, isTrue, reason: '定位成功后应出现 1.2s 高亮');
    expect(tester.takeException(), isNull);
    expect(store.sessionId, _session, reason: '跳转不改变当前会话');
  });

  testWidgets('无可见目标的团队行：禁用并显示「仅日志」，不关闭面板', (tester) async {
    final hiddenTeam = {
      'seq': 41,
      'type': 'team/message/queued',
      'data': {
        'messageId': 'tm-hidden',
        'senderName': '发布协调员',
        'targetId': 'session-b',
        'text': '这条团队消息只出现在索引，不在普通时间线渲染。',
      },
      'time': 3000,
    };
    final backend = _Backend(events: [..._history(), hiddenTeam]);
    await _pumpChat(tester, backend);
    await _openMessagesTab(tester);

    final row = find.byKey(const ValueKey<String>('message-index-row:41'));
    expect(row, findsOneWidget);
    expect(find.textContaining('仅日志'), findsOneWidget);
    expect(
      tester.widget<InkWell>(row).onTap,
      isNull,
      reason: '只有 debug-only 团队事件时不得假装可跳转',
    );

    await tester.tap(row, warnIfMissed: false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.byType(AgentPanelScreen),
      findsOneWidget,
      reason: '不可跳转行不应关闭面板',
    );
    expect(find.text('未找到该消息（可能已被压缩或替换）'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('真实历史倒序：queued→delivered→可见 user 同 messageId 时跳到 user、状态已投递', (
    tester,
  ) async {
    // 历史按时间正序返回；ChatScreen 用 events.reversed 观察 → delivered 先入索引，
    // 再 queued、最后才是可见 user/message。必须：目标 seq = user(41)，状态不回退。
    final teamVisibleUser = {
      'seq': 41,
      'type': 'user/message',
      'data': {
        'messageId': 'um-team',
        'text': '请补截图',
        'sourceKind': 'team-message',
        'sourceSenderName': '前端审计',
        'sourceSenderId': 'session-c',
        'sourceMessageId': 'tm-visible',
      },
      'time': 3100,
    };
    final teamQueued = {
      'seq': 42,
      'type': 'team/message/queued',
      'data': {
        'messageId': 'tm-visible',
        'senderName': '前端审计',
        'targetId': 'session-b',
        'text': '请补截图',
      },
      'time': 3110,
    };
    final teamDelivered = {
      'seq': 43,
      'type': 'team/message/delivered',
      'data': {'messageId': 'tm-visible', 'targetId': 'session-b'},
      'time': 3120,
    };
    final backend = _Backend(
      events: [..._history(), teamVisibleUser, teamQueued, teamDelivered],
    );
    await _pumpChat(tester, backend);
    await _openMessagesTab(tester);

    // 同一 messageId 只一行，且落在可见 user seq；投递状态为已投递（非已排队）。
    expect(
      find.byKey(const ValueKey<String>('message-index-row:41')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('message-index-row:43')),
      findsNothing,
      reason: 'debug-only delivered seq 不得成为跳转目标',
    );
    expect(find.text('已投递'), findsOneWidget);
    expect(find.text('已排队'), findsNothing);
    expect(find.textContaining('团队 · 前端审计 → 主代理'), findsOneWidget);

    final targetText = find.text('请补截图');
    await tester.tap(
      find.byKey(const ValueKey<String>('message-index-row:41')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(AgentPanelScreen), findsNothing);

    var sawHighlight = false;
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (find
          .byKey(const ValueKey<String>('message-highlight:41'))
          .evaluate()
          .isNotEmpty) {
        sawHighlight = true;
      }
    }
    expect(
      _inChatViewport(tester, targetText),
      isTrue,
      reason: '跳转目标必须是普通时间线可见的 team user 消息',
    );
    expect(sawHighlight, isTrue);
    expect(find.text('未找到该消息（可能已被压缩或替换）'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('目标不存在：明确 toast，不静默、不改变会话', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend);
    final state = tester.state(find.byType(ChatScreen));
    // 不要直接 await：定位实现内部会 await 下一帧，测试必须自己 pump。
    unawaited((state as dynamic).debugJumpToMessageSeq(999999) as Future<void>);
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(
      find.text('未找到该消息（可能已被压缩或替换）'),
      findsOneWidget,
      reason: '定位失败必须给用户明确提示',
    );
    expect(tester.takeException(), isNull);
    expect(store.sessionId, _session);
  });
}
