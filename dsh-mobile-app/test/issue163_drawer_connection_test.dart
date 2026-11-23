// #163：连接入口从设置页移到首页 Drawer；无主机也常驻，点击进入连接档案。
import 'dart:async';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/main.dart';
import 'package:dsh_mobile_app/screens/connection_profiles_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _NoopApi extends Api {
  _NoopApi()
    : super(
        client: MockClient(
          (_) async => http.Response(
            '{"ok":true,"sessions":[],"events":[]}',
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

  final controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> eventsRaw() => controller.stream;
}

Future<AppStore> _store({bool withHost = false}) async {
  SharedPreferences.setMockInitialValues({});
  final api = _NoopApi();
  final manager = ConnectionManager(
    api: api,
    credentials: MemoryCredentialStore(),
    probeBootstrap: (_) async => {
      'plugin': {'hostId': 'host-a'},
    },
  );
  if (withHost) {
    final profile = ConnectionProfile(
      id: ConnectionProfile.newId(),
      displayName: '家里',
      baseUrls: ['https://home.example.com/m'],
    );
    manager.profiles.add(profile);
    manager.activeProfileId = profile.id;
  }
  final store = AppStore(apiClient: api)..attachConnections(manager);
  await store.loadPrefs();
  return store;
}

class _Harness {
  int selected = -1;
  int openedConnections = 0;
  int newSessions = 0;
  final scaffold = GlobalKey<ScaffoldState>();
}

Future<_Harness> _pumpDrawer(
  WidgetTester tester,
  AppStore store, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final harness = _Harness();
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: textScaler),
        child: Scaffold(
          key: harness.scaffold,
          drawer: AppDrawer(
            store: store,
            selectedIndex: 0,
            onSelect: (index) => harness.selected = index,
            onNewSession: () => harness.newSessions++,
            onOpenConnections: () => harness.openedConnections++,
          ),
          body: const Text('body'),
        ),
      ),
    ),
  );
  harness.scaffold.currentState!.openDrawer();
  await tester.pumpAndSettle();
  return harness;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  _issue168Tests();

  testWidgets('无主机时 Drawer 显示带图标的「连接」，点击进入连接入口', (tester) async {
    final store = await _store(withHost: false);
    addTearDown(store.disposeBridge);
    final harness = await _pumpDrawer(tester, store);

    final entry = find.byKey(const ValueKey('drawer-connection'));
    expect(entry, findsOneWidget);
    expect(find.text('连接'), findsOneWidget);
    // issue #168：补齐图标，与「首页」「会话」「插件」「设置」一级入口一致。
    // 仍不显示主机摘要文字（那是 #163 的既有约束）。
    final icon = find.descendant(of: entry, matching: find.byType(Icon));
    expect(icon, findsOneWidget, reason: '一级入口必须有图标');
    expect(tester.widget<Icon>(icon).size, 20, reason: '图标尺寸与兄弟项一致');
    final entrySize = tester.getSize(entry);
    expect(entrySize.height, greaterThanOrEqualTo(44));
    expect(entrySize.width, greaterThanOrEqualTo(44));
    final semantics = tester.ensureSemantics();
    expect(find.bySemanticsLabel(RegExp(r'^连接$')), findsOneWidget);
    semantics.dispose();

    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(harness.openedConnections, 1);
    expect(harness.scaffold.currentState!.isDrawerOpen, isFalse);
  });

  testWidgets('有主机时入口仍在，且不显示主机摘要文字', (tester) async {
    final store = await _store(withHost: true);
    addTearDown(store.disposeBridge);
    await _pumpDrawer(tester, store);

    expect(find.byKey(const ValueKey('drawer-connection')), findsOneWidget);
    expect(find.text('连接'), findsOneWidget);
    expect(find.text('家里'), findsNothing);
  });

  testWidgets('无主机时连接档案页仍可进入添加电脑表单', (tester) async {
    final store = await _store(withHost: false);
    addTearDown(store.disposeBridge);
    await tester.pumpWidget(
      MaterialApp(home: ConnectionProfilesScreen(store: store)),
    );
    await tester.pumpAndSettle();
    expect(find.text('连接档案'), findsOneWidget);
    expect(find.byKey(const ValueKey('connection-add')), findsOneWidget);
    expect(find.textContaining('还没有连接电脑'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('connection-add')));
    await tester.pumpAndSettle();
    expect(find.text('添加电脑'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('connection-profile-name')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 / 1.5× / 深色 Drawer 不溢出，入口命中 ≥44', (tester) async {
    final store = await _store(withHost: false);
    addTearDown(store.disposeBridge);
    await _pumpDrawer(
      tester,
      store,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );
    final entry = find.byKey(const ValueKey('drawer-connection'));
    expect(entry, findsOneWidget);
    expect(tester.getSize(entry).height, greaterThanOrEqualTo(44));
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 / 2.0× + 多工作区：抽屉可滚到连接/设置且无 overflow', (
    tester,
  ) async {
    final store = await _store(withHost: false);
    addTearDown(store.disposeBridge);
    store.workspaces = [
      {'path': '/work/one', 'title': '项目一'},
      {'path': '/work/two', 'title': '项目二'},
      {'path': '/work/three', 'title': '项目三'},
    ];
    await _pumpDrawer(
      tester,
      store,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(2.0),
      theme: DshTheme.dark(),
    );
    final scrollable = find.descendant(
      of: find.byType(Drawer),
      matching: find.byType(Scrollable),
    );
    expect(scrollable, findsOneWidget);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('drawer-connection')),
      120,
      scrollable: scrollable,
    );
    expect(find.byKey(const ValueKey('drawer-connection')), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('设置'),
      120,
      scrollable: scrollable,
    );
    expect(find.text('设置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 / 2.0× Drawer 不溢出', (tester) async {
    final store = await _store(withHost: false);
    addTearDown(store.disposeBridge);
    await _pumpDrawer(
      tester,
      store,
      size: const Size(320, 640),
      textScaler: const TextScaler.linear(2.0),
      theme: DshTheme.dark(),
    );
    expect(find.byKey(const ValueKey('drawer-connection')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

// ── issue #168：「连接」补齐图标后与兄弟一级入口视觉对齐 ────────────────────
void _issue168Tests() {
  testWidgets('#168「连接」与「插件」「首页」的一级入口图标/间距一致', (tester) async {
    final store = await _store(withHost: true);
    addTearDown(store.disposeBridge);
    await _pumpDrawer(tester, store);

    final connection = find.byKey(const ValueKey('drawer-connection'));
    expect(connection, findsOneWidget);
    // 该 harness 不注入 onOpenPlugins，「插件」按设计不渲染；用「首页」作图标尺寸对照。
    final siblings = [connection];

    // 「连接」不是 Tab：不得出现选中底色（动作型入口）。
    final container = tester.widget<Container>(
      find.descendant(of: connection, matching: find.byType(Container)).first,
    );
    final decoration = container.decoration as BoxDecoration?;
    expect(decoration?.color, isNull, reason: '动作型入口不应有选中底色');

    // 「连接」图标与兄弟一级入口同尺寸（20dp）。
    final icon = find.descendant(of: connection, matching: find.byType(Icon));
    expect(icon, findsOneWidget, reason: '一级入口必须有图标');
    expect(tester.widget<Icon>(icon).size, 20, reason: '与兄弟项一致');
    final homeIcon = find.descendant(
      of: find.byKey(const ValueKey('drawer-home')),
      matching: find.byType(Icon),
    );
    if (homeIcon.evaluate().isNotEmpty) {
      expect(tester.widget<Icon>(homeIcon).size, 20);
    }
    expect(siblings, isNotEmpty);

    // 命中高度 ≥44（可点区域不缩小）。
    expect(tester.getSize(connection).height, greaterThanOrEqualTo(44));

    // 点击仍关闭抽屉并进入连接页。
    await tester.tap(connection);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('drawer-connection')), findsNothing);
  });
}
