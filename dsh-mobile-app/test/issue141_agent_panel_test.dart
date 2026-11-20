// issue #141：代理面板壳 + 递归子代理树 + gating/降级。
//
// 覆盖验收：
//   - 四页签齐全、默认子代理；团队/任务板/消息占位；
//   - 默认全折叠、父行胶囊（直接子级数）+ 自绘三角、逐级展开不级联；
//   - 降级（multiLevelUnavailable）无胶囊 + 页签级提示；
//   - 空/加载/失败重试；
//   - 中断、行点击跳子会话并返回恢复父会话；
//   - 320/深色/1.5x；
//   - 主会话渲染「代理」，子代理会话渲染层不渲染 + 分发层 gating 纯逻辑；
//   - 过滤重排合并保留隐藏项槽位。

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/agent_panel.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _root = 'session-root';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Map<String, dynamic> _row(
  String id, {
  String? name,
  int? depth,
  String? parent,
  String title = '',
  String kind = 'child',
  String status = 'inactive',
  int? createdAt,
}) => {
  'id': id,
  'name': ?name,
  'depth': ?depth,
  'parentSessionId': ?parent,
  'title': title.isEmpty ? id : title,
  'kind': kind,
  'status': status,
  'createdAt': ?createdAt,
};

class _Backend {
  _Backend(
    this.rows, {
    this.catalogDegraded = false,
    this.multiLevelUnavailable = false,
  });

  List<Map<String, dynamic>> rows;
  final bool catalogDegraded;
  final bool multiLevelUnavailable;
  int subagentCalls = 0;
  int failSubagents = 0;
  Completer<http.Response>? holdSubagents;
  final List<Map<String, dynamic>> interrupts = [];

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://agent-panel.test'
    ..path = '/m'
    ..token = '';

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/subagents') {
      subagentCalls++;
      final hold = holdSubagents;
      if (hold != null) holdSubagents = null;
      if (failSubagents > 0) {
        failSubagents--;
        return _json({'ok': false, 'error': 'catalog-unavailable'}, 500);
      }
      if (hold != null) return hold.future;
      return _json({
        'ok': true,
        'parentAvailable': true,
        if (catalogDegraded) 'catalogDegraded': true,
        if (multiLevelUnavailable) 'multiLevelUnavailable': true,
        'subagents': rows,
      });
    }
    if (path == '/m/api/subagents/interrupt') {
      interrupts.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({'ok': true});
    }
    if (path == '/m/api/history') {
      return _json({'ok': true, 'events': <Object>[], 'hasMore': false});
    }
    return _json({'ok': true});
  }
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 80));
  }
}

Future<AppStore> _mountPanel(
  WidgetTester tester,
  _Backend backend, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
}) async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore()
    ..sessionId = _root
    ..sessions = [Session(id: _root, title: '主会话', cwd: null, createdAt: 1)];
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: textScaler),
        child: AgentPanelScreen(
          store: store,
          sessionId: _root,
          title: '主会话',
          apiClient: backend.api,
        ),
      ),
    ),
  );
  await _settle(tester);
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('#141 面板结构', () {
    testWidgets('四页签齐全且默认子代理；其余三页为占位', (tester) async {
      final backend = _Backend([
        _row(
          'child-a',
          name: 'reviewer',
          depth: 1,
          parent: _root,
          title: '审查核心',
        ),
      ]);
      await _mountPanel(tester, backend);
      expect(find.text('子代理'), findsOneWidget);
      expect(find.text('团队'), findsOneWidget);
      expect(find.text('任务板'), findsOneWidget);
      expect(find.text('消息'), findsOneWidget);
      expect(find.text('审查核心'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('agent-panel-session-title')),
        findsOneWidget,
      );

      for (final key in ['agent-tab-team', 'agent-tab-tasks']) {
        await tester.tap(find.byKey(ValueKey<String>(key)));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('将在后续版本并入本面板'),
          findsOneWidget,
          reason: '$key 应为说明性占位',
        );
      }
      // issue #144：消息页签已接入真实消息索引；本夹具未注入 loader → 明确降级说明。
      await tester.tap(
        find.byKey(const ValueKey<String>('agent-tab-messages')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey<String>('message-index-unsupported')),
        findsOneWidget,
        reason: '消息页签不再使用说明性占位',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('空目录显示明确空态', (tester) async {
      await _mountPanel(tester, _Backend([]));
      expect(find.byKey(const ValueKey('agent-panel-empty')), findsOneWidget);
      expect(find.text('暂无子代理'), findsOneWidget);
    });

    testWidgets('加载中先出 spinner，失败可重试', (tester) async {
      final backend = _Backend([
        _row('child-a', name: 'reviewer', depth: 1, parent: _root),
      ])..failSubagents = 1;
      SharedPreferences.setMockInitialValues({});
      final store = AppStore()..sessionId = _root;
      await tester.pumpWidget(
        MaterialApp(
          home: AgentPanelScreen(
            store: store,
            sessionId: _root,
            title: '主会话',
            apiClient: backend.api,
          ),
        ),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await _settle(tester);
      expect(find.byKey(const ValueKey('agent-panel-error')), findsOneWidget);
      await tester.tap(find.text('重试'));
      await _settle(tester);
      expect(find.byKey(const ValueKey('agent-panel-error')), findsNothing);
      expect(find.byKey(const ValueKey('agent-row-child-a')), findsOneWidget);
    });
  });

  group('#141 递归树', () {
    List<Map<String, dynamic>> tree() => [
      _row('child-a', name: 'reviewer', depth: 1, parent: _root, title: '审查核心'),
      _row('child-b', name: 'tester', depth: 1, parent: _root, title: '测试'),
      _row('grand', name: 'checker', depth: 2, parent: 'child-a', title: '孙代理'),
      _row('great', name: 'deep', depth: 3, parent: 'grand', title: '曾孙'),
      _row(
        'diag',
        depth: 1,
        parent: _root,
        kind: 'diagnostic',
        status: 'corrupt',
      ),
    ];

    testWidgets('默认全折叠；父行胶囊=直接子级数；逐级展开不级联', (tester) async {
      await _mountPanel(tester, _Backend(tree()));
      expect(find.byKey(const ValueKey('agent-row-child-a')), findsOneWidget);
      expect(find.byKey(const ValueKey('agent-row-child-b')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('agent-row-grand')),
        findsNothing,
        reason: '默认全折叠',
      );
      expect(find.byKey(const ValueKey('agent-row-great')), findsNothing);
      expect(find.byKey(const ValueKey('agent-count-child-a')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('agent-count-child-b')),
        findsNothing,
        reason: '叶子节点不显示胶囊',
      );
      expect(
        find.byKey(const ValueKey('agent-count-grand')),
        findsNothing,
        reason: '未展开时不渲染孙行，胶囊也不出现',
      );

      // 点父行胶囊 -> 展开下一层；孙行出现但曾孙仍折叠（不级联）。
      await tester.tap(find.byKey(const ValueKey('agent-count-child-a')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('agent-row-grand')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('agent-row-great')),
        findsNothing,
        reason: '展开不得级联展开孙级',
      );
      expect(find.byKey(const ValueKey('agent-count-grand')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('agent-count-grand')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('agent-row-great')), findsOneWidget);

      // 再点父行胶囊 -> 折叠，孙/曾孙一起收起（下一次逐级展开从孙开始）。
      await tester.tap(find.byKey(const ValueKey('agent-count-child-a')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('agent-row-grand')), findsNothing);
      expect(find.byKey(const ValueKey('agent-row-great')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('副行显示 name；无 name 回退 title；诊断行显示原因', (tester) async {
      await _mountPanel(tester, _Backend(tree()));
      expect(
        find.byKey(const ValueKey('agent-subtitle-child-a')),
        findsOneWidget,
      );
      final subtitle = tester.widget<Text>(
        find.byKey(const ValueKey('agent-subtitle-child-a')),
      );
      expect(subtitle.data, contains('reviewer'));
      expect(find.textContaining('目录数据损坏'), findsOneWidget);
      expect(find.byKey(const ValueKey('agent-row-diag')), findsOneWidget);
    });

    testWidgets('降级：提示条 + 全部直接子级可见 + 不渲染胶囊', (tester) async {
      await _mountPanel(
        tester,
        _Backend([
          _row(
            'child-a',
            name: 'reviewer',
            depth: null,
            parent: _root,
            title: '审查核心',
          ),
          _row(
            'child-b',
            name: 'tester',
            depth: null,
            parent: _root,
            title: '测试',
          ),
          _row(
            'grand',
            name: 'checker',
            depth: null,
            parent: 'child-a',
            title: '孙代理',
          ),
        ], multiLevelUnavailable: true),
      );
      expect(
        find.byKey(const ValueKey('agent-panel-degraded')),
        findsOneWidget,
      );
      expect(find.textContaining('仅提供直接子代理'), findsOneWidget);
      expect(find.byKey(const ValueKey('agent-row-child-a')), findsOneWidget);
      expect(find.byKey(const ValueKey('agent-row-child-b')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('agent-row-grand')),
        findsOneWidget,
        reason: '降级时按响应行平铺，不丢行',
      );
      expect(
        find.byKey(const ValueKey('agent-count-child-a')),
        findsNothing,
        reason: '降级时不得渲染胶囊',
      );
      expect(find.byKey(const ValueKey('agent-count-grand')), findsNothing);
    });

    testWidgets('旧插件（无 depth/parentSessionId/name）：降级单层、只显示标题，不崩', (
      tester,
    ) async {
      await _mountPanel(
        tester,
        _Backend([
          {
            'id': 'old-a',
            'title': '旧子代理 A',
            'kind': 'child',
            'status': 'inactive',
          },
          {
            'id': 'old-b',
            'title': '旧子代理 B',
            'kind': 'child',
            'status': 'inactive',
          },
        ]),
      );
      expect(
        find.byKey(const ValueKey('agent-panel-degraded')),
        findsOneWidget,
      );
      expect(find.text('旧子代理 A'), findsOneWidget);
      expect(find.text('旧子代理 B'), findsOneWidget);
      expect(
        find.textContaining('old-a'),
        findsOneWidget,
        reason: '无 name 时副行回退 id，不与标题重复',
      );
      expect(find.byKey(const ValueKey('agent-count-old-a')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('目录不完整（catalogDegraded）提示，但树仍可展开', (tester) async {
      await _mountPanel(
        tester,
        _Backend([
          _row(
            'child-a',
            name: 'reviewer',
            depth: 1,
            parent: _root,
            title: '审查核心',
          ),
          _row(
            'grand',
            name: 'checker',
            depth: 2,
            parent: 'child-a',
            title: '孙代理',
          ),
        ], catalogDegraded: true),
      );
      expect(
        find.byKey(const ValueKey('agent-panel-catalog-degraded')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('agent-count-child-a')),
        findsOneWidget,
        reason: 'catalogDegraded 不影响多层树能力',
      );
      await tester.tap(find.byKey(const ValueKey('agent-count-child-a')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('agent-row-grand')), findsOneWidget);
    });
  });

  group('#141 Semantics', () {
    testWidgets('展开胶囊有可读语义标签，展开后变为收起', (tester) async {
      final handle = tester.ensureSemantics();
      try {
        await _mountPanel(
          tester,
          _Backend([
            _row(
              'child-a',
              name: 'reviewer',
              depth: 1,
              parent: _root,
              title: '审查核心',
            ),
            _row(
              'grand',
              name: 'checker',
              depth: 2,
              parent: 'child-a',
              title: '孙代理',
            ),
          ]),
        );
        final toggle = find.byKey(const ValueKey('agent-count-child-a'));
        expect(tester.getSemantics(toggle).label, contains('展开 1 个子代理'));
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(tester.getSemantics(toggle).label, contains('收起 1 个子代理'));
      } finally {
        handle.dispose();
      }
    });
  });

  group('#141 中断与跳转', () {
    testWidgets('运行中子代理显示中断，点击真实发请求', (tester) async {
      final backend = _Backend([
        _row(
          'child-a',
          name: 'reviewer',
          depth: 1,
          parent: _root,
          status: 'running',
          title: '运行中',
        ),
      ]);
      await _mountPanel(tester, backend);
      expect(find.byTooltip('中断子代理'), findsOneWidget);
      await tester.tap(find.byTooltip('中断子代理'));
      await _settle(tester);
      expect(backend.interrupts, hasLength(1));
      expect(backend.interrupts.single['parentSessionId'], _root);
      expect(backend.interrupts.single['childSessionId'], 'child-a');
    });

    testWidgets('点行进入子会话，返回后恢复父会话', (tester) async {
      final backend = _Backend([
        _row(
          'child-nav',
          name: 'reviewer',
          depth: 1,
          parent: _root,
          title: '可跳转',
        ),
      ]);
      final store = await _mountPanel(tester, backend);
      expect(store.sessionId, _root);
      await tester.tap(find.text('可跳转'));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(store.sessionId, 'child-nav');
      Navigator.of(tester.element(find.byType(ChatScreen))).pop();
      await _settle(tester);
      expect(store.sessionId, _root, reason: '返回后恢复父会话');
    });
  });

  group('#141 适配与 gating', () {
    testWidgets('320dp / 深色 / 1.5x 不溢出且四页签完整', (tester) async {
      await _mountPanel(
        tester,
        _Backend([
          _row(
            'child-a',
            name: 'reviewer',
            depth: 1,
            parent: _root,
            title: '审查核心',
          ),
          _row(
            'grand',
            name: 'checker',
            depth: 2,
            parent: 'child-a',
            title: '孙代理',
          ),
        ]),
        size: const Size(320, 640),
        textScaler: const TextScaler.linear(1.5),
        theme: DshTheme.dark(),
      );
      expect(find.text('子代理'), findsOneWidget);
      expect(find.text('消息'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('320×2.0 四页签降档字号，无溢出异常', (tester) async {
      await _mountPanel(
        tester,
        _Backend([
          _row(
            'child-a',
            name: 'reviewer',
            depth: 1,
            parent: _root,
            title: '审查核心',
          ),
        ]),
        size: const Size(320, 640),
        textScaler: const TextScaler.linear(2.0),
      );
      expect(find.text('子代理'), findsOneWidget);
      expect(find.text('团队'), findsOneWidget);
      expect(find.text('任务板'), findsOneWidget);
      expect(find.text('消息'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('主会话渲染「代理」；子代理会话渲染层不渲染', (tester) async {
      SharedPreferences.setMockInitialValues({});
      Future<void> openRail(AppStore store, String key) async {
        await tester.pumpWidget(
          MaterialApp(
            home: ChatScreen(
              key: ValueKey(key),
              store: store,
              apiClient: _Backend([]).api,
              onTitleChanged: () {},
            ),
          ),
        );
        await tester.pump();
        await tester.tap(find.byTooltip('对话操作'));
        await tester.pumpAndSettle();
      }

      final main = AppStore()
        ..sessionId = 'main'
        ..sessions = [Session(id: 'main', title: '主', cwd: null, createdAt: 1)];
      await openRail(main, 'main');
      expect(find.byTooltip('代理'), findsOneWidget);

      final sub = AppStore()
        ..sessionId = 'sub'
        ..sessions = [
          Session(
            id: 'sub',
            title: '子',
            cwd: null,
            createdAt: 1,
            origin: 'subagent',
          ),
          Session(id: 'main', title: '主', cwd: null, createdAt: 1),
        ];
      await tester.pumpWidget(const SizedBox.shrink());
      await openRail(sub, 'sub');
      expect(find.byTooltip('代理'), findsNothing, reason: '子代理会话整项不渲染');
      expect(find.byTooltip('Git'), findsOneWidget);
    });

    test('分发层 gating + 过滤重排合并', () {
      final main = AppStore()
        ..sessionId = 'main'
        ..sessions = [Session(id: 'main', title: '主', cwd: null, createdAt: 1)];
      final sub = AppStore()
        ..sessionId = 'sub'
        ..sessions = [
          Session(
            id: 'sub',
            title: '子',
            cwd: null,
            createdAt: 1,
            origin: 'subagent',
          ),
        ];
      expect(canOpenAgentPanel(main, 'main'), isTrue);
      expect(canOpenAgentPanel(sub, 'sub'), isFalse);
      expect(canOpenAgentPanel(main, null), isTrue);

      const full = ['git', 'files', 'agents', 'session_tools', 'copy'];
      const visible = ['git', 'files', 'session_tools', 'copy'];
      final reordered = ['copy', 'files', 'session_tools', 'git'];
      expect(mergeFilteredConversationOrder(full, visible, reordered), [
        'copy',
        'files',
        'agents',
        'session_tools',
        'git',
      ]);
    });
  });
}
