// issue #90：斜杠菜单（命令+技能）+ 用户消息内联高亮。
//
// 覆盖：leading 命令+技能分组、inline 仅技能、空 query/过滤/无匹配、点选只插入、
// 技能提交走普通消息（命令同名优先）、未知命令保持 toast、用户气泡双高亮（不可点）。

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-90';

const _commands = [
  {'name': 'compact', 'description': 'Compact conversation history'},
  {'name': 'plan', 'description': 'Plan a task', 'input': {'hint': '<goal>'}},
];
const _skills = [
  {'name': 'grill-me', 'description': 'Grill a plan', 'modelInvocable': true},
  {'name': 'manual', 'description': 'Manual only skill', 'modelInvocable': false},
  // 与命令同名：菜单/提交/高亮都必须命令优先。
  {'name': 'compact', 'description': 'skill duplicate', 'modelInvocable': true},
];

class _Backend {
  _Backend({
    this.events = const [],
    this.skillsUnavailable = false,
    this.skillsFailFirst = false,
    this.catalogGate,
  });
  final List<Map<String, dynamic>> events;
  final bool skillsUnavailable;
  final bool skillsFailFirst;
  final Completer<void>? catalogGate;
  final List<Map<String, dynamic>> sends = [];
  int commandRuns = 0;
  int skillRequests = 0;
  int _skillFailures = 0;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue90.test'
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
    final path = request.url.path;
    Map<String, dynamic> body;
    http.Response reply(Map<String, dynamic> value) => http.Response(
          jsonEncode(value),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
    if (path == '/m/api/history') {
      body = {'ok': true, 'events': events, 'hasMore': false};
      return reply(body);
    }
    if (path == '/m/api/commands') {
      if (request.method == 'POST') {
        commandRuns += 1;
        return reply({'ok': true, 'messageId': 'cmd-1'});
      }
      await catalogGate?.future;
      return reply({'ok': true, 'commands': _commands});
    }
    if (path == '/m/api/skills') {
      skillRequests += 1;
      if (skillsFailFirst && _skillFailures++ == 0) {
        return http.Response('boom', 500);
      }
      await catalogGate?.future;
      if (skillsUnavailable) {
        return reply({'ok': true, 'skills': <Object>[], 'unavailable': true});
      }
      return reply({'ok': true, 'skills': _skills});
    }
    if (path == '/m/api/send') {
      sends.add(jsonDecode(request.body) as Map<String, dynamic>);
      return reply({'ok': true, 'messageId': 'sent-1'});
    }
    if (path == '/m/api/queue') return reply({'ok': true, 'rows': <Object>[]});
    if (path == '/m/api/todos') return reply({'ok': true, 'todos': <Object>[]});
    if (path == '/m/api/session-config') {
      return reply({'ok': true, 'config': <String, dynamic>{}});
    }
    return reply({'ok': true});
  }
}

Map<String, dynamic> _event(String type, int seq, Map<String, dynamic> data) => {
      'seq': seq,
      'type': type,
      'data': data,
    };

Future<AppStore> _pumpChat(
  WidgetTester tester,
  _Backend backend, {
  bool dark = false,
}) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)];
  await tester.pumpWidget(MaterialApp(
    theme: dark ? ThemeData.dark() : null,
    home: ChatScreen(
      store: store,
      apiClient: backend.api,
      onTitleChanged: () {},
    ),
  ));
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pump(const Duration(milliseconds: 150));
  await tester.pump(const Duration(milliseconds: 150));
  return store;
}

Finder get _input => find.byType(TextField).first;

Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(_input, text);
  await tester.pump(const Duration(milliseconds: 150));
}

void main() {
  setUp(() => L10n.lang = 'en');

  testWidgets('leading /：命令组前、技能组后；过滤/空态；点选只插入不发送', (tester) async {
    final backend = _Backend();
    await _pumpChat(tester, backend);
    await _type(tester, '/');
    expect(find.byKey(const Key('slash-menu')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-command-compact')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-command-plan')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-skill-grill-me')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-skill-manual')), findsOneWidget);
    expect(find.text('manual only'), findsOneWidget, reason: '技能 userOnly 标记');
    // 同名技能不重复（命令优先）。
    expect(find.byKey(const Key('slash-menu-skill-compact')), findsNothing);
    // 分组顺序：命令标题在技能标题之前。
    final commandHeader = tester.getTopLeft(find.text('Commands')).dy;
    final skillHeader = tester.getTopLeft(find.text('Skills')).dy;
    expect(commandHeader, lessThan(skillHeader));

    await _type(tester, '/gr');
    expect(find.byKey(const Key('slash-menu-skill-grill-me')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-command-compact')), findsNothing);
    await _type(tester, '/zzz');
    expect(find.byKey(const Key('slash-menu-empty')), findsOneWidget);
    expect(find.text('No matching commands or skills'), findsOneWidget);

    await _type(tester, '/gr');
    await tester.tap(find.byKey(const Key('slash-menu-skill-grill-me')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.widget<TextField>(_input).controller!.text, '/grill-me ');
    expect(backend.sends, isEmpty, reason: '点选只填入，不自动发送');
    expect(backend.commandRuns, 0, reason: '点选也不执行命令');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('行内 / 只显示技能；@/词内/URL 不弹菜单', (tester) async {
    await _pumpChat(tester, _Backend());
    await _type(tester, 'hello /');
    expect(find.byKey(const Key('slash-menu')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-skill-grill-me')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-command-compact')), findsNothing);

    await _type(tester, 'x/name');
    expect(find.byKey(const Key('slash-menu')), findsNothing);
    await _type(tester, 'https:/example');
    expect(find.byKey(const Key('slash-menu')), findsNothing);
    await _type(tester, '//double');
    expect(find.byKey(const Key('slash-menu')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('提交：技能按普通消息发送（同名命令优先）；未知命令保持 toast', (tester) async {
    final backend = _Backend();
    await _pumpChat(tester, backend);
    await _type(tester, '/grill-me');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.commandRuns, 0, reason: '技能不得走 commands.execute');
    expect(backend.sends.single['text'], '/grill-me');

    await _type(tester, '/compact');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.commandRuns, 1, reason: '同名技能存在时命令优先仍执行命令');
    expect(backend.sends, hasLength(1));

    await _type(tester, '/unknown-skill');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.commandRuns, 1, reason: '未知命令不执行');
    expect(backend.sends, hasLength(2), reason: '未知命令照常作为普通消息发送');
    // 未知命令 toast 的既有行为由 issue25_command_send_test 覆盖；此处验证不执行、照常发送。
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('用户气泡高亮：命令/技能不同 chip、不可点、未知/路径普通文本', (tester) async {
    final backend = _Backend(events: [
      _event('turn/start', 1, {'turn': 1}),
      _event('user/message', 2, {
        'messageId': 'u1',
        'text': '/compact /grill-me /unknown /tmp/foo x/name https:/x',
        'sourceKind': 'user',
      }),
      _event('assistant/message', 3, {
        'turn': 1,
        'messageId': 'a1',
        'text': '收到',
      }),
    ]);
    await _pumpChat(tester, backend);
    expect(find.byKey(const Key('slash-chip-command-compact')), findsOneWidget);
    expect(find.byKey(const Key('slash-chip-skill-grill-me')), findsOneWidget);
    expect(find.byKey(const Key('slash-chip-command-unknown')), findsNothing);
    expect(find.byKey(const Key('slash-chip-skill-unknown')), findsNothing);
    // chip 不可点：内部不得有 InkWell/GestureDetector。
    expect(
      find.descendant(
        of: find.byKey(const Key('slash-chip-command-compact')),
        matching: find.byType(InkWell),
      ),
      findsNothing,
    );
    // 原始文本仍在（未知/路径不 chip，但复制文本不变）。
    expect(find.textContaining('/unknown'), findsWidgets);
    // 复制入口仍复制原始 item.text（不是 chip 文本/占位）。
    String? copied;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });
    await tester.tap(find.byIcon(Icons.content_copy).last);
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      copied,
      '/compact /grill-me /unknown /tmp/foo x/name https:/x',
      reason: '复制必须使用原始文本，不把 chip 当交互',
    );
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('技能目录 unavailable：只显示命令（静默）；高亮只命令', (tester) async {
    final backend = _Backend(
      skillsUnavailable: true,
      events: [
        _event('turn/start', 1, {'turn': 1}),
        _event('user/message', 2, {
          'messageId': 'u1',
          'text': '/compact /grill-me',
          'sourceKind': 'user',
        }),
      ],
    );
    await _pumpChat(tester, backend);
    await _type(tester, '/');
    expect(find.byKey(const Key('slash-menu-command-compact')), findsOneWidget);
    expect(find.byKey(const Key('slash-menu-skill-grill-me')), findsNothing);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('slash-chip-command-compact')), findsOneWidget);
    expect(find.byKey(const Key('slash-chip-skill-grill-me')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('技能目录首次失败不缓存永久空：再次输入重试并出现技能', (tester) async {
    final backend = _Backend(skillsFailFirst: true);
    await _pumpChat(tester, backend);
    await _type(tester, '/');
    expect(find.byKey(const Key('slash-menu-command-compact')), findsOneWidget);
    final firstRequests = backend.skillRequests;
    await _type(tester, '/gr');
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.skillRequests, greaterThanOrEqualTo(firstRequests), reason: '失败后可重试');
    expect(backend.skillRequests, greaterThanOrEqualTo(2), reason: '首次失败不得缓存为永久空');
    expect(find.byKey(const Key('slash-menu-skill-grill-me')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('目录未加载：先普通文本，加载完成后重建高亮', (tester) async {
    final gate = Completer<void>();
    final backend = _Backend(
      catalogGate: gate,
      events: [
        _event('turn/start', 1, {'turn': 1}),
        _event('user/message', 2, {
          'messageId': 'u1',
          'text': '/compact',
          'sourceKind': 'user',
        }),
      ],
    );
    await _pumpChat(tester, backend);
    expect(find.byKey(const Key('slash-chip-command-compact')), findsNothing);
    gate.complete();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('slash-chip-command-compact')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('320 + 深色：菜单不溢出、点击区 ≥44dp、可滚动', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final backend = _Backend();
    await _pumpChat(tester, backend, dark: true);
    await _type(tester, '/');
    expect(find.byKey(const Key('slash-menu')), findsOneWidget);
    expect(tester.takeException(), isNull, reason: '320 深色不得 overflow');
    final item = tester.getSize(find.byKey(const Key('slash-menu-command-compact')));
    expect(item.height, greaterThanOrEqualTo(44));
    expect(find.byType(Scrollable), findsWidgets);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('行内技能不走命令/不特殊执行：作为普通消息文本发送', (tester) async {
    final backend = _Backend();
    await _pumpChat(tester, backend);
    await _type(tester, 'hello /grill-me');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.commandRuns, 0);
    expect(backend.sends.single['text'], 'hello /grill-me');
    await tester.pumpWidget(const SizedBox());
  });

}
