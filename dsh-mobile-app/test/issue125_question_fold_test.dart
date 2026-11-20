// issue #125（实现跟踪 #149）：提问卡支持折叠。
//
// 验收口径（UI 设计 §6 + #125 note 3469/3470）：
//   1. 默认展开；头部折叠控件 44dp；折叠态固定结构（标题 + 第一问摘要 + 待回答 + 展开 + 取消），
//      不显示提交/跳过/选项/输入框；
//   2. 状态语义：展开 ⌄（keyboard_arrow_down）+ Semantics「已展开，点按收起」（expanded=true）；
//      折叠 ⌃（keyboard_arrow_up）+ Semantics「已收起，点按展开」（expanded=false）；不用 ›；
//   3. 折叠/展开不丢已选与自定义输入；折叠收键盘；展开不自动聚焦；
//   4. 提交中折叠与关闭都禁用；取消仍可用；
//   5. 新 rpcId 默认展开；弹层变体（#120）不显示折叠控件；
//   6. 320/深色/1.5× 不溢出、命中区 ≥44。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue125_question_fold_test.dart

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-125';
const _rpc = 'session-125:q1';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 历史：用户消息 + 一次 ask_user_question 工具调用（工具行入口用于 #120 弹层变体）。
List<Map<String, dynamic>> _askHistory() => [
  {
    'seq': 1,
    'type': 'turn/start',
    'data': {'turn': 1},
    'time': 1000,
  },
  {
    'seq': 2,
    'type': 'user/message',
    'data': {'messageId': 'u1', 'text': '发布前先确认一下', 'sourceKind': 'user'},
    'time': 1010,
  },
  {
    'seq': 3,
    'type': 'tool/call',
    'data': {
      'turn': 1,
      'step': 1,
      'callId': 'call-ask',
      'name': 'ask_user_question',
      'arguments': '{"questions":[{"id":"q1","question":"要发布吗？"}]}',
      'summary': {
        'kind': 'question',
        'tool': 'ask_user_question',
        'questions': [
          {
            'id': 'q1',
            'header': '确认',
            'question': '要发布吗？',
            'options': [
              {'label': '发布'},
              {'label': '稍后'},
            ],
          },
        ],
      },
    },
    'time': 1020,
  },
];

/// 长历史：用于验证折叠/展开时「跟随底部保持贴底、阅读历史不抢滚动」。
List<Map<String, dynamic>> _longHistory() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  for (var turn = 1; turn <= 16; turn++) {
    events.add({
      'seq': seq++,
      'type': 'turn/start',
      'data': {'turn': turn},
      'time': 1000 + seq * 10,
    });
    events.add({
      'seq': seq++,
      'type': 'user/message',
      'data': {
        'messageId': 'u$turn',
        'text': '第 $turn 轮：这是一段用来撑高消息区的用户消息。',
        'sourceKind': 'user',
      },
      'time': 1000 + seq * 10,
    });
    events.add({
      'seq': seq++,
      'type': 'assistant/message',
      'data': {
        'turn': turn,
        'step': 1,
        'messageId': 'a$turn',
        'text': '第 $turn 轮回答：这是用来验证底部跟随的长回答内容。',
      },
      'time': 1000 + seq * 10,
    });
    events.add({
      'seq': seq++,
      'type': 'turn/end',
      'data': {'turn': turn},
      'time': 1000 + seq * 10,
    });
  }
  return events;
}

class _Backend {
  _Backend({this.respondGate, List<Map<String, dynamic>>? history})
    : history = history ?? _askHistory();

  /// 非 null 时 /api/respond 会一直挂起，用于验证「提交中」禁用态。
  Completer<void>? respondGate;

  final List<Map<String, dynamic>> history;

  final List<Map<String, dynamic>> respondBodies = [];

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue125.test'
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
    ..toolCardsCapabilities = const ToolCardsCapabilities(
      version: 1,
      tools: {'ask_user_question'},
    );

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/history') {
      return _json({'ok': true, 'events': history, 'hasMore': false});
    }
    if (path == '/m/api/event-detail') {
      return _json({'ok': true, 'event': null});
    }
    if (path == '/m/api/respond') {
      respondBodies.add(jsonDecode(request.body) as Map<String, dynamic>);
      final gate = respondGate;
      if (gate != null) await gate.future;
      return _json({'ok': true, 'accepted': true});
    }
    return _json({'ok': true});
  }

  Map<String, dynamic> get lastRespond => respondBodies.last;
}

Future<AppStore> _pumpChat(
  WidgetTester tester, {
  required _Backend backend,
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
  String tag = '',
}) async {
  final store = AppStore(apiClient: backend.api)
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)]
    // 与 issue120 夹具一致：standard 模式下未完成工具调用会持续调度帧，pumpAndSettle 会超时。
    ..stepDisplayMode = WorkStepDisplayMode.expanded;
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
            key: ValueKey<String>('issue125-$tag'),
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

/// 真实 SSE `mobile/frame` 形状：`{type:'mobile/frame', frame:{type:'question/requested', ...}}`。
void _injectQuestion(
  AppStore store, {
  String rpcId = _rpc,
  String header = '确认',
  String question = '要发布吗？',
  List<Map<String, dynamic>>? questions,
}) {
  store.injectFrame({
    'type': 'mobile/frame',
    'frame': {
      'type': 'question/requested',
      'rpcId': rpcId,
      'sessionId': _session,
      'questionId': rpcId,
      'questions':
          questions ??
          [
            {
              'id': 'q1',
              'header': header,
              'question': question,
              'options': [
                {'label': '发布'},
                {'label': '稍后'},
              ],
            },
          ],
    },
  });
}

Finder _card([String rpcId = _rpc]) => find.byKey(ValueKey<String>(rpcId));

Finder _fold([String rpcId = _rpc]) =>
    find.byKey(ValueKey<String>('question-fold:$rpcId'));

Finder _close([String rpcId = _rpc]) =>
    find.byKey(ValueKey<String>('question-close:$rpcId'));

Finder _summary([String rpcId = _rpc]) =>
    find.byKey(ValueKey<String>('question-fold-summary:$rpcId'));

Finder _insideCard(Finder matching, [String rpcId = _rpc]) =>
    find.descendant(of: _card(rpcId), matching: matching);

Future<void> _settleAnimations(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 200));
}

Future<void> _collapse(WidgetTester tester, [String rpcId = _rpc]) async {
  await tester.tap(_fold(rpcId));
  await _settleAnimations(tester);
}

Future<void> _expand(WidgetTester tester, [String rpcId = _rpc]) async {
  await tester.tap(_fold(rpcId));
  await _settleAnimations(tester);
}

void main() {
  tearDown(() {
    L10n.lang = 'zh';
  });

  testWidgets('默认展开：选项/输入/提交都在；头部折叠控件 44dp；状态箭头 ⌄ + Semantics expanded', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store);
    await tester.pump();

    expect(_card(), findsOneWidget);
    expect(_summary(), findsNothing, reason: '默认展开，不显示折叠摘要');
    expect(_insideCard(find.byType(TextField)), findsOneWidget);
    expect(
      _insideCard(find.widgetWithText(FilledButton, '提交')),
      findsOneWidget,
    );
    expect(_insideCard(find.text('待回答')), findsOneWidget);
    expect(_insideCard(find.byIcon(Icons.keyboard_arrow_down)), findsOneWidget);
    expect(_insideCard(find.byIcon(Icons.keyboard_arrow_up)), findsNothing);
    expect(
      _insideCard(find.byIcon(Icons.chevron_right)),
      findsNothing,
      reason: '不得使用 ›（chevron_right）表示折叠',
    );

    // 折叠控件 ≥44dp；关闭 44×44。
    expect(tester.getSize(_fold()).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(_close()), const Size(44, 44));

    final foldSemantics = tester.getSemantics(_fold());
    expect(foldSemantics.label, contains('已展开，点按收起'));
    expect(foldSemantics.flagsCollection.isButton, isTrue);
    expect(foldSemantics.flagsCollection.isExpanded.toBoolOrNull(), isTrue);
    handle.dispose();
  });

  testWidgets('折叠：固定摘要 + 待回答 + 展开 + 取消；无选项/输入/提交；⌃ + Semantics collapsed', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store);
    await tester.pump();

    final expandedHeight = tester.getSize(_card()).height;
    await _collapse(tester);

    expect(_summary(), findsOneWidget);
    expect(tester.widget<Text>(_summary()).data, '要发布吗？');
    expect(tester.widget<Text>(_summary()).maxLines, 1);
    expect(_insideCard(find.text('待回答')), findsOneWidget);
    expect(_insideCard(find.byType(TextField)), findsNothing);
    expect(_insideCard(find.byType(FilledButton)), findsNothing);
    expect(_insideCard(find.text('提交')), findsNothing);
    expect(_insideCard(find.text('跳过')), findsNothing);
    expect(_insideCard(find.byIcon(Icons.keyboard_arrow_up)), findsOneWidget);
    expect(_insideCard(find.byIcon(Icons.keyboard_arrow_down)), findsNothing);
    expect(
      _insideCard(find.byIcon(Icons.chevron_right)),
      findsNothing,
      reason: '不得使用 ›（chevron_right）表示折叠',
    );

    final collapsedHeight = tester.getSize(_card()).height;
    expect(collapsedHeight, lessThan(expandedHeight), reason: '折叠应显著增加对话可视区');
    // 设计目标 ≈88–92dp（含 6dp 底部 margin）；留 1.5×/字体差异余量，只锁“矮而稳定”。
    expect(collapsedHeight, greaterThanOrEqualTo(80));
    expect(collapsedHeight, lessThanOrEqualTo(110));

    final foldSemantics = tester.getSemantics(_fold());
    expect(foldSemantics.label, contains('已收起，点按展开'));
    expect(foldSemantics.flagsCollection.isExpanded.toBoolOrNull(), isFalse);

    // 取消入口仍在折叠态。
    expect(_close(), findsOneWidget);
    handle.dispose();
  });

  testWidgets('折叠态高度不随题干长度变化；新 rpcId 默认展开且不继承折叠态', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store, question: '短问题？');
    await tester.pump();
    await _collapse(tester);
    final shortCollapsed = tester.getSize(_card()).height;

    _injectQuestion(
      store,
      rpcId: 'session-125:q2',
      header: '确认长标题',
      question: '这是一个很长很长的问题，用来验证折叠摘要始终只占一行、卡片高度不随题干长度变化，同时不丢已选项。',
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 新 rpcId：默认展开。
    expect(_card('session-125:q2'), findsOneWidget);
    expect(_summary('session-125:q2'), findsNothing);
    expect(
      _insideCard(find.byIcon(Icons.keyboard_arrow_down), 'session-125:q2'),
      findsOneWidget,
      reason: '新问询必须默认展开',
    );

    await _collapse(tester, 'session-125:q2');
    final longCollapsed = tester.getSize(_card('session-125:q2')).height;
    expect(
      longCollapsed,
      moreOrLessEquals(shortCollapsed, epsilon: 0.5),
      reason: '折叠态高度不得随题干长度变化',
    );
    expect(
      tester.widget<Text>(_summary('session-125:q2')).overflow,
      TextOverflow.ellipsis,
    );
  });

  testWidgets('折叠/展开不丢已选与自定义输入；展开不自动聚焦；提交内容不变', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(
      store,
      questions: [
        {
          'id': 'q1',
          'header': '确认',
          'question': '要发布吗？',
          'options': [
            {'label': '发布'},
            {'label': '稍后'},
          ],
        },
        {
          'id': 'q2',
          'header': '补充',
          'question': '还有什么要补充的？',
          'multiSelect': true,
          'options': [
            {'label': '保留'},
          ],
        },
      ],
    );
    await tester.pump();

    await tester.tap(_insideCard(find.text('发布')));
    await tester.pump();
    expect(
      _insideCard(find.byIcon(Icons.radio_button_checked)),
      findsOneWidget,
      reason: '单选应已选中',
    );

    final fields = _insideCard(find.byType(TextField));
    await tester.enterText(fields.at(1), '自定义说明');
    await tester.pump();
    // 输入框获得焦点 → 折叠必须把焦点从输入框移走（收键盘）。
    final focusedBefore = FocusManager.instance.primaryFocus;
    expect(focusedBefore, isNotNull);
    expect(focusedBefore!.hasFocus, isTrue);

    await _collapse(tester);
    expect(focusedBefore.hasFocus, isFalse, reason: '折叠时应收起键盘（unfocus）');
    await _expand(tester);
    expect(focusedBefore.hasFocus, isFalse, reason: '展开不得自动聚焦输入框');

    // 已选与自定义输入都还在（折叠只切展示，不重建内容 State）。
    expect(
      _insideCard(find.byIcon(Icons.radio_button_checked)),
      findsOneWidget,
    );
    final reopened = _insideCard(find.byType(TextField)).at(1);
    expect(tester.widget<TextField>(reopened).controller!.text, '自定义说明');

    await tester.tap(_insideCard(find.widgetWithText(FilledButton, '提交')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final body = backend.lastRespond;
    expect(body['kind'], 'question');
    expect(body['rpcId'], _rpc);
    final answers = (body['answers'] as List).cast<Map<String, dynamic>>();
    expect(answers[0]['selected'], ['发布']);
    expect(answers[1]['custom'], '自定义说明');
    expect(_card(), findsNothing, reason: '提交成功后卡片收起');
  });

  testWidgets('折叠态点关闭 = 取消问询；取消请求仍按原协议发出', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store);
    await tester.pump();
    await _collapse(tester);

    expect(_insideCard(find.byType(FilledButton)), findsNothing);
    await tester.tap(_close());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(backend.lastRespond['kind'], 'cancel');
    expect(backend.lastRespond['rpcId'], _rpc);
    expect(_card(), findsNothing, reason: '取消后乐观收起卡片');
  });

  testWidgets('提交中：折叠与关闭都禁用；完成后恢复/收起', (tester) async {
    final gate = Completer<void>();
    final backend = _Backend(respondGate: gate);
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store);
    await tester.pump();
    await tester.tap(_insideCard(find.text('发布')));
    await tester.pump();

    final submitFinder = _insideCard(find.widgetWithText(FilledButton, '提交'));
    await tester.tap(submitFinder);
    await tester.pump();

    expect(_insideCard(find.text('提交中…')), findsOneWidget);
    expect(tester.widget<InkWell>(_fold()).onTap, isNull, reason: '提交中禁止折叠');
    expect(tester.widget<InkWell>(_close()).onTap, isNull, reason: '提交中禁止关闭');
    expect(tester.getSemantics(_fold()).hint, contains('提交中，暂时不能收起'));

    // 点折叠/关闭都不生效，卡片仍保持展开与提交中。
    await tester.tap(_fold(), warnIfMissed: false);
    await _settleAnimations(tester);
    expect(_summary(), findsNothing);
    expect(find.text('提交中…'), findsOneWidget);

    gate.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(_card(), findsNothing, reason: '提交成功后卡片收起');
  });

  testWidgets('弹层变体（#120）不显示折叠控件，保持整卡展开', (tester) async {
    final backend = _Backend();
    final store = await _pumpChat(tester, backend: backend);
    _injectQuestion(store);
    await tester.pump();

    await tester.tap(find.byKey(const Key('open-question:call-ask')));
    await tester.pumpAndSettle();

    final sheet = find.byKey(const ValueKey<String>('question-sheet:$_rpc'));
    expect(sheet, findsOneWidget);
    expect(
      find.descendant(of: sheet, matching: _fold()),
      findsNothing,
      reason: '弹层变体不允许折叠',
    );
    expect(find.descendant(of: sheet, matching: _summary()), findsNothing);
    expect(
      find.descendant(of: sheet, matching: find.byType(TextField)),
      findsOneWidget,
      reason: '弹层仍保持完整作答内容',
    );
    expect(
      find.descendant(of: sheet, matching: find.text('待回答')),
      findsOneWidget,
    );
  });

  testWidgets('320dp + 深色 + 1.5×：折叠/展开不溢出，命中区 ≥44，摘要单行', (tester) async {
    addTearDown(() {
      L10n.lang = 'zh';
    });
    final backend = _Backend();
    final store = await _pumpChat(
      tester,
      backend: backend,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
      tag: '320-dark-15x',
    );
    _injectQuestion(
      store,
      header: '一个很长很长、在 320 宽度与 1.5 倍字号下必须省略的标题',
      question: '这是一个很长的问题，带多个选项，用来验证 320dp + 深色 + 1.5× 下卡片不裁字、不溢出。',
      questions: [
        {
          'id': 'q1',
          'header': '一个很长很长、在 320 宽度与 1.5 倍字号下必须省略的标题',
          'question': '这是一个很长的问题，带多个选项，用来验证 320dp + 深色 + 1.5× 下卡片不裁字、不溢出。',
          'options': [
            {'label': '选项一'},
            {'label': '选项二'},
            {'label': '选项三'},
            {'label': '选项四'},
            {'label': '选项五'},
          ],
        },
      ],
    );
    await tester.pump();
    expect(tester.takeException(), isNull);

    expect(tester.getSize(_fold()).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(_close()), const Size(44, 44));

    await _collapse(tester);
    expect(tester.takeException(), isNull);
    expect(tester.widget<Text>(_summary()).maxLines, 1);
    expect(tester.getSize(_fold()).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(_close()), const Size(44, 44));
    expect(tester.getSemantics(_fold()).label, contains('已收起，点按展开'));

    await _expand(tester);
    expect(tester.takeException(), isNull);
    expect(tester.getSemantics(_fold()).label, contains('已展开，点按收起'));
  });

  testWidgets('折叠/展开不抢滚动：跟随底部时保持贴底，阅读历史时保持位置', (tester) async {
    final backend = _Backend(history: _longHistory());
    final store = await _pumpChat(tester, backend: backend, tag: 'scroll');

    ScrollPosition positionOf() => tester
        .state<ScrollableState>(
          find
              .descendant(
                of: find.byType(CustomScrollView),
                matching: find.byType(Scrollable, skipOffstage: false),
              )
              .first,
        )
        .position;

    await tester.pump(const Duration(milliseconds: 300));
    var position = positionOf();
    expect(position.maxScrollExtent, greaterThan(0));
    expect(
      (position.maxScrollExtent - position.pixels).abs(),
      lessThanOrEqualTo(2),
      reason: '首屏应落底',
    );

    _injectQuestion(store);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    position = positionOf();
    expect(
      (position.maxScrollExtent - position.pixels).abs(),
      lessThanOrEqualTo(3),
      reason: '问询卡出现后仍应贴底',
    );

    await _collapse(tester);
    position = positionOf();
    expect(
      (position.maxScrollExtent - position.pixels).abs(),
      lessThanOrEqualTo(3),
      reason: '折叠后保持贴底',
    );

    await _expand(tester);
    await tester.pump(const Duration(milliseconds: 300));
    position = positionOf();
    expect(
      (position.maxScrollExtent - position.pixels).abs(),
      lessThanOrEqualTo(3),
      reason: '展开后保持贴底',
    );

    // 阅读历史：真实上滑离开底部后，折叠/展开不得把位置拉回底部。
    final list = find.byType(CustomScrollView).first;
    await tester.drag(list, const Offset(0, 500));
    await tester.pump();
    await tester.drag(list, const Offset(0, 500));
    await tester.pumpAndSettle();
    final readingPixels = positionOf().pixels;
    expect(readingPixels, greaterThan(0));
    expect(
      readingPixels,
      lessThan(positionOf().maxScrollExtent - 50),
      reason: '应已离开底部',
    );

    await _collapse(tester);
    expect(
      positionOf().pixels,
      moreOrLessEquals(readingPixels, epsilon: 0.5),
      reason: '折叠不得抢滚动',
    );
    await _expand(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      positionOf().pixels,
      moreOrLessEquals(readingPixels, epsilon: 0.5),
      reason: '展开不得抢滚动',
    );
  });
}
