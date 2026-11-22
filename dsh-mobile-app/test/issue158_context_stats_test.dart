// issue #158：输入区上下文统计抽屉（入口 / 三 Tab / 旧宿主降级 / 失败重试 /
// 切会话关闭 / 320+深色+1.5×+2.0×）。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-158';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

List<Map<String, dynamic>> _history() => [
  {
    'seq': 1,
    'type': 'turn/start',
    'data': {'turn': 1},
    'time': 1000,
  },
  {
    'seq': 2,
    'type': 'user/message',
    'data': {'messageId': 'u1', 'text': '看看上下文', 'sourceKind': 'user'},
    'time': 1010,
  },
  {
    'seq': 3,
    'type': 'assistant/message',
    'data': {'messageId': 'a1', 'turn': 1, 'text': '好的，已统计。'},
    'time': 1020,
  },
  {
    'seq': 4,
    'type': 'turn/end',
    'data': {'turn': 1},
    'time': 1030,
  },
];

Map<String, dynamic> _fullStats() => {
  'ok': true,
  'sessionId': _session,
  'pressure': {
    'pressureTokens': 1000,
    'projectedTokens': 2400,
    'contextWindow': 8000,
    'percent': 30,
  },
  'breakdown': {
    'systemTokens': 400,
    'toolsTokens': 600,
    'messageTokens': 800,
    'estimated': true,
  },
  'tokenUsage': {
    'uncachedInput': 100,
    'output': 50,
    'cacheRead': 300,
    'cacheWrite': 100,
    'cacheHitRate': 0.6,
  },
  'timing': {
    'turns': 2,
    'steps': 4,
    'llmMs': 1000,
    'toolMs': 500,
    'ttftMs': 400,
    'decodeMs': 2000,
    'avgTtftMs': 200,
    'tps': 50,
  },
  'sources': {
    'pressure': 'provider',
    'breakdown': 'heuristic',
    'tokenUsage': 'provider',
    'timing': 'session-stats',
  },
  'asOfSeq': 4,
};

Map<String, dynamic> _legacyUsage() => {
  'ok': true,
  'usage': {
    'inputTokens': 100,
    'outputTokens': 50,
    'cacheReadTokens': 300,
    'cacheWriteTokens': 100,
    'pressureTokens': 2000,
  },
  'contextWindow': 8000,
};

class _Backend {
  _Backend({
    this.statsStatus = 200,
    this.statsBody,
    Map<String, dynamic>? usage,
  }) : usage = usage ?? _legacyUsage();

  int statsStatus;
  Map<String, dynamic>? statsBody;
  Map<String, dynamic> usage;
  int statsCalls = 0;
  int usageCalls = 0;
  Completer<void>? statsGate;

  late final Api api =
      Api(
          client: MockClient((request) async {
            final path = request.url.path;
            if (path == '/m/api/history') {
              return _json({
                'ok': true,
                'events': _history(),
                'hasMore': false,
              });
            }
            if (path == '/m/api/usage') {
              usageCalls++;
              return _json(usage);
            }
            if (path == '/m/api/context-stats') {
              statsCalls++;
              final gate = statsGate;
              if (gate != null) await gate.future;
              if (statsStatus != 200) {
                return _json({'error': 'boom'}, statsStatus);
              }
              return _json(statsBody ?? _fullStats());
            }
            if (path == '/m/api/event-detail') {
              return _json({'ok': true, 'event': null});
            }
            return _json({'ok': true, 'subagents': <Object>[]});
          }),
        )
        ..baseUrl = 'http://issue158.test'
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

Future<AppStore> _pumpChat(
  WidgetTester tester,
  _Backend backend, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
  String tag = '',
}) async {
  final store = AppStore(apiClient: backend.api)
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)]
    ..stepDisplayMode = WorkStepDisplayMode.expanded;
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(() async {
    await tester.pump(const Duration(seconds: 1));
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQueryData(size: size, textScaler: textScaler),
          child: ChatScreen(
            key: ValueKey<String>('issue158-$tag'),
            store: store,
            apiClient: backend.api,
            onTitleChanged: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pumpAndSettle();
  return store;
}

Future<void> _openSheet(WidgetTester tester) async {
  expect(
    find.byKey(const ValueKey<String>('context-stats-trigger')),
    findsOneWidget,
  );
  await tester.tap(find.byKey(const ValueKey<String>('context-stats-trigger')));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => L10n.lang = 'zh');
  tearDown(() => L10n.lang = 'zh');

  testWidgets('入口 44dp + 三 Tab 完整数据：构成/Token/会话统计', (tester) async {
    final backend = _Backend();
    await _pumpChat(tester, backend);
    final trigger = find.byKey(const ValueKey<String>('context-stats-trigger'));
    expect(trigger, findsOneWidget);
    expect(tester.getSize(trigger), const Size(44, 44));
    expect(tester.getSemantics(trigger).label, contains('点按查看明细'));

    await _openSheet(tester);
    final percent = tester.widget<Text>(
      find.byKey(const ValueKey<String>('context-stats-percent')),
    );
    expect(percent.data, '30%');
    expect(find.text('~2.4k / 8.0k'), findsOneWidget);
    expect(find.text('系统提示'), findsOneWidget);
    expect(find.text('工具定义'), findsOneWidget);
    expect(find.text('会话消息'), findsOneWidget);
    expect(find.textContaining('不保证相加'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-tokens')),
    );
    await tester.pumpAndSettle();
    expect(find.text('未缓存输入'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);
    expect(find.text('60%'), findsOneWidget);
    expect(find.text('本会话累计用量（不是当前上下文占用）'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-stats')),
    );
    await tester.pumpAndSettle();
    expect(find.text('轮次'), findsOneWidget);
    expect(find.text('步数'), findsOneWidget);
    expect(find.text('200ms'), findsOneWidget);
    expect(find.text('50.0 tok/s'), findsOneWidget);
    expect(find.textContaining('整份会话累计'), findsOneWidget);

    expect(find.textContaining('不显示对话正文'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey<String>('context-stats-close')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey<String>('context-stats-percent')),
      findsNothing,
    );
  });

  testWidgets('pressure 缺失：累计量>窗口也不显示 100%，入口仍可点且三 Tab 独立降级', (tester) async {
    final backend = _Backend(
      usage: {
        'ok': true,
        'usage': {
          'inputTokens': 10000,
          'outputTokens': 10,
          'cacheReadTokens': 5000,
          'cacheWriteTokens': 0,
        },
        'contextWindow': 8000,
      },
      statsBody: {
        'ok': true,
        'sessionId': _session,
        'tokenUsage': {
          'uncachedInput': 10000,
          'output': 10,
          'cacheRead': 5000,
          'cacheWrite': 0,
        },
        'timing': {
          'turns': 1,
          'steps': 2,
          'llmMs': 100,
          'toolMs': 20,
          'ttftMs': 30,
          'decodeMs': 40,
          'avgTtftMs': 30,
          'tps': 2.5,
        },
      },
    );
    await _pumpChat(tester, backend);
    final trigger = find.byKey(const ValueKey<String>('context-stats-trigger'));
    expect(trigger, findsOneWidget);
    expect(tester.getSize(trigger), const Size(44, 44));
    expect(
      find.byKey(const ValueKey<String>('context-stats-unknown')),
      findsOneWidget,
    );
    expect(find.textContaining('100%'), findsNothing);

    await _openSheet(tester);
    final percent = tester.widget<Text>(
      find.byKey(const ValueKey<String>('context-stats-percent')),
    );
    expect(percent.data, '--');
    expect(find.text('当前电脑端未提供构成'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-tokens')),
    );
    await tester.pumpAndSettle();
    expect(find.text('未缓存输入'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-stats')),
    );
    await tester.pumpAndSettle();
    expect(find.text('轮次'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('无数据：上下文 -- 仍可点，三 Tab 各自空态', (tester) async {
    final backend = _Backend(
      usage: {'ok': true, 'usage': <String, dynamic>{}},
      statsBody: {'ok': true, 'sessionId': _session},
    );
    await _pumpChat(tester, backend);
    final trigger = find.byKey(const ValueKey<String>('context-stats-trigger'));
    expect(trigger, findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('context-stats-unknown')),
      findsOneWidget,
    );
    await _openSheet(tester);
    expect(find.text('等待首次请求后生成构成估算'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-tokens')),
    );
    await tester.pumpAndSettle();
    expect(find.text('等待首次用量'), findsWidgets);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-stats')),
    );
    await tester.pumpAndSettle();
    expect(find.text('等待首次用量'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('旧宿主：context-stats 404 → /usage 回退，构成/统计明确降级', (tester) async {
    final backend = _Backend(statsStatus: 404);
    await _pumpChat(tester, backend);
    await _openSheet(tester);

    expect(find.textContaining('旧版 /usage'), findsWidgets);
    expect(find.text('当前电脑端未提供构成'), findsOneWidget);
    expect(find.text('~2.0k / 8.0k'), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-tokens')),
    );
    await tester.pumpAndSettle();
    expect(find.text('未缓存输入'), findsOneWidget);
    expect(find.text('60%'), findsOneWidget);
    expect(find.textContaining('旧版 /usage'), findsWidgets);

    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-stats')),
    );
    await tester.pumpAndSettle();
    expect(find.text('当前电脑端未提供会话统计'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('加载中：请求未完成时 sheet 显示 spinner', (tester) async {
    final backend = _Backend()..statsGate = Completer<void>();
    await _pumpChat(tester, backend);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-trigger')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    backend.statsGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('系统提示'), findsOneWidget);
  });

  testWidgets('失败：错误 + 重试成功后恢复', (tester) async {
    final backend = _Backend(statsStatus: 500);
    await _pumpChat(tester, backend);
    await _openSheet(tester);
    expect(find.text('上下文统计加载失败'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('context-stats-retry')),
      findsOneWidget,
    );

    backend.statsStatus = 200;
    await tester.tap(find.byKey(const ValueKey<String>('context-stats-retry')));
    await tester.pumpAndSettle();
    expect(find.text('系统提示'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('部分数据：构成/统计各自降级，Token 仍可用', (tester) async {
    final backend = _Backend(
      statsBody: {
        'ok': true,
        'sessionId': _session,
        'pressure': {
          'projectedTokens': 2400,
          'contextWindow': 8000,
          'percent': 30,
        },
        'tokenUsage': {
          'uncachedInput': 100,
          'output': 50,
          'cacheRead': 300,
          'cacheWrite': 100,
          'cacheHitRate': 0.6,
        },
      },
    );
    await _pumpChat(tester, backend);
    await _openSheet(tester);

    expect(find.text('当前电脑端未提供构成'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-tokens')),
    );
    await tester.pumpAndSettle();
    expect(find.text('未缓存输入'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-tab-stats')),
    );
    await tester.pumpAndSettle();
    expect(find.text('当前电脑端未提供会话统计'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('SSE：当前会话 turn/end 刷新 sheet；别的会话事件不刷新', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend);
    await _openSheet(tester);
    final before = backend.statsCalls;

    store.injectFrame({
      'type': 'session/event',
      'sessionId': _session,
      'event': {
        'seq': 5,
        'type': 'turn/end',
        'data': {'turn': 1},
      },
    });
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();
    expect(backend.statsCalls, greaterThan(before), reason: '当前会话事件应触发刷新');

    final afterCurrent = backend.statsCalls;
    store.injectFrame({
      'type': 'session/event',
      'sessionId': 'session-other',
      'event': {
        'seq': 6,
        'type': 'turn/end',
        'data': {'turn': 1},
      },
    });
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();
    expect(backend.statsCalls, afterCurrent, reason: '别的会话不得刷新/串数据');
    expect(tester.takeException(), isNull);
  });

  testWidgets('刷新失败：保留旧值但显示过期提示 + 重试', (tester) async {
    final backend = _Backend();
    await _pumpChat(tester, backend);
    await _openSheet(tester);
    expect(find.text('系统提示'), findsOneWidget);

    backend.statsStatus = 500;
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-refresh')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey<String>('context-stats-stale-notice')),
      findsOneWidget,
    );
    expect(find.textContaining('数据可能已过期'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('context-stats-stale-retry')),
      findsOneWidget,
    );
    expect(find.text('系统提示'), findsOneWidget, reason: '旧值仍保留');

    backend.statsStatus = 200;
    await tester.tap(
      find.byKey(const ValueKey<String>('context-stats-stale-retry')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey<String>('context-stats-stale-notice')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('切换会话：打开中的 sheet 自动关闭，不串数据', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend);
    await _openSheet(tester);
    expect(find.text('系统提示'), findsOneWidget);

    store.sessionId = 'session-other';
    (store as dynamic).notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('系统提示'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 / 深色 / 1.5×：抽屉不溢出、三 Tab 可读', (tester) async {
    final backend = _Backend();
    await _pumpChat(
      tester,
      backend,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
      tag: '320-1.5',
    );
    await _openSheet(tester);
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(
        find.byKey(const ValueKey<String>('context-stats-trigger')),
      ),
      const Size(44, 44),
    );
    expect(find.text('系统提示'), findsOneWidget);
    expect(find.text('上下文构成'), findsOneWidget);
    expect(find.text('Token 用量'), findsOneWidget);
    expect(find.text('会话统计'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 / 2.0×：TabBar 可滚动且抽屉不横向溢出', (tester) async {
    final backend = _Backend();
    await _pumpChat(
      tester,
      backend,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(2),
      theme: DshTheme.dark(),
      tag: '320-2.0',
    );
    await _openSheet(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('上下文构成'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
