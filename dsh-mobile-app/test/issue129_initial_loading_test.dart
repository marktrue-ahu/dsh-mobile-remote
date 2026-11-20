// issue #129：首次打开会话的加载动效（三态：loading / empty / failed）。
//
// 验收口径（GitLab #129 + UI 顾问硬要求）：
//   1. 三态放在 `CustomScrollView` 外面，整页替换消息区（不塞 sliver）；
//   2. loading：首帧即出现，20×20 spinner(strokeWidth 2) +「正在加载会话…」；
//   3. empty：成功加载且时间线为空才进入，明确文案 + 下一步提示；
//   4. failed：图标 + 标题 + 原因 + 重试 + 返回会话列表；不自动 pop；
//      404/session-not-found/缺 sessionId 为 dead-end（无重试），503/超时/网络可重试；
//   5. 已有内容/SSE 先到不进三态（避免闪整页）；
//   6. 320dp/深色/1.5x 不溢出；
//   7. 长会话首屏落底（内容挂载后的帧后强制跟随）。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue129_initial_loading_test.dart

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-129';
const _loadingKey = ValueKey<String>('chat-initial-loading');
const _emptyKey = ValueKey<String>('chat-session-empty');
const _failedKey = ValueKey<String>('chat-initial-failed');
const _degradedEmptyKey = ValueKey<String>('chat-session-empty-degraded');

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

http.Response _page(List<Map<String, dynamic>> events) =>
    _json({'ok': true, 'events': events, 'hasMore': false});

Map<String, dynamic> _ev(String type, int seq, Map<String, dynamic> data) => {
  'seq': seq,
  'type': type,
  'data': data,
  'time': 1000 + seq * 10,
};

List<Map<String, dynamic>> _oneMessage([String text = '你好，会话']) => [
  _ev('turn/start', 1, {'turn': 1}),
  _ev('user/message', 2, {
    'messageId': 'u1',
    'text': '开始任务',
    'sourceKind': 'user',
  }),
  _ev('assistant/message', 3, {
    'turn': 1,
    'step': 1,
    'messageId': 'a1',
    'text': text,
  }),
];

List<Map<String, dynamic>> _longHistory() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  for (var turn = 1; turn <= 40; turn++) {
    events.add(_ev('turn/start', seq++, {'turn': turn}));
    events.add(
      _ev('user/message', seq++, {
        'messageId': 'u$turn',
        'text': '第 $turn 轮提问：这是一段用来撑高消息区的用户消息。',
        'sourceKind': 'user',
      }),
    );
    events.add(
      _ev('assistant/message', seq++, {
        'turn': turn,
        'step': 1,
        'messageId': 'a$turn',
        'text': '第 $turn 轮回答：这是最后一条回复，用于验证首屏落底。',
      }),
    );
    events.add(
      _ev('turn/end', seq++, {
        'turn': turn,
        'reason': {'kind': 'completed'},
      }),
    );
  }
  return events;
}

/// 历史加载可控的假服务端：`handleHistory` 决定每次 `/api/history` 的响应。
class _Backend {
  _Backend(this.handleHistory);

  final Future<http.Response> Function(http.Request request) handleHistory;
  final List<http.Request> historyRequests = [];

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue129.test'
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
    if (path == '/m/api/history') {
      historyRequests.add(request);
      return handleHistory(request);
    }
    if (path == '/m/api/event-detail') {
      return _json({'ok': true, 'event': null});
    }
    return _json({'ok': true});
  }
}

class _Probe {
  _Probe(this.tester);

  final WidgetTester tester;

  ScrollPosition get position => tester
      .state<ScrollableState>(
        find
            .descendant(
              of: find.byType(CustomScrollView),
              matching: find.byType(Scrollable, skipOffstage: false),
            )
            .first,
      )
      .position;
}

Future<AppStore> _pumpChat(
  WidgetTester tester, {
  required _Backend backend,
  String? sessionId = _session,
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
  String tag = '',
}) async {
  final store = AppStore()..sessionId = sessionId;
  if (sessionId != null) {
    store.sessions = [
      Session(id: sessionId, title: 'S', cwd: null, createdAt: 1),
    ];
  }
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  // 注入帧会起 800ms 会话列表去抖 Timer；先让它跑完，避免 pending timer 掩盖真失败。
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
            key: ValueKey<String>(
              'issue129-${sessionId ?? 'none'}-${size.width}-$tag',
            ),
            store: store,
            apiClient: backend.api,
            onTitleChanged: () {},
          ),
        ),
      ),
    ),
  );
  return store;
}

/// 在路由里打开聊天页（用于验证「返回会话列表」真的 pop）。
Future<void> _pumpChatInRoute(
  WidgetTester tester, {
  required _Backend backend,
}) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)];
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(() async {
    await tester.pump(const Duration(seconds: 1));
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.light(),
      home: Scaffold(
        body: Builder(
          builder: (ctx) => TextButton(
            onPressed: () => Navigator.of(ctx).push(
              MaterialPageRoute<void>(
                builder: (_) => ChatScreen(
                  store: store,
                  apiClient: backend.api,
                  onTitleChanged: () {},
                ),
              ),
            ),
            child: const Text('open-chat'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open-chat'));
  await tester.pumpAndSettle();
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pumpAndSettle();
  // 注入 SSE 帧会起 800ms 的会话列表去抖 Timer：推进到结束，避免 pending timer。
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  tearDown(() => L10n.lang = 'zh');

  group('#129 loading：首帧出现、不依赖延时', () {
    testWidgets('挂起 /history：pumpWidget 首帧即 loading（20×20 spinner + 文案）', (
      tester,
    ) async {
      final completer = Completer<http.Response>();
      final backend = _Backend((_) => completer.future);
      await _pumpChat(tester, backend: backend);

      // 不额外 pump/settle：pumpWidget 的第一帧就必须是 loading。
      expect(find.byKey(_loadingKey), findsOneWidget);
      expect(find.text('正在加载会话…'), findsOneWidget);
      expect(find.byKey(_emptyKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      final spinner = tester.widget<CircularProgressIndicator>(
        find.byType(CircularProgressIndicator),
      );
      expect(spinner.strokeWidth, 2);
      expect(
        tester.getSize(find.byType(CircularProgressIndicator)),
        const Size(20, 20),
      );
      expect(tester.takeException(), isNull);

      completer.complete(_page(const []));
      await _settle(tester);
    });
  });

  group('#129 empty：成功后空时间线才进入', () {
    testWidgets('空会话显示明确文案与下一步，且不在 CustomScrollView 内', (tester) async {
      await _pumpChat(tester, backend: _Backend((_) async => _page(const [])));
      await _settle(tester);

      expect(find.byKey(_emptyKey), findsOneWidget);
      expect(find.text('这个会话还没有消息'), findsOneWidget);
      expect(find.text('在下方输入框发送第一条消息'), findsOneWidget);
      expect(find.byKey(_loadingKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      expect(
        find.byType(CustomScrollView),
        findsNothing,
        reason: '三态必须整页替换消息区，而不是塞进/包着 CustomScrollView',
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('#129 empty：降级（degraded）与 reset 重同步', () {
    testWidgets('degraded=true + 空 events：用降级空态，不冒充“新会话”', (tester) async {
      final backend = _Backend(
        (_) async => _json({
          'ok': true,
          'events': <Object>[],
          'hasMore': false,
          'degraded': true,
        }),
      );
      await _pumpChat(tester, backend: backend);
      await _settle(tester);

      expect(find.byKey(_degradedEmptyKey), findsOneWidget);
      expect(find.text('当前没有可恢复的消息'), findsOneWidget);
      expect(find.text('仅恢复了部分历史，可在电脑端查看完整会话'), findsOneWidget);
      expect(
        find.byKey(_emptyKey),
        findsNothing,
        reason: '降级空表面不能使用“这个会话还没有消息/发送第一条消息”的普通空态',
      );
      expect(find.text('这个会话还没有消息'), findsNothing);
      expect(find.text('在下方输入框发送第一条消息'), findsNothing);
      expect(
        find.textContaining('当前仅能恢复部分历史'),
        findsOneWidget,
        reason: '既有降级横幅仍在',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('reset:true 重同步：不进入 loading，保留时间线直到新内容到达', (tester) async {
      final resetCompleter = Completer<http.Response>();
      var calls = 0;
      final backend = _Backend((request) {
        calls++;
        if (calls == 1) {
          return Future.value(
            _page([
              _ev('turn/start', 1, {'turn': 1}),
              _ev('user/message', 2, {
                'messageId': 'u1',
                'text': '重同步前的用户消息',
                'sourceKind': 'user',
              }),
            ]),
          );
        }
        return resetCompleter.future;
      });
      final store = await _pumpChat(tester, backend: backend);
      await _settle(tester);
      expect(find.text('重同步前的用户消息'), findsOneWidget);

      // turn/end 触发 #13 的兜底补拉 → _load(reset:true)
      store.injectFrame({
        'type': 'session/event',
        'sessionId': _session,
        'event': _ev('turn/end', 3, {
          'turn': 1,
          'reason': {'kind': 'completed'},
        }),
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        find.byKey(_loadingKey),
        findsNothing,
        reason: 'reset 重同步不得把已有时间线整页换成 loading',
      );
      expect(
        find.text('重同步前的用户消息'),
        findsOneWidget,
        reason: '重同步期间保留旧时间线，避免整页闪动',
      );

      resetCompleter.complete(
        _page([
          _ev('turn/start', 1, {'turn': 1}),
          _ev('user/message', 2, {
            'messageId': 'u1',
            'text': '重同步前的用户消息',
            'sourceKind': 'user',
          }),
          _ev('assistant/message', 4, {
            'turn': 1,
            'step': 1,
            'messageId': 'a1',
            'text': '重同步后的回复',
          }),
        ]),
      );
      await _settle(tester);
      expect(find.byKey(_loadingKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      expect(find.textContaining('重同步后的回复'), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  });

  group('#129 failed：可重试 / dead-end', () {
    testWidgets('503 可重试：点重试进入 loading，成功后内容出现', (tester) async {
      final retryCompleter = Completer<http.Response>();
      var calls = 0;
      final backend = _Backend((request) {
        calls++;
        if (calls == 1) {
          return Future.value(
            _json({'ok': false, 'error': 'service-unavailable'}, 503),
          );
        }
        return retryCompleter.future;
      });
      await _pumpChat(tester, backend: backend);
      await _settle(tester);

      expect(find.byKey(_failedKey), findsOneWidget);
      expect(find.text('会话加载失败'), findsOneWidget);
      expect(find.text('服务暂时不可用（503），请稍后重试'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(find.text('返回会话列表'), findsOneWidget);

      await tester.tap(find.text('重试'));
      await tester.pump();
      expect(
        find.byKey(_loadingKey),
        findsOneWidget,
        reason: '重试必须回到 loading，而不是停在旧错误页',
      );

      retryCompleter.complete(_page(_oneMessage('重试成功')));
      await _settle(tester);
      expect(find.byKey(_loadingKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      expect(find.textContaining('重试成功'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('404 / session-not-found 是 dead-end：无重试，只保留返回', (tester) async {
      final backend = _Backend(
        (_) async => _json({'ok': false, 'error': 'session-not-found'}, 404),
      );
      await _pumpChatInRoute(tester, backend: backend);
      await _settle(tester);

      expect(find.byKey(_failedKey), findsOneWidget);
      expect(find.text('会话不存在或已被删除'), findsOneWidget);
      expect(find.text('重试'), findsNothing, reason: '404 重试同一个请求不会成功，不能给假入口');
      expect(find.text('返回会话列表'), findsOneWidget);

      // 不自动 pop：失败态出现后聊天页仍在栈顶。
      expect(find.byType(ChatScreen), findsOneWidget);
      await tester.tap(find.text('返回会话列表'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsNothing);
      expect(find.text('open-chat'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('缺 sessionId：明确失败且不可重试', (tester) async {
      var historyCalls = 0;
      final backend = _Backend((_) async {
        historyCalls++;
        return _page(const []);
      });
      await _pumpChat(tester, backend: backend, sessionId: null);
      await _settle(tester);

      expect(find.byKey(_failedKey), findsOneWidget);
      expect(find.text('缺少会话标识，无法加载会话'), findsOneWidget);
      expect(find.text('重试'), findsNothing);
      expect(find.text('返回会话列表'), findsOneWidget);
      expect(historyCalls, 0, reason: '缺会话标识不应发出 /history 请求');
      expect(tester.takeException(), isNull);
    });
  });

  group('#129 成功后切换与内容', () {
    testWidgets('/history 挂起时首个 SSE 是 live-chunk：流式正文即时可见，不显示 loading', (
      tester,
    ) async {
      final completer = Completer<http.Response>();
      final backend = _Backend((_) => completer.future);
      final store = await _pumpChat(tester, backend: backend);
      expect(find.byKey(_loadingKey), findsOneWidget);

      store.injectFrame({
        'type': 'session/event',
        'sessionId': _session,
        'event': _ev('assistant/live-chunk', 1, {
          'turn': 1,
          'step': 1,
          'text': '流式正文即时可见',
        }),
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        find.byKey(_loadingKey),
        findsNothing,
        reason: 'live-chunk 只有 _draft、没有 item，也必须算“已有实时内容”',
      );
      expect(find.byKey(_emptyKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      expect(find.textContaining('流式正文即时可见'), findsWidgets);

      completer.complete(_page(const []));
      await _settle(tester);
      expect(tester.takeException(), isNull);
    });
    testWidgets('成功加载有内容的会话：退出三态并渲染正文', (tester) async {
      final backend = _Backend((_) async => _page(_oneMessage('加载完成')));
      await _pumpChat(tester, backend: backend);
      await _settle(tester);

      expect(find.byKey(_loadingKey), findsNothing);
      expect(find.byKey(_emptyKey), findsNothing);
      expect(find.byKey(_failedKey), findsNothing);
      expect(find.textContaining('加载完成'), findsWidgets);
      expect(find.text('开始任务'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('空态后收到 live-chunk：空态消失、流式正文出现', (tester) async {
      final backend = _Backend((_) async => _page(const []));
      final store = await _pumpChat(tester, backend: backend);
      await _settle(tester);
      expect(find.byKey(_emptyKey), findsOneWidget);

      store.injectFrame({
        'type': 'session/event',
        'sessionId': _session,
        'event': _ev('assistant/live-chunk', 1, {
          'turn': 1,
          'step': 1,
          'text': '空态后的流式正文',
        }),
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        find.byKey(_emptyKey),
        findsNothing,
        reason: '流式正文是可恢复内容，不能被“还没有消息”空态遮住',
      );
      expect(find.textContaining('空态后的流式正文'), findsWidgets);
      expect(find.byKey(_failedKey), findsNothing);
      expect(tester.takeException(), isNull);
      // 注入帧的 800ms 会话列表去抖 Timer 必须推进结束，避免 pending timer。
      await tester.pump(const Duration(seconds: 1));
    });

    testWidgets('SSE 先到：即使 /history 仍挂起也不显示 loading', (tester) async {
      final completer = Completer<http.Response>();
      final backend = _Backend((_) => completer.future);
      final store = await _pumpChat(tester, backend: backend);
      expect(find.byKey(_loadingKey), findsOneWidget);

      store.injectFrame({
        'type': 'session/event',
        'sessionId': _session,
        'event': _ev('assistant/message', 1, {
          'turn': 1,
          'step': 1,
          'messageId': 'a-sse',
          'text': '先到的内容',
        }),
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(
        find.byKey(_loadingKey),
        findsNothing,
        reason: '已有 SSE 内容时不得整页闪成 loading',
      );
      expect(find.byKey(_failedKey), findsNothing);
      expect(find.textContaining('先到的内容'), findsWidgets);

      completer.complete(_page(const []));
      await _settle(tester);
      expect(tester.takeException(), isNull);
    });
  });

  group('#129 首屏落底与适配', () {
    testWidgets('长会话：首屏加载后停在底部（内容挂载后帧后强制定位）', (tester) async {
      final backend = _Backend((_) async => _page(_longHistory()));
      await _pumpChat(tester, backend: backend);
      // review P2：不用 pumpAndSettle 掩盖三态切换——固定推进帧，让 loading→内容态、
      // 帧后强制定位与动画都真实发生。
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byKey(_loadingKey), findsNothing);

      final probe = _Probe(tester);
      final position = probe.position;
      expect(position.maxScrollExtent, greaterThan(300));
      expect(
        (position.pixels - position.maxScrollExtent).abs(),
        lessThanOrEqualTo(1.0),
        reason:
            '长会话首屏必须落底（pixels=${position.pixels}, max=${position.maxScrollExtent}）',
      );
      expect(find.textContaining('第 40 轮回答'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('320dp / 深色 / 1.5x：empty 与 failed 均不溢出', (tester) async {
      await _pumpChat(
        tester,
        backend: _Backend((_) async => _page(const [])),
        size: const Size(320, 640),
        textScaler: const TextScaler.linear(1.5),
        theme: DshTheme.dark(),
        tag: 'empty',
      );
      await _settle(tester);
      expect(find.byKey(_emptyKey), findsOneWidget);
      expect(tester.takeException(), isNull);

      await _pumpChat(
        tester,
        backend: _Backend(
          (_) async => _json({
            'ok': false,
            'detail':
                'connection reset by peer while reading the session history '
                'from the remote host; please check the network and retry.',
          }, 500),
        ),
        size: const Size(320, 640),
        textScaler: const TextScaler.linear(1.5),
        theme: DshTheme.dark(),
        tag: 'failed',
      );
      await _settle(tester);
      expect(find.byKey(_failedKey), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('英文语言下列文案走 L10n', (tester) async {
      L10n.lang = 'en';
      await _pumpChat(tester, backend: _Backend((_) async => _page(const [])));
      await _settle(tester);
      expect(find.text('No messages in this session yet'), findsOneWidget);
      expect(
        find.text('Send the first message from the input box below'),
        findsOneWidget,
      );
    });
  });
}
