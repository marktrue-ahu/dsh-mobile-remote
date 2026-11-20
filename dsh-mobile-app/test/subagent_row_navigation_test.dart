// issue #141：子代理行在独立「代理」面板中的诊断文案与跳转语义。
//
// 历史（#11 复核补正）：子代理行可点 → 跳到该子代理会话；从子会话返回时恢复原会话
// （顺路看一眼，不改主会话）。#141 把入口从「会话工具」移到代理面板，本文件跟随迁移。

import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/screens/agent_panel.dart';
import 'package:dsh_mobile_app/screens/chat_screen.dart';
import 'package:dsh_mobile_app/screens/session_tools_sheet.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const parentId = 'session-parent';
const childId = 'child-abc';

http.Response _json(Map<String, dynamic> body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Api _fakeApi() =>
    Api(
        client: MockClient((request) async {
          if (request.url.path == '/m/api/subagents') {
            return _json({
              'ok': true,
              'parentAvailable': true,
              'subagents': [
                {
                  'id': childId,
                  'name': 'reviewer',
                  'depth': 1,
                  'parentSessionId': parentId,
                  'title': 'Audit app core and UI',
                  'kind': 'child',
                  'status': 'inactive',
                },
              ],
            });
          }
          if (request.url.path == '/m/api/history') {
            return _json({'ok': true, 'events': <Object>[], 'hasMore': false});
          }
          return _json({'ok': true});
        }),
      )
      ..baseUrl = 'http://subagent.test'
      ..path = '/m'
      ..token = '';

Api _diagnosticApi() =>
    Api(
        client: MockClient((request) async {
          if (request.url.path == '/m/api/subagents') {
            return _json({
              'ok': true,
              'subagents': [
                {
                  'id': 'diag-u',
                  'kind': 'diagnostic',
                  'status': 'unsupported',
                  'title': 'U',
                  'depth': 1,
                  'parentSessionId': parentId,
                },
                {
                  'id': 'diag-c',
                  'kind': 'diagnostic',
                  'status': 'corrupt',
                  'title': 'C',
                  'depth': 1,
                  'parentSessionId': parentId,
                },
                {
                  'id': 'diag-a',
                  'kind': 'diagnostic',
                  'status': 'unavailable',
                  'title': 'A',
                  'depth': 1,
                  'parentSessionId': parentId,
                },
              ],
            });
          }
          return _json({'ok': true});
        }),
      )
      ..baseUrl = 'http://subagent.test'
      ..path = '/m'
      ..token = '';

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 80));
  }
}

Future<AppStore> _mountPanel(WidgetTester tester, Api api) async {
  final store = AppStore()
    ..sessionId = parentId
    ..sessions = [Session(id: parentId, title: 'P', cwd: null, createdAt: 1)];
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.light(),
      home: AgentPanelScreen(
        store: store,
        sessionId: parentId,
        title: 'P',
        apiClient: api,
      ),
    ),
  );
  await _settle(tester);
  return store;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('issue #87/#141：diagnostic 三枚举在代理面板有明确文案', (tester) async {
    await _mountPanel(tester, _diagnosticApi());
    expect(find.textContaining('不受支持的子代理'), findsOneWidget);
    expect(find.textContaining('目录数据损坏'), findsOneWidget);
    expect(find.textContaining('目录不可用'), findsOneWidget);
  });

  testWidgets('点子代理行 → 切到该子代理会话，返回后恢复原会话', (tester) async {
    final api = _fakeApi();
    final store = await _mountPanel(tester, api);
    expect(find.text('Audit app core and UI'), findsOneWidget);
    expect(store.sessionId, parentId, reason: '打开面板本身不应切换会话');

    await tester.tap(find.text('Audit app core and UI'));
    await _settle(tester);
    expect(store.sessionId, childId, reason: '点子代理行应切到该子会话');
    expect(find.byType(ChatScreen), findsOneWidget, reason: '应推入子会话的会话页');

    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await _settle(tester);
    expect(store.sessionId, parentId, reason: '从子代理会话返回后必须恢复原会话');
  });

  testWidgets('会话工具不再有子代理页签（入口已迁到代理面板）', (tester) async {
    final store = AppStore()
      ..sessionId = parentId
      ..sessions = [Session(id: parentId, title: 'P', cwd: null, createdAt: 1)];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (ctx) => TextButton(
              onPressed: () => showSessionToolsSheet(
                ctx,
                store,
                parentId,
                apiClient: _fakeApi(),
              ),
              child: const Text('open-sheet'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open-sheet'));
    await _settle(tester);
    expect(find.text('会话工具'), findsOneWidget);
    expect(find.byType(Tab), findsNWidgets(2));
    expect(find.text('子代理'), findsNothing);
  });
}
