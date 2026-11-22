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
import 'package:flutter/semantics.dart';
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
  final Map<String, Map<String, dynamic>> sessionConfigs = {};
  final List<String> sessionConfigRequested = [];
  int sessionConfigCalls = 0;
  int sessionConfigActive = 0;
  int sessionConfigMaxActive = 0;
  int sessionConfigDelayMs = 0;
  int sessionConfigFailures = 0;
  bool holdSessionConfigs = false;
  final List<Completer<http.Response>> heldSessionConfigResponses = [];

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
    if (path == '/m/api/session-config') {
      final id = request.url.queryParameters['sessionId'] ?? '';
      sessionConfigCalls++;
      sessionConfigRequested.add(id);
      sessionConfigActive++;
      if (sessionConfigActive > sessionConfigMaxActive) {
        sessionConfigMaxActive = sessionConfigActive;
      }
      try {
        if (holdSessionConfigs) {
          final completer = Completer<http.Response>();
          heldSessionConfigResponses.add(completer);
          return await completer.future;
        }
        if (sessionConfigFailures > 0) {
          sessionConfigFailures--;
          return _json({'ok': false, 'error': 'config-unavailable'}, 500);
        }
        if (sessionConfigDelayMs > 0) {
          await Future<void>.delayed(
            Duration(milliseconds: sessionConfigDelayMs),
          );
        }
        return _json({
          'ok': true,
          'config': sessionConfigs[id] ?? <String, dynamic>{},
        });
      } finally {
        sessionConfigActive--;
      }
    }
    if (path == '/m/api/subagents/interrupt') {
      interrupts.add(jsonDecode(request.body) as Map<String, dynamic>);
      return _json({'ok': true});
    }
    if (path == '/m/api/team/tasks') {
      return _json({
        'ok': true,
        'supported': true,
        'enabled': false,
        'tasks': <Object>[],
      });
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
  Catalog? catalog,
}) async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore()
    ..sessionId = _root
    ..sessions = [Session(id: _root, title: '主会话', cwd: null, createdAt: 1)];
  if (catalog != null) store.catalog = catalog;
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

      // #142：团队页已有真实内容（本 fake 无 team 服务 → 降级提示）。
      await tester.tap(find.byKey(const ValueKey<String>('agent-tab-team')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('agent-team-switch-card')),
        findsOneWidget,
      );
      // #143：任务板已接真实只读端点；团队未启用时显示启用引导，不再是占位。
      await tester.tap(find.byKey(const ValueKey<String>('agent-tab-tasks')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('agent-tasks-disabled')),
        findsOneWidget,
      );
      // issue #144：消息页签已接入真实消息索引；本夹具未注入 loader → 明确降级说明。
      await tester.tap(
        find.byKey(const ValueKey<String>('agent-tab-messages')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('message-index-unsupported')),
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

  group('#160 子代理树命中区/层级', () {
    List<Map<String, dynamic>> deepTree() => [
      _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
      _row('c2', name: 'a2', depth: 2, parent: 'c1', title: '二级'),
      _row('c3', name: 'a3', depth: 3, parent: 'c2', title: '三级'),
      _row('c4', name: 'a4', depth: 4, parent: 'c3', title: '四级'),
      _row('c5', name: 'a5', depth: 5, parent: 'c4', title: '五级'),
    ];

    testWidgets('展开区 44×44：点边缘只展开，不打开；正文点击才进会话', (tester) async {
      final backend = _Backend(deepTree());
      final store = await _mountPanel(tester, backend);
      final expand = find.byKey(const ValueKey('agent-expand-c1'));
      expect(tester.getSize(expand), const Size(56, 48));
      await tester.tapAt(tester.getTopLeft(expand) + const Offset(3, 3));
      await _settle(tester);
      expect(
        find.byKey(const ValueKey('agent-row-c2')),
        findsOneWidget,
        reason: '44dp 命中区任意位置都应展开',
      );
      expect(store.sessionId, _root);
      expect(find.byType(ChatScreen), findsNothing);

      await tester.tap(find.byKey(const ValueKey('agent-body-c1')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
    });

    testWidgets('level>3：停在 28dp、副行 L{n}、rail 缺口语义“显示封顶”', (tester) async {
      final backend = _Backend(deepTree());
      await _mountPanel(tester, backend);
      for (final id in ['c1', 'c2', 'c3', 'c4']) {
        await tester.tap(find.byKey(ValueKey('agent-expand-$id')));
        await _settle(tester);
      }
      final x3 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-body-c3')))
          .dx;
      final x4 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-body-c4')))
          .dx;
      final x5 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-body-c5')))
          .dx;
      expect(x4, closeTo(x3, 0.1), reason: 'level 4 必须停在第 3 级缩进');
      expect(x5, closeTo(x3, 0.1), reason: 'level 5 必须停在第 3 级缩进');
      expect(find.textContaining('L4'), findsOneWidget);
      expect(find.textContaining('L5'), findsOneWidget);
      final semantics = tester.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp(r'第 5 层（显示封顶在第三级）')), findsOneWidget);
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('320/深色/2.0x：深层树不溢出，L{n} 与 effort 仍可见', (tester) async {
      final backend = _Backend(deepTree())
        ..sessionConfigs.addAll({
          for (final id in ['c1', 'c2', 'c3', 'c4', 'c5'])
            id: {
              'model': 'a-very-long-model-name-that-needs-ellipsis',
              'provider': 'p',
              'reasoningEffort': 'high',
            },
        });
      final catalog = Catalog(
        models: [
          CatalogModel(
            provider: 'p',
            id: 'a-very-long-model-name-that-needs-ellipsis',
            name: 'A very long model name that needs ellipsis',
            reasoning: const ModelReasoning(
              efforts: [ReasoningEffort(id: 'high', name: '高')],
            ),
          ),
        ],
        permissionPresets: const [],
        agentPresets: const [],
        defaults: const {},
        rechargeUrl: '',
        providers: const [],
      );
      await _mountPanel(
        tester,
        backend,
        size: const Size(320, 700),
        textScaler: const TextScaler.linear(2.0),
        theme: DshTheme.dark(),
        catalog: catalog,
      );
      for (final id in ['c1', 'c2', 'c3', 'c4']) {
        await tester.tap(find.byKey(ValueKey('agent-expand-$id')));
        await _settle(tester);
      }
      expect(tester.takeException(), isNull);
      expect(find.textContaining('L4'), findsOneWidget);
      expect(find.textContaining('L5'), findsOneWidget);
      expect(find.textContaining('高'), findsWidgets);
      final expand = find.byKey(const ValueKey('agent-expand-c1'));
      expect(tester.getSize(expand), const Size(56, 48));
    });

    testWidgets('Semantics：展开/打开有 tap action，performAction 能真正触发', (
      tester,
    ) async {
      final backend = _Backend([
        _row('s1', name: 'agent-one', depth: 1, parent: _root, title: '语义父'),
        _row('s2', name: 'agent-two', depth: 2, parent: 's1', title: '语义子'),
      ]);
      final store = await _mountPanel(tester, backend);
      final semantics = tester.ensureSemantics();

      final expandFinder = find.byKey(
        const ValueKey('agent-expand-semantics-s1'),
      );
      final expandNode = tester.getSemantics(expandFinder);
      expect(
        expandNode.getSemanticsData().hasAction(SemanticsAction.tap),
        isTrue,
        reason: '展开区外层 Semantics 必须有 tap action',
      );
      tester.binding.pipelineOwner.semanticsOwner!.performAction(
        expandNode.id,
        SemanticsAction.tap,
      );
      await _settle(tester);
      expect(find.byKey(const ValueKey('agent-row-s2')), findsOneWidget);
      expect(store.sessionId, _root);

      final bodyFinder = find.byKey(const ValueKey('agent-body-semantics-s1'));
      final bodyNode = tester.getSemantics(bodyFinder);
      final bodyData = bodyNode.getSemanticsData();
      expect(bodyData.hasAction(SemanticsAction.tap), isTrue);
      expect(bodyData.label, contains('agent-one'));
      expect(bodyData.label, contains('第 1 层'));
      expect(
        bodyData.hint,
        isNot(contains('第 1 层')),
        reason: 'hint 不得重复 level',
      );
      tester.binding.pipelineOwner.semanticsOwner!.performAction(
        bodyNode.id,
        SemanticsAction.tap,
      );
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('Semantics：中断有 tap action 且 performAction 发真实请求', (
      tester,
    ) async {
      final backend = _Backend([
        _row(
          'run',
          name: 'runner',
          depth: 1,
          parent: _root,
          title: '运行节点',
          status: 'running',
        ),
      ]);
      await _mountPanel(tester, backend);
      final semantics = tester.ensureSemantics();
      final node = tester.getSemantics(
        find.byKey(const ValueKey('agent-interrupt-semantics-run')),
      );
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      tester.binding.pipelineOwner.semanticsOwner!.performAction(
        node.id,
        SemanticsAction.tap,
      );
      await _settle(tester);
      expect(backend.interrupts, hasLength(1));
      semantics.dispose();
    });

    testWidgets('模型/effort 第三行：本地化、左对齐 105/119/133、懒加载且不伪造旧宿主', (tester) async {
      final backend =
          _Backend([
              _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
              _row('c2', name: 'a2', depth: 2, parent: 'c1', title: '二级'),
              _row('c3', name: 'a3', depth: 3, parent: 'c2', title: '三级'),
            ])
            ..sessionConfigs.addAll({
              'c1': {'model': 'm1', 'provider': 'p', 'reasoningEffort': 'high'},
              'c2': {'model': 'm1', 'provider': 'p', 'reasoningEffort': 'high'},
              'c3': {'model': 'm1', 'provider': 'p', 'reasoningEffort': 'high'},
            });
      final catalog = Catalog(
        models: [
          CatalogModel(
            provider: 'p',
            id: 'm1',
            name: 'GPT-5',
            reasoning: const ModelReasoning(
              efforts: [ReasoningEffort(id: 'high', name: '高')],
            ),
          ),
        ],
        permissionPresets: const [],
        agentPresets: const [],
        defaults: const {},
        rechargeUrl: '',
        providers: const [],
      );
      await _mountPanel(tester, backend, catalog: catalog);
      // 默认折叠：只加载根级直接子代理，孙/曾孙不请求。
      expect(backend.sessionConfigRequested, ['c1']);
      await tester.tap(find.byKey(const ValueKey('agent-expand-c1')));
      await _settle(tester);
      await tester.tap(find.byKey(const ValueKey('agent-expand-c2')));
      await _settle(tester);
      expect(backend.sessionConfigRequested, containsAll(['c1', 'c2', 'c3']));
      expect(find.text('GPT-5'), findsNWidgets(3));
      expect(find.text(' · 高'), findsNWidgets(3));
      final x1 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-model-c1')))
          .dx;
      final x2 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-model-c2')))
          .dx;
      final x3 = tester
          .getTopLeft(find.byKey(const ValueKey('agent-model-c3')))
          .dx;
      expect(x1, closeTo(105, 0.5));
      expect(x2, closeTo(119, 0.5));
      expect(x3, closeTo(133, 0.5));
      // 第二行元信息与第三行同起点。
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('agent-subtitle-c1'))).dx,
        closeTo(105, 0.5),
      );
      final semantics = tester.ensureSemantics();
      final body = tester.getSemantics(
        find.byKey(const ValueKey('agent-body-semantics-c1')),
      );
      expect(body.getSemanticsData().label, contains('模型 GPT-5，高'));
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('首次模型请求失败不永久缓存：刷新后恢复真实模型', (tester) async {
      final backend =
          _Backend([
              _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
            ])
            ..sessionConfigFailures = 1
            ..sessionConfigs['c1'] = {'model': 'model-a', 'provider': 'p'};
      await _mountPanel(tester, backend);
      await _settle(tester);
      expect(find.byKey(const ValueKey('agent-model-c1')), findsNothing);
      expect(backend.sessionConfigCalls, 1);
      await tester.tap(find.byTooltip('刷新'));
      await _settle(tester);
      expect(backend.sessionConfigCalls, greaterThanOrEqualTo(2));
      expect(
        find.byKey(const ValueKey('agent-model-c1')),
        findsOneWidget,
        reason: '刷新必须清掉失败缓存并重新请求',
      );
      expect(find.text('model-a'), findsOneWidget);
    });

    testWidgets('子会话改模型后返回：面板按世代重拉并显示新模型', (tester) async {
      final backend = _Backend([
        _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
      ])..sessionConfigs['c1'] = {'model': 'model-a', 'provider': 'p'};
      await _mountPanel(tester, backend);
      await tester.tap(find.byKey(const ValueKey('agent-expand-c1')));
      await _settle(tester);
      expect(find.text('model-a'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('agent-body-c1')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      backend.sessionConfigs['c1'] = {'model': 'model-b', 'provider': 'p'};
      Navigator.of(tester.element(find.byType(ChatScreen))).pop();
      await _settle(tester);
      expect(find.byType(ChatScreen), findsNothing);
      expect(find.text('model-b'), findsOneWidget);
      expect(find.text('model-a'), findsNothing);
    });

    testWidgets('旧在途响应不能覆盖刷新后的新一代模型', (tester) async {
      final backend = _Backend([
        _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
      ])..holdSessionConfigs = true;
      await _mountPanel(tester, backend);
      await _settle(tester);
      expect(backend.heldSessionConfigResponses, hasLength(1));
      await tester.tap(find.byTooltip('刷新'));
      await _settle(tester);
      expect(backend.heldSessionConfigResponses, hasLength(2));

      backend.heldSessionConfigResponses[0].complete(
        _json({
          'ok': true,
          'config': {'model': 'stale-model', 'provider': 'p'},
        }),
      );
      await _settle(tester);
      expect(find.text('stale-model'), findsNothing);
      backend.heldSessionConfigResponses[1].complete(
        _json({
          'ok': true,
          'config': {'model': 'fresh-model', 'provider': 'p'},
        }),
      );
      await _settle(tester);
      expect(find.text('fresh-model'), findsOneWidget);
      expect(find.text('stale-model'), findsNothing);
    });

    testWidgets('320/2.0x 深层 running + 超长 effort：不溢出且 Semantics 保留完整值', (
      tester,
    ) async {
      final longEffort =
          'ultra-long-custom-effort-id-abcdefghijklmnopqrstuvwxyz';
      final backend = _Backend(deepTree())
        ..sessionConfigs.addAll({
          for (final id in ['c1', 'c2', 'c3', 'c4', 'c5'])
            id: {
              'model': 'a-very-long-model-name-that-needs-ellipsis',
              'provider': 'p',
              'reasoningEffort': longEffort,
            },
        });
      await _mountPanel(
        tester,
        backend,
        size: const Size(320, 700),
        textScaler: const TextScaler.linear(2.0),
        theme: DshTheme.dark(),
      );
      for (final id in ['c1', 'c2', 'c3', 'c4']) {
        await tester.tap(find.byKey(ValueKey('agent-expand-$id')));
        await _settle(tester);
      }
      expect(tester.takeException(), isNull);
      final semantics = tester.ensureSemantics();
      final body = tester.getSemantics(
        find.byKey(const ValueKey('agent-body-semantics-c1')),
      );
      expect(body.getSemanticsData().label, contains(longEffort));
      semantics.dispose();
    });

    testWidgets('旧宿主/缺字段：不伪造模型第三行；3 并发懒加载上限', (tester) async {
      final backend =
          _Backend([
              _row('c1', name: 'a1', depth: 1, parent: _root, title: '一级'),
              _row('c2', name: 'a2', depth: 1, parent: _root, title: '二级'),
              _row('c3', name: 'a3', depth: 1, parent: _root, title: '三级'),
              _row('c4', name: 'a4', depth: 1, parent: _root, title: '四级'),
              _row('c5', name: 'a5', depth: 1, parent: _root, title: '五级'),
            ])
            ..sessionConfigDelayMs = 30
            ..sessionConfigs['c1'] = const {};
      await _mountPanel(tester, backend);
      await _settle(tester);
      expect(backend.sessionConfigMaxActive, lessThanOrEqualTo(3));
      expect(backend.sessionConfigCalls, 5);
      expect(find.byKey(const ValueKey('agent-model-c1')), findsNothing);
      expect(find.textContaining('模型 '), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Semantics：diagnostic 行不可打开（无 tap action）', (tester) async {
      final backend = _Backend([
        _row(
          'diag',
          depth: 1,
          parent: _root,
          kind: 'diagnostic',
          status: 'corrupt',
        ),
      ]);
      await _mountPanel(tester, backend);
      final semantics = tester.ensureSemantics();
      final node = tester.getSemantics(
        find.byKey(const ValueKey('agent-body-semantics-diag')),
      );
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isFalse);
      semantics.dispose();
    });

    testWidgets('降级 multiLevelUnavailable：不渲染展开区/胶囊，行体仍可打开', (tester) async {
      final backend = _Backend([
        _row('old', name: 'old-agent', depth: 1, parent: _root, title: '旧宿主'),
      ], multiLevelUnavailable: true);
      final store = await _mountPanel(tester, backend);
      expect(
        find.byKey(const ValueKey('agent-expand-old')),
        findsOneWidget,
        reason: '保留 44dp 占位布局',
      );
      expect(
        find.byKey(const ValueKey('agent-count-old')),
        findsNothing,
        reason: '降级不得渲染胶囊/展开三角形',
      );
      expect(find.textContaining('仅提供直接子代理'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('agent-body-old')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(store.sessionId, 'old');
    });
  });
}
