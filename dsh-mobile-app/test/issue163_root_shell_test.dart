// #163 P2：真实 RootScreen 未配置启动时必须保留 Drawer/连接入口，
// 首启统一走连接档案的添加/编辑表单；取消/失败不得落盘。
import 'dart:async';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/main.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _NoopApi extends Api {
  _NoopApi() : super(client: MockClient((_) async => http.Response('{}', 200)));
  final controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> eventsRaw() => controller.stream;
}

Future<void> _pumpUnconfiguredRoot(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  api.baseUrl = '';
  api.token = '';
  api.path = '/m';
  api.profileId = '';
  api.connectionGeneration = 0;
  api.hostIdentity = '';
  final manager = ConnectionManager(
    api: _NoopApi(),
    credentials: MemoryCredentialStore(),
    // 失败测试用：保存时 probe 直接失败，验证不留下半成品档案。
    probeBootstrap: (_) async => throw StateError('offline'),
  );
  store.attachConnections(manager);
  await store.loadPrefs();
  await store.markIconMigrationTipShown();
  store.sessions = [];
  store.workspaces = [];
  await tester.pumpWidget(const MaterialApp(home: RootScreen()));
  await tester.pumpAndSettle();
}

Future<void> _openDrawerConnection(WidgetTester tester, AppStore store) async {
  expect(find.byKey(const ValueKey('root-unconfigured')), findsOneWidget);
  await tester.tap(find.byIcon(Icons.menu));
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('drawer-connection')), findsOneWidget);
  await tester.tap(find.byKey(const ValueKey('drawer-connection')));
  await tester.pumpAndSettle();
  expect(find.text('连接档案'), findsOneWidget);
  expect(store.connections!.profiles, isEmpty);
}

Future<void> _openAddForm(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('connection-add')));
  await tester.pumpAndSettle();
  expect(find.text('添加电脑'), findsOneWidget);
  expect(find.byKey(const ValueKey('connection-profile-name')), findsOneWidget);
}

Future<void> _fillForm(WidgetTester tester, {required String name}) async {
  await tester.enterText(
    find.byKey(const ValueKey('connection-profile-name')),
    name,
  );
  await tester.enterText(
    find.byKey(const ValueKey('connection-profile-base')),
    'https://home.example.com',
  );
  await tester.enterText(
    find.byKey(const ValueKey('connection-profile-token')),
    'token',
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    store.onSessionsChanged = null;
    store.disposeBridge();
  });

  testWidgets('未配置启动：Drawer 连接进入统一表单，取消不落盘', (tester) async {
    await _pumpUnconfiguredRoot(tester);
    final manager = store.connections!;
    await _openDrawerConnection(tester, store);
    await _openAddForm(tester);
    await _fillForm(tester, name: '首启电脑');

    // 取消：系统返回只退出编辑器，档案/Api 都不变。
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(manager.profiles, isEmpty);
    expect(api.baseUrl, '');
    expect(api.token, '');

    // 再返回退出连接档案，回到根壳的未配置引导页（Drawer 入口仍可达）。
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('root-unconfigured')), findsOneWidget);
    expect(find.byIcon(Icons.menu), findsOneWidget);
  });

  testWidgets('未配置启动：保存失败提示且不落盘，可返回根壳', (tester) async {
    await _pumpUnconfiguredRoot(tester);
    final manager = store.connections!;
    // 从根壳按钮进入统一连接页（不依赖 Drawer 也能到）。
    await tester.tap(find.byKey(const ValueKey('root-add-computer')));
    await tester.pumpAndSettle();
    expect(find.text('连接档案'), findsOneWidget);
    await _openAddForm(tester);
    await _fillForm(tester, name: '失败电脑');

    await tester.tap(find.byKey(const ValueKey('connection-profile-save')));
    await tester.pumpAndSettle();
    expect(find.textContaining('失败'), findsWidgets);
    expect(find.text('添加电脑'), findsOneWidget, reason: '失败留在表单');
    expect(manager.profiles, isEmpty, reason: '失败不得留下半成品档案');
    expect(manager.activeProfileId, isEmpty);
    expect(api.baseUrl, '');
    expect(api.token, '');

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('连接档案'), findsOneWidget);
  });
}
