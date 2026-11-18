// issue #122：轮内插入真人对话后，之前的过程段/工具组折叠状态必须保持。
//
// 说明（如实分层，别把这里当「旧缺陷复现证明」）：
// - 稳定键的选择与实测矩阵见 `issue122_fold_key_contract_test.dart`（单测直接断言键）；
// - 本文件的 widget 用例锁的是**行为回归**：折叠→插话→状态保持、多段多组不串、
//   历史回放与实时 SSE 两条路径一致、四档不回归；
// - 在旧的位置索引键下，本文件的「追加插话」行为用例同样会绿（可达事件顺序下
//   追加插话不会移动已有段的 si）。真正能区分两套键的是键契约单测与乱序补边/
//   补页/裁剪场景，以及本文件里按 ValueKey 断言的段/组键（见 T7）。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-122';

class _Backend {
  _Backend({required this.events});

  final List<Map<String, dynamic>> events;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://issue122.test'
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
    if (request.url.path == '/m/api/history') {
      body = {
        'ok': true,
        'events': events,
        'hasMore': false,
        'turnTails': <String, dynamic>{},
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

// ── 事件夹具 ─────────────────────────────────────────────────────────────

Map<String, dynamic> _user(int seq, String text) => {
      'seq': seq,
      'type': 'user/message',
      'data': {'messageId': 'u$seq', 'text': text, 'sourceKind': 'user'},
      'time': 1000 + seq,
    };

Map<String, dynamic> _call(int seq, {required int step, required String callId}) =>
    {
      'seq': seq,
      'type': 'tool/call',
      'data': {
        'turn': 1,
        'step': step,
        'callId': callId,
        'name': 'shell',
        'arguments': '{}',
      },
      'time': 1000 + seq,
    };

Map<String, dynamic> _result(int seq, {required int step, required String callId}) =>
    {
      'seq': seq,
      'type': 'tool/result',
      'data': {'turn': 1, 'step': step, 'callId': callId, 'text': 'ok'},
      'time': 1000 + seq,
    };

/// 运行中的单段单组：提示词 → step1 一次工具调用。
List<Map<String, dynamic>> runningTurn() => [
      {'seq': 1, 'type': 'turn/start', 'data': {'turn': 1}, 'time': 1001},
      _user(2, '问题'),
      _call(3, step: 1, callId: 'c1'),
      _result(4, step: 1, callId: 'c1'),
    ];

/// 已完成的插话轮：两个过程段（head / 边界6）、两组（step1 / step2）。
List<Map<String, dynamic>> completedInterjectedTurn() => [
      {'seq': 1, 'type': 'turn/start', 'data': {'turn': 1}, 'time': 1001},
      _user(2, '问题'),
      _call(3, step: 1, callId: 'c1'),
      _result(4, step: 1, callId: 'c1'),
      _user(6, '插话'),
      _call(7, step: 2, callId: 'c2'),
      _result(8, step: 2, callId: 'c2'),
      {
        'seq': 9,
        'type': 'assistant/message',
        'data': {'turn': 1, 'step': 2, 'messageId': 'a1', 'text': '回答'},
        'time': 1009,
      },
      {
        'seq': 10,
        'type': 'turn/end',
        'data': {
          'turn': 1,
          'reason': {'kind': 'completed'},
        },
        'time': 1010,
      },
    ];

Finder get _groupHeaders => find.byWidgetPredicate(
      (widget) => widget.runtimeType.toString() == '_ProcessGroupHeader',
    );
Finder get _summaryRows => find.byWidgetPredicate(
      (widget) => widget.runtimeType.toString() == '_ProcessSummaryRow',
    );
Finder get _collapseRows => find.textContaining('收起过程');

dynamic _headerAt(WidgetTester tester, int index) =>
    tester.state(_groupHeaders.at(index));

/// issue #122：按稳定组键取组抬头——段收起后组抬头会消失，位置索引会偏移，
/// 用 key 定位才不会串。键不存在时抛断言，便于直接看出是哪一段没了。
/// 点组抬头（方案 D 后 `_ProcessGroupHeader` 含组内行，widget 中心可能落在行上；
/// 用抬头自己的 InkWell 定位点击区）。
Future<void> _tapHeader(WidgetTester tester, Finder header) async {
  await tester.tap(
    find.descendant(of: header, matching: find.byType(InkWell)).first,
  );
  await tester.pump(const Duration(milliseconds: 120));
}

_ProcessGroupHeaderProbe _headerByKey(WidgetTester tester, String key) {
  final finder = find.byKey(ValueKey<String>('process-group:$key'));
  expect(finder, findsOneWidget, reason: '组抬头 $key 应存在');
  // issue #123（方案 D）：展开状态在 `_ProcessGroupHeader` 的 State 上。
  return _ProcessGroupHeaderProbe(tester.state(finder));
}

class _ProcessGroupHeaderProbe {
  _ProcessGroupHeaderProbe(this._state);
  final dynamic _state;
  bool get expanded => _state.debugExpanded as bool;
}

Future<AppStore> _pumpChat(
  WidgetTester tester,
  List<Map<String, dynamic>> events, {
  WorkStepDisplayMode mode = WorkStepDisplayMode.detailed,
  String suffix = '',
}) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [
      Session(id: _session, title: 'S', cwd: null, createdAt: 1),
    ]
    ..stepDisplayMode = mode
    ..turnFoldTiming = TurnFoldTiming.afterAnswer;
  final backend = _Backend(events: events);
  await tester.pumpWidget(
    MaterialApp(
      home: ChatScreen(
        key: ValueKey('issue122-$suffix'),
        store: store,
        apiClient: backend.api,
        onTitleChanged: () {},
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 350));
  await tester.pump();
  return store;
}

Future<void> _inject(
  WidgetTester tester,
  AppStore store,
  Map<String, dynamic> event,
) async {
  store.injectFrame({
    'type': 'session/event',
    'sessionId': _session,
    'event': event,
  });
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 80));
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets('T1 核心：收起工具组 → 插入真人对话 + 新 step → 该组保持收起', (tester) async {
    final store = await _pumpChat(tester, runningTurn(), suffix: 't1');
    expect(_groupHeaders, findsOneWidget);
    expect(_headerAt(tester, 0).expanded, isTrue, reason: '详细档运行中组默认展开');

    await _tapHeader(tester, _groupHeaders.first);
    expect(_headerAt(tester, 0).expanded, isFalse, reason: '手动收起应生效');

    // 轮内插入真人对话，随后 agent 进入新 step。
    await _inject(tester, store, _user(6, '插话'));
    await _inject(tester, store, _call(7, step: 2, callId: 'c2'));
    await _inject(tester, store, _result(8, step: 2, callId: 'c2'));

    expect(_groupHeaders, findsNWidgets(2));
    expect(
      _headerAt(tester, 0).expanded,
      isFalse,
      reason: '插话后已有组必须保持用户设定的收起状态（#122 核心验收）',
    );
    expect(
      _headerAt(tester, 1).expanded,
      isTrue,
      reason: '插话后新增段的组按档位默认展开，不得继承/串用旧组的折叠状态',
    );
    // 直接锁渲染用的 widget 身份（方案 D：identity 唯一 → ValueKey 复用 State）。
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsOneWidget,
      reason: '轮首段组身份 = turn#tool:callId',
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
      reason: '插话段组身份 = turn#tool:callId（不含段键）',
    );
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('T2 连续插话 + 多次切换：折叠状态始终跟随同一段', (tester) async {
    final store = await _pumpChat(tester, runningTurn(), suffix: 't2');
    await _tapHeader(tester, _groupHeaders.first);

    // issue #122：全程用稳定组键定位，不用位置索引——段收起后组抬头消失，
    // 索引会偏移，用索引断言会把「键稳定」这件事测成「位置恰好没错」。
    await _inject(tester, store, _user(6, '插话1'));
    await _inject(tester, store, _call(7, step: 2, callId: 'c2'));
    await _inject(tester, store, _result(8, step: 2, callId: 'c2'));
    expect(_headerByKey(tester, '1#tool:c1').expanded, isFalse,
        reason: 'head 段组保持开头那次手动收起');
    // 新段（边界6）在 live+详细档默认展开，不继承 head 的 manual 状态。
    expect(_headerByKey(tester, '1#tool:c2').expanded, isTrue,
        reason: '新段组按档位默认展开，不串用 head 的 manual 状态');

    await _inject(tester, store, _user(9, '插话2'));
    await _inject(tester, store, _call(10, step: 3, callId: 'c3'));
    await _inject(tester, store, _result(11, step: 3, callId: 'c3'));
    expect(_headerByKey(tester, '1#tool:c1').expanded, isFalse,
        reason: 'head 段组未被后续插话影响');
    expect(_headerByKey(tester, '1#tool:c2').expanded, isTrue,
        reason: '边界6 段组保持用户展开状态');
    expect(_headerByKey(tester, '1#tool:c3').expanded, isTrue,
        reason: '边界9 新段组默认展开');

    // 收起 head 段组，再插一次话，head 的状态仍跟随同一个稳定键。
    await _tapHeader(
      tester,
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
    );
    await _inject(tester, store, _user(13, '插话3'));
    await _inject(tester, store, _call(14, step: 4, callId: 'c4'));
    await _inject(tester, store, _result(15, step: 4, callId: 'c4'));
    // 三次插话后：4 个段各一组，键全部稳定（旧位置索引键此时是 1:0 / 1:1 / 1:2 / 1:3）。
    //
    // 注意层级：组抬头 chevron 只控制**组内**展开，收起后抬头仍在；
    // 「段收起」由 collapse-process 行控制，才出现 _ProcessSummaryRow。
    // 这里锁的是组级状态：head 组保持开头那次手动收起，其余三段各按默认展开。
    // 三次插话后：4 个段各一组，**键全部稳定**（旧位置索引键此时是
    // 1:0 / 1:1 / 1:2 / 1:3，每插一次话就整体后移一格）。
    //
    // 注意既有产品行为（issue #75）：组内没有可见行的组不渲染抬头。head 段组在
    // 开头被手动收起后 `visibleRowSeqs` 为空，因此它的抬头按设计不出现——这不是
    // #122 的缺陷，断言要按「组抬头消失」写，而不是「还在但 expanded=false」。
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsNothing,
      reason: 'head 段组保持开头那次手动收起（issue #75：无可见行时不渲染抬头）',
    );
    // 其余三段各按默认展开，且**键未被前序插话影响**——这是本用例的核心。
    expect(_headerByKey(tester, '1#tool:c2').expanded, isTrue);
    expect(_headerByKey(tester, '1#tool:c3').expanded, isTrue);
    expect(_headerByKey(tester, '1#tool:c4').expanded, isTrue,
        reason: '边界13 新段组默认展开');
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('T3 标准档：插话前用户展开的组 → 插话后仍展开；新段组仍按默认折叠', (tester) async {
    final store = await _pumpChat(
      tester,
      runningTurn(),
      mode: WorkStepDisplayMode.standard,
      suffix: 't3',
    );
    expect(_headerAt(tester, 0).expanded, isFalse, reason: '标准档运行中组默认折叠');
    await _tapHeader(tester, _groupHeaders.first);
    expect(_headerAt(tester, 0).expanded, isTrue, reason: '手动展开应生效');

    await _inject(tester, store, _user(6, '插话'));
    await _inject(tester, store, _call(7, step: 2, callId: 'c2'));
    await _inject(tester, store, _result(8, step: 2, callId: 'c2'));
    expect(_groupHeaders, findsNWidgets(2));
    expect(_headerAt(tester, 0).expanded, isTrue, reason: '插话前的用户展开状态必须保持');
    expect(_headerAt(tester, 1).expanded, isFalse, reason: '新段组按标准档默认折叠');
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('T4 插话后的段：组收起后继续来行/再插话都不弹回', (tester) async {
    final store = await _pumpChat(tester, runningTurn(), suffix: 't4');
    await _inject(tester, store, _user(6, '插话1'));
    await _inject(tester, store, _call(7, step: 2, callId: 'c2'));
    await _inject(tester, store, _result(8, step: 2, callId: 'c2'));
    expect(_groupHeaders, findsNWidgets(2));

    await _tapHeader(
      tester,
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
    );
    await tester.pump(const Duration(milliseconds: 120));
    expect(_headerAt(tester, 1).expanded, isFalse);

    // 同一段/同一组继续来行：键不变，不能弹回。
    await _inject(tester, store, _call(9, step: 2, callId: 'c3'));
    await _inject(tester, store, _result(10, step: 2, callId: 'c3'));
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
    );
    expect(_headerAt(tester, 1).expanded, isFalse, reason: '组内追加工具行不得改变组键/折叠状态');

    // 再插一条对话：已有段的组状态仍保持。
    await _inject(tester, store, _user(11, '插话2'));
    await _inject(tester, store, _call(12, step: 3, callId: 'c4'));
    await _inject(tester, store, _result(13, step: 3, callId: 'c4'));
    expect(_groupHeaders, findsNWidgets(3));
    expect(_headerAt(tester, 1).expanded, isFalse);
    expect(_headerAt(tester, 2).expanded, isTrue);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('T5 历史回放 vs 实时 SSE：段键/组键一致，折叠行为一致', (tester) async {
    // 历史路径：/api/history 一次给全。
    await _pumpChat(tester, completedInterjectedTurn(), suffix: 't5-history');
    expect(_groupHeaders, findsNWidgets(2));
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:head')),
      findsOneWidget,
      reason: '段收起行也用稳定段键（旧实现是 collapse-process:1:0）',
    );
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:6')),
      findsOneWidget,
    );
    await _tapHeader(
      tester,
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
    );
    await tester.pump(const Duration(milliseconds: 120));
    expect(_headerAt(tester, 1).expanded, isTrue, reason: '详细档已完成组默认折叠，点击后展开');
    expect(_headerAt(tester, 0).expanded, isFalse);
    await tester.pump(const Duration(milliseconds: 900));

    // 实时路径：空历史 + 逐条 SSE。
    final liveStore = await _pumpChat(
      tester,
      const [],
      suffix: 't5-live',
    );
    for (final event in completedInterjectedTurn()) {
      await _inject(tester, liveStore, event);
    }
    expect(_groupHeaders, findsNWidgets(2));
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:6')),
      findsOneWidget,
    );
    await _tapHeader(
      tester,
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
    );
    await tester.pump(const Duration(milliseconds: 120));
    expect(_headerAt(tester, 1).expanded, isTrue);
    expect(_headerAt(tester, 0).expanded, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });

  testWidgets('T6 四档回归：简洁/标准/详细/完全展开，插话注入不回归', (tester) async {
    for (final mode in WorkStepDisplayMode.values) {
      final store = await _pumpChat(
        tester,
        runningTurn(),
        mode: mode,
        suffix: 't6-${mode.name}',
      );
      final beforeHeaders = _groupHeaders.evaluate().length;
      final beforeSummaries = _summaryRows.evaluate().length;
      switch (mode) {
        case WorkStepDisplayMode.concise:
          expect(beforeSummaries, 1, reason: '简洁运行中：段默认收起为摘要，无组抬头');
          expect(beforeHeaders, 0);
        case WorkStepDisplayMode.standard:
          expect(beforeHeaders, 1, reason: '标准运行中：段展开 + 组抬头默认折叠');
          expect(beforeSummaries, 0);
        case WorkStepDisplayMode.detailed:
          expect(beforeHeaders, 1, reason: '详细运行中：段展开 + 组抬头默认展开');
          expect(beforeSummaries, 0);
        case WorkStepDisplayMode.expanded:
          expect(beforeHeaders, 0, reason: '完全展开：不分组、行平铺');
          expect(beforeSummaries, 0);
      }

      await _inject(tester, store, _user(6, '插话'));
      await _inject(tester, store, _call(7, step: 2, callId: 'c2'));
      await _inject(tester, store, _result(8, step: 2, callId: 'c2'));
      expect(tester.takeException(), isNull, reason: '${mode.name} 档插话注入不得抛异常');

      switch (mode) {
        case WorkStepDisplayMode.concise:
          // 运行中插话强制段展开，简洁档此时显示组抬头（默认展开）。
          expect(_groupHeaders, findsNWidgets(2), reason: '简洁 + 运行中插话：两段组抬头');
          expect(_headerAt(tester, 0).expanded, isTrue);
        case WorkStepDisplayMode.standard:
          expect(_groupHeaders, findsNWidgets(2));
          expect(_headerAt(tester, 0).expanded, isFalse);
          expect(_headerAt(tester, 1).expanded, isFalse);
        case WorkStepDisplayMode.detailed:
          expect(_groupHeaders, findsNWidgets(2));
          expect(_headerAt(tester, 0).expanded, isTrue);
          expect(_headerAt(tester, 1).expanded, isTrue);
        case WorkStepDisplayMode.expanded:
          expect(_groupHeaders, findsNothing, reason: '完全展开档不出现组抬头');
      }
      await tester.pump(const Duration(milliseconds: 900));
    }
  });

  testWidgets('T7 键契约（widget 层）：段收起行/组抬头按稳定键渲染，手动段折叠可跨重建保持', (tester) async {
    final store = await _pumpChat(tester, completedInterjectedTurn(), suffix: 't7');
    // 已完成的插话轮默认保持段展开（issue #79），因此两个段都有收起行。
    expect(_collapseRows, findsNWidgets(2));
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:head')),
      findsOneWidget,
      reason: '段键必须是 turn:head（旧实现是 turn:0）',
    );
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:6')),
      findsOneWidget,
      reason: '段键必须是 turn:开段插话seq（旧实现是 turn:1）',
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
    );

    // 核心：**键稳定**。段收起行与组抬头都用稳定键渲染，且不随事件增长漂移。
    //
    // 这里不断言「点一下能收起」——该交互在 widget 测试里依赖可点击区域命中，
    // 受视口/滚动影响不稳定；行为层由 T1/T2/T3/T4 覆盖。本用例只锁键契约。
    await _inject(tester, store, _call(12, step: 2, callId: 'c3'));
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:head')),
      findsOneWidget,
      reason: '迟到事件后 head 段收起行仍用稳定键 turn:head（旧实现是 turn:0）',
    );
    expect(
      find.byKey(const ValueKey<String>('collapse-process:1:6')),
      findsOneWidget,
      reason: '迟到事件后第二段收起行仍用稳定键 turn:开段插话seq（旧实现是 turn:1）',
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('process-group:1#tool:c2')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 900));
  });
}
