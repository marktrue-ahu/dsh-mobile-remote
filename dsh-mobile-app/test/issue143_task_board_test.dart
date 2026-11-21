// GitLab #143：代理面板「任务板」只读列表的 widget 契约。
//
// 覆盖：状态双编码/摘要/信封（手风琴只展开一个）/owner/blockedBy 解析/不显示
// description；空、加载、失败、降级、未启用、旧宿主；320/1.5×；Semantics。
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

class _Backend {
  _Backend({
    this.tasksResponse = const {
      'ok': true,
      'supported': true,
      'enabled': true,
      'tasks': <Object>[],
    },
    this.failTaskCalls = 0,
  });

  Map<String, dynamic> tasksResponse;
  int failTaskCalls;
  int taskCalls = 0;
  Completer<http.Response>? holdTasks;

  late final Api api = Api(client: MockClient(_handle))
    ..baseUrl = 'http://task-board.test'
    ..path = '/m'
    ..token = '';

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/m/api/subagents') {
      return _json({
        'ok': true,
        'parentAvailable': true,
        'subagents': <Object>[],
      });
    }
    if (path == '/m/api/team/tasks') {
      taskCalls++;
      final hold = holdTasks;
      if (hold != null) holdTasks = null;
      if (hold != null) return hold.future;
      if (failTaskCalls > 0) {
        failTaskCalls--;
        return _json({'error': 'task-board-unavailable'}, 500);
      }
      return _json(tasksResponse);
    }
    if (path == '/m/api/history') {
      return _json({'ok': true, 'events': <Object>[], 'hasMore': false});
    }
    return _json({'ok': true});
  }
}

Map<String, dynamic> _task(
  String id, {
  required String subject,
  required String status,
  List<String> blockedBy = const [],
  bool ready = false,
  String? ownerId,
  String? ownerName,
}) => {
  'id': id,
  'subject': subject,
  'status': status,
  'blockedBy': blockedBy,
  'ready': ready,
  'ownerId': ?ownerId,
  'ownerName': ?ownerName,
};

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 80));
  }
}

int _mountSeq = 0;

Future<void> _mount(
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
          key: ValueKey('agent-panel-${_mountSeq++}'),
          store: store,
          sessionId: _root,
          title: '主会话',
          apiClient: backend.api,
        ),
      ),
    ),
  );
  await _settle(tester);
  await tester.tap(find.byKey(const ValueKey<String>('agent-tab-tasks')));
  await _settle(tester);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('团队未启用：引导启用并可切到团队页签', (tester) async {
    final backend = _Backend(
      tasksResponse: const {
        'ok': true,
        'supported': true,
        'enabled': false,
        'tasks': <Object>[],
      },
    );
    await _mount(tester, backend);

    expect(find.byKey(const ValueKey('agent-tasks-disabled')), findsOneWidget);
    expect(find.text('任务板需要先启用团队协作'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-tasks-goto-team')), findsOneWidget);
    expect(find.textContaining('将在后续版本并入本面板'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('agent-tasks-goto-team')));
    await _settle(tester);
    // #142 已把团队页做成真实 Team 卡；这里只验证切页成功。
    expect(find.byKey(const ValueKey('agent-team-switch-card')), findsOneWidget);
  });

  testWidgets('旧宿主不支持 / 启用但无任务 / 加载中', (tester) async {
    await _mount(
      tester,
      _Backend(
        tasksResponse: const {'ok': true, 'supported': false, 'tasks': <Object>[]},
      ),
    );
    expect(find.byKey(const ValueKey('agent-tasks-unsupported')), findsOneWidget);
    expect(find.text('当前电脑端不支持共享任务板'), findsOneWidget);

    await _mount(
      tester,
      _Backend(
        tasksResponse: const {
          'ok': true,
          'supported': true,
          'enabled': true,
          'tasks': <Object>[],
        },
      ),
    );
    expect(find.byKey(const ValueKey('agent-tasks-empty')), findsOneWidget);
    expect(find.text('暂无共享任务'), findsOneWidget);

    final hold = Completer<http.Response>();
    final loadingBackend = _Backend()..holdTasks = hold;
    await _mount(tester, loadingBackend);
    expect(find.byKey(const ValueKey('agent-tasks-loading')), findsOneWidget);
    hold.complete(_json({
      'ok': true,
      'supported': true,
      'enabled': true,
      'tasks': <Object>[],
    }));
    await _settle(tester);
    expect(find.byKey(const ValueKey('agent-tasks-empty')), findsOneWidget);
  });

  testWidgets('失败可重试；成功后显示真实任务', (tester) async {
    final backend = _Backend(
      failTaskCalls: 1,
      tasksResponse: {
        'ok': true,
        'supported': true,
        'enabled': true,
        'tasks': [
          _task('task-1', subject: '真实任务', status: 'pending'),
        ],
      },
    );
    await _mount(tester, backend);
    expect(find.byKey(const ValueKey('agent-tasks-error')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('agent-tasks-retry')));
    await _settle(tester);
    expect(find.text('真实任务'), findsOneWidget);
  });

  testWidgets('状态双编码、摘要、description 永不显示、手风琴只展开一个', (tester) async {
    final handle = tester.ensureSemantics();
    final backend = _Backend(
      tasksResponse: {
        'ok': true,
        'supported': true,
        'enabled': true,
        'tasks': [
          _task('t1', subject: '已完成任务', status: 'completed', ownerId: 's1', ownerName: 'lead'),
          _task('t2', subject: '进行中任务', status: 'in_progress', ownerId: 's2'),
          _task('t3', subject: '待处理任务', status: 'pending', blockedBy: ['t1', 't2']),
          _task('t4', subject: '被依赖阻塞任务', status: 'pending', blockedBy: ['missing']),
          _task('t6', subject: '可认领待处理任务', status: 'pending', ready: true),
          // 服务端应过滤 deleted；这里再放一条验证客户端模型也不会显示未知状态。
          _task('t5', subject: '不应显示', status: 'deleted'),
        ],
        'description': 'THIS MUST NEVER RENDER',
      },
    );
    await _mount(tester, backend);

    expect(find.text('已完成任务'), findsOneWidget);
    expect(find.text('进行中任务'), findsOneWidget);
    expect(find.text('待处理任务'), findsOneWidget);
    expect(find.text('被依赖阻塞任务'), findsOneWidget);
    expect(find.text('不应显示'), findsNothing);
    expect(find.textContaining('THIS MUST NEVER RENDER'), findsNothing);
    expect(find.text('1 已完成 · 1 进行中 · 3 待处理'), findsOneWidget);

    // 双编码：图标 + 文字都在。
    expect(find.text('已完成'), findsOneWidget);
    expect(find.text('进行中'), findsOneWidget);
    expect(find.text('待处理'), findsOneWidget);
    expect(find.text('被依赖阻塞'), findsNWidgets(2));
    expect(find.byIcon(Icons.check_circle), findsOneWidget);
    expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
    expect(find.byIcon(Icons.block), findsNWidgets(2));

    // 展开 t1：owner 显示 lead；再次点开其他任务时只保留一个展开。
    await tester.tap(find.byKey(const ValueKey('agent-task-t1')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('agent-task-details-t1')), findsOneWidget);
    expect(find.text('lead'), findsOneWidget);
    // 展开 t3：owner 未分配；依赖解析 subject。
    await tester.tap(find.byKey(const ValueKey('agent-task-t3')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('agent-task-details-t3')), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-task-details-t1')), findsNothing);
    expect(find.text('已完成任务、进行中任务'), findsOneWidget);
    expect(find.text('未分配'), findsOneWidget);
    // 展开 t4：未知依赖显示短 id + 已删除。
    await tester.tap(find.byKey(const ValueKey('agent-task-t4')));
    await _settle(tester);
    expect(find.byKey(const ValueKey('agent-task-details-t4')), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-task-details-t3')), findsNothing);
    expect(find.text('missing（已删除）'), findsOneWidget);

    // Semantics：subject + 状态 + 展开状态。
    expect(
      find.bySemanticsLabel(RegExp('已完成任务.*已完成')),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('降级：failure 保留已有效任务并显式提示', (tester) async {
    final backend = _Backend(
      tasksResponse: {
        'ok': true,
        'supported': true,
        'enabled': true,
        'failure': 'checkpoint 损坏',
        'tasks': [
          _task('t1', subject: '仍然有效的任务', status: 'in_progress'),
        ],
      },
    );
    await _mount(tester, backend);
    expect(find.byKey(const ValueKey('agent-tasks-degraded')), findsOneWidget);
    expect(find.textContaining('任务记录无效：checkpoint 损坏'), findsOneWidget);
    expect(find.text('仍然有效的任务'), findsOneWidget);
  });

  testWidgets('320 / 1.5× / 深色：长文本不溢出', (tester) async {
    final backend = _Backend(
      tasksResponse: {
        'ok': true,
        'supported': true,
        'enabled': true,
        'tasks': [
          _task(
            't1',
            subject: '这是一个非常长的任务标题，用于验证 320 宽 1.5 倍字号下最多两行省略且行尾状态不压缩',
            status: 'in_progress',
          ),
          _task('t2', subject: '已完成', status: 'completed'),
        ],
      },
    );
    await _mount(
      tester,
      backend,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );
    expect(find.byKey(const ValueKey('agent-tasks-board')), findsOneWidget);
    expect(find.textContaining('这是一个非常长的任务标题'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('只读：没有创建/编辑/完成等写操作按钮', (tester) async {
    final backend = _Backend(
      tasksResponse: {
        'ok': true,
        'supported': true,
        'enabled': true,
        'tasks': [_task('t1', subject: '任务', status: 'pending')],
      },
    );
    await _mount(tester, backend);
    for (final label in ['新建任务', '创建任务', '编辑任务', '完成任务', '分配任务']) {
      expect(find.text(label), findsNothing);
    }
    expect(find.byIcon(Icons.add), findsNothing);
    expect(find.byType(Checkbox), findsNothing);
  });
}
