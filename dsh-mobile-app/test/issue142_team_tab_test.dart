// issue #142：代理面板「团队」页（只读摘要 + 团队开关）。
//
// 覆盖：
//   - 启用态：开关、Lead/成员/任务摘要、状态文字；
//   - 关闭态：开关 + 未启用说明，不渲染成员；
//   - 旧宿主/锁定/pending/模型未定/断线：原因可见、开关不可用；
//   - 关闭二次确认；保存中 spinner；失败行内错误 + 不乐观翻转；
//   - 成员目录不可用/空成员；
//   - 320/深色/1.5x 不溢出。

import 'dart:async';
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/agent_panel.dart';
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

Map<String, dynamic> _team({
  bool supported = true,
  bool root = true,
  bool agentLive = true,
  bool enabled = false,
  bool modelSelected = true,
  bool modeKnown = true,
  bool pending = false,
  bool locked = false,
  bool canToggle = true,
  String? reason,
  List<Map<String, dynamic>> members = const [],
  bool membersAvailable = true,
  Map<String, dynamic>? tasks,
  bool tasksAvailable = true,
}) => {
  'supported': supported,
  'root': root,
  'agentLive': agentLive,
  'enabled': enabled,
  'modeKnown': modeKnown,
  'modelSelected': modelSelected,
  'pending': pending,
  'locked': locked,
  'canToggle': canToggle,
  'unavailableReason': reason,
  'lead': {'id': _root, 'title': '主会话', 'status': 'idle'},
  'members': members,
  'membersAvailable': membersAvailable,
  'membersDegraded': false,
  'tasks': tasks ?? {'total': 0, 'completed': 0, 'inProgress': 0, 'pending': 0},
  'tasksAvailable': tasksAvailable,
};

class _Backend {
  _Backend(this.team);

  Map<String, dynamic> team;
  int getCalls = 0;
  int postCalls = 0;
  Completer<http.Response>? holdPost;
  Completer<http.Response>? holdGetOnce;
  bool failPost = false;
  int? failGetStatus;
  String failGetCode = 'not-found';

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://team-tab.test'
    ..path = '/m'
    ..token = '';

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/team') {
      if (request.method == 'GET') {
        getCalls++;
        final hold = holdGetOnce;
        holdGetOnce = null;
        if (hold != null) return hold.future;
        if (failGetStatus != null) {
          return _json({'error': failGetCode}, failGetStatus!);
        }
        return _json({'ok': true, 'team': team});
      }
      postCalls++;
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      team = {...team, 'enabled': body['enabled'] == true};
      final hold = holdPost;
      holdPost = null;
      if (hold != null) return hold.future;
      if (failPost) {
        return _json({'ok': false, 'error': 'team-save-failed'}, 500);
      }
      return _json({'ok': true, 'team': team});
    }
    if (path == '/m/api/subagents') {
      return _json({'ok': true, 'subagents': <Object>[]});
    }
    return _json({'ok': true});
  }
}

Future<AppStore> _mountTeam(
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
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey<String>('agent-tab-team')));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('启用态：开关、Lead、成员状态、任务摘要齐全', (tester) async {
    final backend = _Backend(
      _team(
        enabled: true,
        members: [
          {
            'id': 'child-1',
            'name': 'reviewer',
            'title': 'Reviewer',
            'kind': 'child',
            'status': 'running',
          },
          {
            'id': 'child-2',
            'name': 'checker',
            'title': 'Checker',
            'kind': 'child',
            'status': 'inactive',
          },
        ],
        tasks: {'total': 3, 'completed': 1, 'inProgress': 1, 'pending': 1},
      ),
    );
    await _mountTeam(tester, backend);
    expect(
      find.byKey(const ValueKey('agent-team-switch-card')),
      findsOneWidget,
    );
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    expect(find.byKey(const ValueKey('agent-team-lead')), findsOneWidget);
    expect(find.textContaining('主会话'), findsWidgets);
    expect(
      find.byKey(const ValueKey('agent-team-member-child-1')),
      findsOneWidget,
    );
    expect(find.text('reviewer · child-1'), findsOneWidget);
    expect(find.text('运行中'), findsWidgets);
    expect(find.text('空闲'), findsWidgets);
    expect(find.textContaining('2 名成员 · 3 个共享任务'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('关闭态：开关关闭 + 未启用说明，不渲染成员', (tester) async {
    await _mountTeam(
      tester,
      _Backend(
        _team(
          enabled: false,
          members: [
            {
              'id': 'child-1',
              'name': 'reviewer',
              'kind': 'child',
              'status': 'running',
            },
          ],
        ),
      ),
    );
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    expect(find.byKey(const ValueKey('agent-team-off-note')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('agent-team-member-child-1')),
      findsNothing,
    );
  });

  testWidgets('旧宿主：原因可见，开关不可用且不伪造成员', (tester) async {
    final backend = _Backend(
      _team(
        supported: false,
        canToggle: false,
        reason: 'team-unavailable',
        membersAvailable: false,
        tasksAvailable: false,
      ),
    );
    await _mountTeam(tester, backend);
    expect(find.byKey(const ValueKey('agent-team-reason')), findsOneWidget);
    expect(find.textContaining('不支持团队协作'), findsOneWidget);
    expect(find.byType(Switch), findsNothing, reason: '旧宿主不渲染写操作');
    expect(backend.postCalls, 0);
  });

  testWidgets('锁定/pending/模型未定：原因可见，点击开关不写', (tester) async {
    for (final entry in [
      (_team(locked: true, canToggle: false, reason: 'team-locked'), '已锁定'),
      (_team(pending: true, canToggle: false, reason: 'team-pending'), '正在应用'),
      (
        _team(
          modelSelected: false,
          canToggle: false,
          reason: 'team-model-unselected',
        ),
        '选择模型',
      ),
    ]) {
      final backend = _Backend(entry.$1);
      await _mountTeam(tester, backend);
      expect(find.textContaining(entry.$2), findsOneWidget);
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(backend.postCalls, 0);
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  testWidgets('关闭团队：二次确认；取消不写，确认才写 false', (tester) async {
    final backend = _Backend(_team(enabled: true));
    await _mountTeam(tester, backend);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(find.text('确认停用智能体团队协作？'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(backend.postCalls, 0);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认停用'));
    await tester.pumpAndSettle();
    expect(backend.postCalls, 1);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('保存中显示 spinner，不乐观翻转；成功后更新', (tester) async {
    final backend = _Backend(_team(enabled: false));
    final hold = Completer<http.Response>();
    backend.holdPost = hold;
    await _mountTeam(tester, backend);
    await tester.tap(find.byType(Switch));
    await tester.pump();
    expect(find.byKey(const ValueKey('agent-team-saving')), findsOneWidget);
    expect(
      tester.widget<Switch>(find.byType(Switch)).value,
      isFalse,
      reason: '请求在途不得乐观翻转',
    );
    hold.complete(_json({'ok': true, 'team': _team(enabled: true)}));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('agent-team-saving')), findsNothing);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
  });

  testWidgets('保存失败：行内错误 + 开关保持原值', (tester) async {
    final backend = _Backend(_team(enabled: false))..failPost = true;
    await _mountTeam(tester, backend);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('agent-team-save-error')), findsOneWidget);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('成员目录不可用/空成员：明确说明，不伪造', (tester) async {
    await _mountTeam(
      tester,
      _Backend(_team(enabled: true, membersAvailable: false)),
    );
    expect(find.textContaining('未提供成员目录'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());

    await _mountTeam(tester, _Backend(_team(enabled: true)));
    expect(find.textContaining('暂无团队成员'), findsOneWidget);
  });

  testWidgets('旧插件 /api/team 404：映射不支持，不显示通用加载失败', (tester) async {
    final backend = _Backend(_team())..failGetStatus = 404;
    await _mountTeam(tester, backend);
    expect(find.textContaining('不支持团队协作'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-team-error')), findsNothing);
    expect(find.byType(Switch), findsNothing);
  });

  testWidgets('404 session-not-found：仍显示会话错误，不冒充旧插件降级', (tester) async {
    final backend = _Backend(_team())
      ..failGetStatus = 404
      ..failGetCode = 'session-not-found';
    await _mountTeam(tester, backend);
    expect(find.byKey(const ValueKey('agent-team-error')), findsOneWidget);
    expect(find.textContaining('会话不存在'), findsOneWidget);
  });

  testWidgets('modeKnown=false（未激活）：显式说明，不显示空态/成员', (tester) async {
    await _mountTeam(
      tester,
      _Backend(
        _team(
          enabled: true,
          modeKnown: false,
          agentLive: false,
          canToggle: false,
          reason: 'team-session-offline',
        ),
      ),
    );
    expect(find.textContaining('暂无法读取团队状态'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('agent-team-member-child-1')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('agent-team-off-note')), findsNothing);
  });

  testWidgets('乱序：save 后旧 GET 返回不得覆盖权威 enabled', (tester) async {
    final backend = _Backend(_team(enabled: false));
    await _mountTeam(tester, backend);
    final hold = Completer<http.Response>();
    backend.holdGetOnce = hold;
    // 触发一次团队 GET（AppBar 刷新），令其挂起。
    await tester.tap(find.byTooltip('刷新'));
    await tester.pump();
    // 期间切换开关：POST + 权威 GET 完成，显示 enabled=true。
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    // 旧的挂起 GET 此刻返回 stale=false：必须被代次丢弃。
    hold.complete(_json({'ok': true, 'team': _team(enabled: false)}));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      tester.widget<Switch>(find.byType(Switch)).value,
      isTrue,
      reason: '旧 GET 不得覆盖 save 后状态',
    );
  });

  testWidgets('320dp / 深色 / 1.5x：团队页不溢出', (tester) async {
    await _mountTeam(
      tester,
      _Backend(
        _team(
          enabled: true,
          members: [
            {
              'id': 'child-1',
              'name': 'reviewer',
              'kind': 'child',
              'status': 'running',
            },
          ],
        ),
      ),
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );
    expect(
      find.byKey(const ValueKey('agent-team-switch-card')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
