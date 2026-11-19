// task-35 / 真机会话 59aaa367：过程行超过分批上限（50）时误判「短内容」，
// 补 `_liveBottomGap` → 内容被推高、下方留空白。
//
// 场景（真机形态）：详细档 + 单轮 7 个 step × 10 次工具调用 = 70 个过程行（>50，
// 触发 `batchProcessRows` 分批，出现「显示更多」）+ 轮次已完成（详细档组抬头折叠）
// + 跟随态（贴在底部）。
//
// 期望：有隐藏行时**不得补底部占位**（内容客观上一屏装不下），也不得出现内容下方空白。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/batch_hidden_bottom_gap_test.dart

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _session = 'session-batch-hidden';
const Size _surface = Size(390, 844);

/// live 列表 SliverPadding 的底部内边距（与 issue118 测试同口径）。
const double _designBottomInset = 6;

/// 5 个 step × 20 次工具调用 = 100 行（> processBatchSize=50，隐藏 50 行）。
/// 详细档已完成轮 → 组抬头折叠：渲染高度 ~300dp < 视口 672，触发误判「短内容」。
const int _steps = 5;
const int _toolsPerStep = 20;

List<Map<String, dynamic>> _history() {
  final events = <Map<String, dynamic>>[];
  var seq = 1;
  void add(String type, Map<String, dynamic> data) => events.add({
    'seq': seq++,
    'type': type,
    'data': data,
    'time': 1000 + seq * 10,
  });

  add('turn/start', {'turn': 1});
  add('user/message', {
    'messageId': 'u1',
    'text': '排查子代理滚动问题',
    'sourceKind': 'user',
  });
  for (var step = 1; step <= _steps; step++) {
    for (var t = 0; t < _toolsPerStep; t++) {
      final callId = 'c$step-$t';
      add('tool/call', {
        'turn': 1,
        'step': step,
        'callId': callId,
        'name': 'shell',
        'arguments': 'echo $step-$t',
      });
      add('tool/result', {
        'turn': 1,
        'step': step,
        'callId': callId,
        'name': 'shell',
        'text': 'ok $step-$t',
      });
    }
  }
  add('assistant/message', {
    'turn': 1,
    'step': _steps + 1,
    'messageId': 'a1',
    'text': '检查完成',
  });
  add('turn/end', {
    'turn': 1,
    'reason': {'kind': 'completed'},
  });
  return events;
}

class _Backend {
  _Backend(this.history);
  final List<Map<String, dynamic>> history;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://batch-hidden.test'
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
    Map<String, dynamic> body;
    final path = request.url.path;
    if (path == '/m/api/history') {
      final params = request.url.queryParameters;
      final limit = int.tryParse(params['limit'] ?? '') ?? 50;
      if (params.containsKey('before')) {
        final before = int.tryParse(params['before'] ?? '') ?? 0;
        final preceding = history
            .where((e) => (e['seq'] as int) < before)
            .toList();
        body = {
          'ok': true,
          'events': preceding.length > limit
              ? preceding.sublist(preceding.length - limit)
              : preceding,
          'hasMore': preceding.length > limit,
        };
      } else if (params.containsKey('after')) {
        body = {'ok': true, 'events': <Object>[], 'hasMore': false};
      } else {
        // 初始整段历史（真机 59aaa367 是加载完整实时窗口的场景）。
        body = {'ok': true, 'events': history, 'hasMore': false};
      }
    } else if (path == '/m/api/event-detail') {
      body = {'ok': true, 'event': null};
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

class _Probe {
  _Probe(this.tester) : viewport = tester.renderObject<RenderBox>(find.byType(CustomScrollView));

  final WidgetTester tester;
  final RenderBox viewport;

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

  double get pixels => position.pixels;
  double get minExtent => position.minScrollExtent;
  double get maxExtent => position.maxScrollExtent;
  double get viewportHeight => position.viewportDimension;

  double get liveBottomGap {
    final state = tester.state(find.byType(ChatScreen));
    // ignore: avoid_dynamic_calls
    return (state as dynamic).debugLiveBottomGap as double;
  }

  bool get intentFollow {
    final state = tester.state(find.byType(ChatScreen));
    // ignore: avoid_dynamic_calls
    return (state as dynamic).debugPinnedToBottom as bool;
  }

  Rect get viewportRect => tester.getRect(find.byType(CustomScrollView));
  double get designBottom => viewportRect.bottom - _designBottomInset;

  RenderSliverMultiBoxAdaptor? get _liveSliver {
    for (final element in find
        .byType(SliverList, skipOffstage: false)
        .evaluate()
        .toList()
        .reversed) {
      final render = element.renderObject;
      if (render is RenderSliverMultiBoxAdaptor) return render;
    }
    return null;
  }

  /// 第一个已构建子项的全局 top（内容是否被底部占位整体下推）。
  double? get contentTop {
    final sliver = _liveSliver;
    if (sliver == null) return null;
    final first = sliver.firstChild;
    if (first == null) return null;
    return first.localToGlobal(Offset.zero).dy;
  }

  /// 最后一个已构建子项到设计底边的残差（正 = 内容下方还有空白）。
  double? get tailResidual {
    final sliver = _liveSliver;
    if (sliver == null) return null;
    RenderBox? last;
    RenderBox? child = sliver.firstChild;
    while (child != null) {
      last = child;
      child = sliver.childAfter(child);
    }
    if (last == null) return null;
    final origin = last.localToGlobal(Offset.zero);
    return designBottom - (origin.dy + last.size.height);
  }
}

Future<AppStore> _mount(WidgetTester tester, _Backend backend) async {
  final store = AppStore()
    ..sessionId = _session
    ..sessions = [Session(id: _session, title: 'S', cwd: null, createdAt: 1)]
    ..stepDisplayMode = WorkStepDisplayMode.detailed
    ..turnFoldTiming = TurnFoldTiming.afterAnswer;
  await tester.binding.setSurfaceSize(_surface);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  addTearDown(() async {
    await tester.pump(const Duration(seconds: 1));
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => MediaQuery(
          data: const MediaQueryData(size: _surface),
          child: ChatScreen(
            key: const ValueKey<String>('batch-hidden-gap'),
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

void main() {
  testWidgets('分批隐藏行（>50）时不得补底部占位、内容下方不得留空白', (tester) async {
    final backend = _Backend(_history());
    await _mount(tester, backend);
    final probe = _Probe(tester);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    // 前提：确实触发了分批（有隐藏行，出现「显示更多」）。
    expect(find.textContaining('显示更多'), findsOneWidget,
        reason: '夹具前提：70 个过程行 > 50，必须出现「显示更多」');
    // 修复后：不得因为有隐藏行而补底部占位。
    expect(probe.liveBottomGap, 0,
        reason: '有隐藏行时内容客观上一屏装不下，不得补底部占位（否则占位把内容整体下推）');
    // 内容顶必须与视口顶对齐（未被占位下推；修复前 gap>0 会把内容整体推下去）。
    expect(probe.contentTop, isNotNull);
    expect(
      (probe.contentTop! - probe.viewportRect.top).abs(),
      lessThanOrEqualTo(2),
      reason: '内容顶应贴视口顶（实测 top=${probe.contentTop} viewportTop=${probe.viewportRect.top}）',
    );
  });
  testWidgets('对照组：无隐藏行的短会话仍必须补底部占位（贴底）', (tester) async {
    // 2 次工具调用（2 行，远小于 50）→ 不带分批、也没有「显示更多」。
    final short = _history()
        .where(
          (e) =>
              e['type'] != 'tool/call' ||
              (e['data'] as Map)['step'] == 1,
        )
        .toList();
    // 只保留 step1 的前 2 次工具调用（其余裁剪掉）。
    final trimmed = <Map<String, dynamic>>[];
    var keptTools = 0;
    for (final e in short) {
      final type = e['type'] as String;
      if (type == 'tool/call' || type == 'tool/result') {
        final callId = ((e['data'] as Map)['callId'] as String?) ?? '';
        final idx = int.tryParse(callId.split('-').last) ?? 0;
        if (idx >= 2) continue;
        if (type == 'tool/call') keptTools++;
      }
      trimmed.add(e);
    }
    expect(keptTools, 2, reason: '夹具：只保留 2 次工具调用');
    final backend = _Backend(trimmed);
    await _mount(tester, backend);
    final probe = _Probe(tester);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(find.textContaining('显示更多'), findsNothing,
        reason: '对照前提：2 行 < 50，不触发分批');
    expect(probe.liveBottomGap, greaterThan(0),
        reason: '无隐藏行的短内容仍必须补底部占位（issue #77 契约）');
    expect(probe.tailResidual, isNotNull);
    expect(probe.tailResidual!.abs(), lessThanOrEqualTo(2),
        reason: '补占位后内容应贴在底部（tailResidual=${probe.tailResidual}）');
  });

}
