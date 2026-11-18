// issue #123 审查 P2（第 3 项）：#116 的**重启指引被英文日志遮盖**。
//
// 审查报告描述（外部 widget 探针，按描述重建）：
//   SettingsScreen 初始处于 installing（in-flight）→ 首个 `/api/bootstrap` 轮询
//   就返回 `phase=failed` + `nextAction=restart-host` + `hostErrorCode=stop-profile`，
//   且 `/api/plugin-update/log` 返回**非空英文日志行**；
//   期望失败卡显示「先重启 DSH」，实际 `_updateProgressCard` 的 `detailLine`
//   优先取 `_progressLine`（英文日志），把可执行原因盖掉；
//   又因 `_lastProgressPhase` 初始为空，`_announceProgressTransition` 跳过 toast，
//   于是用户不点详情就完全看不到「要重启」。
//
// 本文件断言（修复前必须失败）：
//   1. 失败卡**主行**是映射后的可执行原因（含「先重启 DSH」）；
//   2. 英文日志行降为次级：仍可见，但排在主行下方（priority 由渲染顺序表达）；
//   3. 不自动重启/不自动重试：只发 bootstrap + log 拉取，不 POST 任何更新动作；
//   4. 旧插件（无 nextAction/hostErrorCode）兼容：失败卡仍显示既有 reason 文案。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue123_p3_settings_restart_hint_test.dart

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/notify_diag.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 日志里的英文行（后端失败路径实际写入的那种输出）。
const _logLine = 'host-manager: rejecting update (code=stop-profile)';

const _opId = 'op-123';

/// 安装中（in-flight）的事务：SettingsScreen 挂载后立即开始轮询。
Map<String, dynamic> _installingBootstrap() => {
  'pluginUpdate': {
    'state': 'update-available',
    'reason': 'newer-remote',
    'canSelfUpdate': true,
    'transaction': {
      'opId': _opId,
      'phase': 'installing',
      'targetVersion': '3.2.5',
      'targetContentSha256': 'abc123',
      'rolledBack': false,
    },
  },
};

/// 首个轮询返回的失败事务：host 拒绝并要求先重启 DSH。
Map<String, dynamic> _failedBootstrap({
  bool includeNextAction = true,
}) => {
  'pluginUpdate': {
    'state': 'update-failed',
    'reason': 'host-manager-rejected',
    'canSelfUpdate': true,
    if (includeNextAction) ...{
      'hostErrorCode': 'stop-profile',
      'nextAction': 'restart-host',
    },
    'transaction': {
      'opId': _opId,
      'phase': 'failed',
      'targetVersion': '3.2.5',
      'targetContentSha256': 'abc123',
      'rolledBack': false,
      'result': {
        'ok': false,
        'reason': 'host-manager-rejected',
        if (includeNextAction) ...{
          'hostErrorCode': 'stop-profile',
          'nextAction': 'restart-host',
        },
      },
    },
  },
};

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 记录所有请求，供「不自动重启/不自动重试」断言。
class _Recorder {
  final List<String> calls = [];
}

Future<AppStore> _pumpSettings(
  WidgetTester tester,
  Api api, {
  Size size = const Size(420, 2400),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final store = AppStore(apiClient: api);
  await store.loadPrefs();
  addTearDown(store.dispose);
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: SettingsScreen(store: store, onReconfigure: () async {}))),
  );
  // initState 立即触发一次 _pollUpdateProgress；两帧让 setState 落地。
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pumpAndSettle();
  return store;
}

Finder get _failureTitle => find.textContaining('最近一次插件更新：失败');
Finder get _restartHint => find.textContaining('先重启 DSH');
Finder get _logFinder => find.textContaining('rejecting update');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NotifyDiag.notificationsEnabled = true;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dsh/floating'),
          (call) async => false,
        );
  });

  testWidgets('P3 首次轮询即 failed：失败卡主行必须是「先重启 DSH」，英文日志降为次级', (
    tester,
  ) async {
    final recorder = _Recorder();
    final api = Api(
      client: MockClient((request) async {
        recorder.calls.add('${request.method} ${request.url.path}');
        final path = request.url.path;
        if (path.endsWith('/api/bootstrap')) {
          return _json(_failedBootstrap());
        }
        if (path.endsWith('/api/plugin-update/log')) {
          return _json({
            'ok': true,
            'opId': _opId,
            'phase': 'failed',
            'events': [
              {
                'seq': 1,
                'stage': 'failed',
                'stream': 'stderr',
                'text': _logLine,
              },
            ],
          });
        }
        return _json({'ok': true});
      }),
    )
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    // 关键前提：SettingsScreen 初始状态是 installing（在飞事务）。
    api.absorbBootstrap(_installingBootstrap());
    expect(
      api.pluginUpdate.transaction?.phase,
      'installing',
      reason: '夹具前提：初始必须是安装中的在飞事务',
    );

    final store = await _pumpSettings(tester, api);

    // 前提：首个轮询把事务推进到 failed，并且日志里确实有一行英文输出。
    expect(
      store.api.pluginUpdate.transaction?.phase,
      'failed',
      reason: '首个 bootstrap 轮询必须把事务推进到 failed（否则测的不是该路径）',
    );
    expect(_failureTitle, findsOneWidget, reason: '失败卡必须出现');

    // 1) 主行：映射后的可执行原因（修复前这里是英文日志 → 红）。
    expect(
      _restartHint,
      findsOneWidget,
      reason: '失败卡必须直接显示「先重启 DSH」：nextAction=restart-host 是唯一可执行动作，'
          '不能要求用户先点详情/等 toast',
    );

    // 2) 英文日志不得占据主行：日志行仍可见，但必须排在主行**下方**（次级/详情）。
    final hintRect = tester.getRect(_restartHint);
    final logRects = _logFinder.evaluate().isEmpty
        ? const <Rect>[]
        : [_logFinder].map(tester.getRect).toList();
    for (final logRect in logRects) {
      expect(
        logRect.top,
        greaterThanOrEqualTo(hintRect.bottom - 0.5),
        reason: '英文日志是次级信息，必须排在可执行原因下方（log=$logRect hint=$hintRect）',
      );
    }

    // 3) 不自动重启/不自动重试：只允许读 bootstrap 与日志，不得 POST 更新动作。
    expect(
      recorder.calls.where((c) => c.startsWith('POST')).toList(),
      isEmpty,
      reason: '失败卡不得自动触发更新/重启（本次只允许只读轮询）：${recorder.calls}',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('P3 兼容：旧插件无 nextAction/hostErrorCode → 失败卡仍显示既有 reason 文案', (
    tester,
  ) async {
    final api = Api(
      client: MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/api/bootstrap')) {
          return _json(_failedBootstrap(includeNextAction: false));
        }
        if (path.endsWith('/api/plugin-update/log')) {
          return _json({
            'ok': true,
            'opId': _opId,
            'phase': 'failed',
            'events': [
              {
                'seq': 1,
                'stage': 'failed',
                'stream': 'stderr',
                'text': _logLine,
              },
            ],
          });
        }
        return _json({'ok': true});
      }),
    )
      ..baseUrl = 'http://host:3080'
      ..path = '/m'
      ..token = 'tok';
    api.absorbBootstrap(_installingBootstrap());
    await _pumpSettings(tester, api);

    expect(_failureTitle, findsOneWidget);
    // 旧插件没有可执行动作：回退到 reason 码本身（既有兼容行为，不能变成空白）。
    expect(
      find.textContaining('host-manager-rejected'),
      findsWidgets,
      reason: '旧插件失败卡必须继续显示 reason（兼容行为不变，不得只在详情里）',
    );
    expect(tester.takeException(), isNull);
  });
}
