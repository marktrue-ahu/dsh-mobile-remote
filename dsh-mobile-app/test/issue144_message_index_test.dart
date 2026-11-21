// issue #144：「代理 → 消息」当前会话消息索引（页签 UI + 面板接线）。
//
// 覆盖：默认全部筛选、分类筛选、空态/查看全部、加载/失败重试、旧宿主降级、
// queued/delivered 状态、日期分隔、行几何/命中区、Semantics、点按关闭面板并回调跳转、
// 320/深色/1.5× 不溢出。
import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/message_index.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/agent_panel.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:dsh_mobile_app/widgets/message_index_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Map<String, dynamic> body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Api _api() =>
    Api(
        client: MockClient((request) async {
          if (request.url.path == '/m/api/subagents') {
            return _json({'ok': true, 'subagents': <Object>[]});
          }
          return _json({'ok': true});
        }),
      )
      ..baseUrl = 'http://issue144.test'
      ..path = '/m'
      ..token = '';

MessageIndexEntry _entry(
  int seq,
  MessageIndexCategory category,
  String sender,
  String target,
  String text, {
  DateTime? time,
  String? messageId,
  MessageDeliveryStatus? delivery,
  bool visible = true,
}) => MessageIndexEntry(
  seq: seq,
  category: category,
  sender: sender,
  target: target,
  text: text,
  time: time,
  messageId: messageId,
  deliveryStatus: delivery,
  visibleInTimeline: visible,
);

MessageIndexSnapshot _snapshot({
  List<MessageIndexEntry>? entries,
  bool hasEarlierHistory = false,
}) => MessageIndexSnapshot(
  entries: entries ?? _defaultEntries(),
  hasEarlierHistory: hasEarlierHistory,
);

List<MessageIndexEntry> _defaultEntries() {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day, 14, 32);
  final yesterday = DateTime(now.year, now.month, now.day - 1, 14, 30);
  return [
    _entry(
      6,
      MessageIndexCategory.team,
      '发布协调员',
      '前端审计',
      '插件清单的第二列改成来源渠道，别放安装源地址。',
      time: today,
      messageId: 'tm-1',
      delivery: MessageDeliveryStatus.delivered,
    ),
    _entry(
      5,
      MessageIndexCategory.agent,
      '前端审计',
      '发布协调员',
      '收到，正在补 320 宽的截图。',
      time: today,
      delivery: MessageDeliveryStatus.delivered,
    ),
    _entry(
      4,
      MessageIndexCategory.conversation,
      '你',
      '主代理',
      '先按只读范围实现，别开编辑入口。',
      time: today,
    ),
    _entry(
      3,
      MessageIndexCategory.conversation,
      '主代理',
      '你',
      '明白，任务板只保留展开详情，不显示说明字段。',
      time: yesterday,
    ),
    _entry(
      2,
      MessageIndexCategory.team,
      '发布协调员',
      '回归测试',
      '下载断点恢复的场景补一条，放在明天回归里。',
      time: yesterday,
      messageId: 'tm-2',
      delivery: MessageDeliveryStatus.queued,
    ),
  ];
}

Future<void> _pumpTab(
  WidgetTester tester, {
  required MessageIndexLoader? loader,
  MessageOpenHandler? onOpenMessage,
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQueryData(size: size, textScaler: textScaler),
          child: Scaffold(
            body: MessageIndexTab(loader: loader, onOpenMessage: onOpenMessage),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Finder _row(int seq) => find.byKey(ValueKey<String>('message-index-row:$seq'));

void main() {
  setUp(() => L10n.lang = 'zh');
  tearDown(() => L10n.lang = 'zh');

  testWidgets('默认全部：消息行、分类/发送方/时间/投递状态、日期分隔与 Semantics', (tester) async {
    final handle = tester.ensureSemantics();
    await _pumpTab(tester, loader: () async => _snapshot());

    expect(_row(6), findsOneWidget);
    expect(_row(5), findsOneWidget);
    expect(_row(4), findsOneWidget);
    expect(_row(3), findsOneWidget);
    expect(_row(2), findsOneWidget);
    expect(find.textContaining('团队 · 发布协调员 → 前端审计'), findsOneWidget);
    expect(find.text('已投递'), findsNWidgets(2));
    expect(find.text('已排队'), findsOneWidget);
    expect(find.text('今天'), findsOneWidget);
    expect(find.text('昨天'), findsOneWidget);

    // 行高 ≥64、筛选 chip 命中区 44；Semantics 同时承载发送方→接收方、时间、状态与跳转动作。
    expect(tester.getSize(_row(6)).height, greaterThanOrEqualTo(64));
    expect(
      tester
          .getSize(find.byKey(const ValueKey<String>('message-filter-all')))
          .height,
      greaterThanOrEqualTo(44),
    );
    final semantics = tester.getSemantics(_row(6));
    expect(semantics.label, contains('团队'));
    expect(semantics.label, contains('发布协调员 → 前端审计'));
    expect(semantics.label, contains('已投递'));
    expect(semantics.label, contains('跳转到对话'));
    handle.dispose();
  });

  testWidgets('筛选：全部/对话/团队/代理即时过滤；筛选为空有「查看全部」重置', (tester) async {
    var snapshot = _snapshot(
      entries: [
        _entry(3, MessageIndexCategory.conversation, '你', '主代理', '对话一'),
        _entry(
          2,
          MessageIndexCategory.team,
          '发布协调员',
          '前端审计',
          '团队一',
          delivery: MessageDeliveryStatus.delivered,
        ),
      ],
    );
    await _pumpTab(tester, loader: () async => snapshot);

    await tester.tap(find.byKey(const ValueKey<String>('message-filter-team')));
    await tester.pump();
    expect(_row(2), findsOneWidget);
    expect(_row(3), findsNothing);

    await tester.tap(
      find.byKey(const ValueKey<String>('message-filter-conversation')),
    );
    await tester.pump();
    expect(_row(3), findsOneWidget);
    expect(_row(2), findsNothing);

    // 代理分类无数据 → 空态 + 查看全部重置。
    await tester.tap(
      find.byKey(const ValueKey<String>('message-filter-agent')),
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('message-index-empty-filter')),
      findsOneWidget,
    );
    await tester.tap(
      find.byKey(const ValueKey<String>('message-index-show-all')),
    );
    await tester.pump();
    expect(_row(2), findsOneWidget);
    expect(_row(3), findsOneWidget);
  });

  testWidgets('加载中：loader 未完成时显示居中 spinner', (tester) async {
    final completer = Completer<MessageIndexSnapshot>();
    await _pumpTab(tester, loader: () => completer.future);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    completer.complete(_snapshot());
    await tester.pump();
    expect(_row(6), findsOneWidget);
  });

  testWidgets('失败：行内错误 + 重试成功后恢复列表', (tester) async {
    var fail = true;
    await _pumpTab(
      tester,
      loader: () async {
        if (fail) throw Exception('boom');
        return _snapshot();
      },
    );
    await tester.pump();
    expect(find.text('消息索引读取失败'), findsOneWidget);
    fail = false;
    await tester.tap(find.byKey(const ValueKey<String>('message-index-retry')));
    await tester.pump();
    await tester.pump();
    expect(_row(6), findsOneWidget);
  });

  testWidgets('旧宿主降级：loader=null 只显示说明，不渲染假消息', (tester) async {
    await _pumpTab(tester, loader: null);
    expect(
      find.byKey(const ValueKey<String>('message-index-unsupported')),
      findsOneWidget,
    );
    expect(_row(6), findsNothing);
  });

  testWidgets('降级脚注：hasEarlierHistory 时显示「仅索引已加载消息」', (tester) async {
    await _pumpTab(
      tester,
      loader: () async => _snapshot(hasEarlierHistory: true),
    );
    expect(
      find.byKey(const ValueKey<String>('message-index-degraded')),
      findsOneWidget,
    );
  });

  testWidgets('无更早历史时：不显示降级脚注', (tester) async {
    await _pumpTab(tester, loader: () async => _snapshot());
    expect(
      find.byKey(const ValueKey<String>('message-index-degraded')),
      findsNothing,
    );
  });

  testWidgets('无可跳转目标：行禁用、显示「仅日志」并给出准确 Semantics 原因', (tester) async {
    final handle = tester.ensureSemantics();
    var opened = <int>[];
    await _pumpTab(
      tester,
      loader: () async => _snapshot(
        entries: [
          _entry(
            9,
            MessageIndexCategory.team,
            '发布协调员',
            '前端审计',
            '这条消息只在团队日志里，普通对话没有可见行。',
            delivery: MessageDeliveryStatus.queued,
            visible: false,
          ),
        ],
      ),
      onOpenMessage: (seq) async => opened.add(seq),
    );

    expect(_row(9), findsOneWidget);
    expect(find.textContaining('仅日志'), findsOneWidget);
    final rowInk = tester.widget<InkWell>(_row(9));
    expect(rowInk.onTap, isNull, reason: '无可见目标时不得假装可跳转');
    final semantics = tester.getSemantics(_row(9));
    expect(semantics.label, contains('无法跳转'));
    expect(semantics.flagsCollection.isButton, isFalse);

    await tester.tap(_row(9), warnIfMissed: false);
    await tester.pump();
    expect(opened, isEmpty);
    expect(tester.takeException(), isNull);
    handle.dispose();
  });

  testWidgets('320 / 深色 / 1.5×：不溢出、状态与时间列仍可读', (tester) async {
    await _pumpTab(
      tester,
      loader: () async => _snapshot(),
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );
    expect(tester.takeException(), isNull);
    expect(_row(6), findsOneWidget);
    expect(find.text('已投递'), findsNWidgets(2));
    expect(tester.getSize(_row(6)).height, greaterThanOrEqualTo(64));
    expect(tester.takeException(), isNull);
  });

  testWidgets('长正文最多 2 行省略，不渲染 Markdown', (tester) async {
    final long = '**加粗** ${'x' * 400}';
    await _pumpTab(
      tester,
      loader: () async => _snapshot(
        entries: [
          _entry(1, MessageIndexCategory.conversation, '你', '主代理', long),
        ],
      ),
    );
    final text = tester.widget<Text>(find.text(long));
    expect(text.maxLines, 2);
    expect(text.overflow, TextOverflow.ellipsis);
    expect(find.textContaining('**', findRichText: true), findsOneWidget);
  });

  testWidgets('点按消息行：先关闭代理面板，再回调 seq 跳转', (tester) async {
    final opened = <int>[];
    final store = AppStore(apiClient: _api())
      ..sessionId = 'session-144'
      ..sessions = [
        Session(id: 'session-144', title: 'S', cwd: null, createdAt: 1),
      ];
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: DshTheme.light(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                key: const ValueKey<String>('open-panel'),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => AgentPanelScreen(
                      store: store,
                      sessionId: 'session-144',
                      title: 'S',
                      apiClient: _api(),
                      messageIndexLoader: () async => _snapshot(),
                      onOpenMessage: (seq) async => opened.add(seq),
                    ),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey<String>('open-panel')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('agent-tab-messages')));
    await tester.pumpAndSettle();

    expect(_row(6), findsOneWidget);
    await tester.tap(_row(6));
    await tester.pumpAndSettle();

    expect(opened, [6], reason: '面板关闭后必须把 seq 交给聊天页定位');
    expect(find.byType(AgentPanelScreen), findsNothing, reason: '点按后关闭面板');
  });
}
