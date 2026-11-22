// #155：设置页 5 Tab 分组、默认/记忆、独立滚动、窄屏/大字号与 Semantics。
import 'dart:async';
import 'dart:ui' show SemanticsFlag;

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/connection_manager.dart';
import 'package:dsh_mobile_app/connection_profile.dart';
import 'package:dsh_mobile_app/credential_store.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'settings_tabs_helper.dart';

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

Future<AppStore> _connectedStore() async {
  SharedPreferences.setMockInitialValues({});
  final api = _NoopApi();
  final manager = ConnectionManager(
    api: api,
    credentials: MemoryCredentialStore(),
    probeBootstrap: (_) async => {
      'plugin': {'hostId': 'host-a'},
    },
  );
  final profile = ConnectionProfile(
    id: ConnectionProfile.newId(),
    displayName: '家里',
    baseUrls: ['https://home.example.com/m'],
  );
  manager.profiles.add(profile);
  manager.activeProfileId = profile.id;
  manager.activeProfileId = profile.id;
  final store = AppStore(apiClient: api)..attachConnections(manager);
  await store.loadPrefs();
  store.connState = 'connected';
  return store;
}

Future<AppStore> _plainStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

Future<void> _pump(
  WidgetTester tester,
  AppStore store, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: textScaler),
        child: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
        ),
      ),
    ),
  );
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('5 Tab 等分、默认连接；切换后各项归属正确', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store);
    final tabBar = tester.widget<TabBar>(find.byType(TabBar));
    expect(tabBar.tabs, hasLength(5));
    expect(tabBar.isScrollable, isFalse);
    for (final label in ['连接', '对话', '外观', '通知', '通用']) {
      expect(
        find.descendant(of: find.byType(TabBar), matching: find.text(label)),
        findsOneWidget,
      );
    }
    expect(
      find.byKey(const ValueKey('connection-settings-section')),
      findsOneWidget,
    );
    expect(find.text('主题皮肤'), findsNothing);

    await selectSettingsTab(tester, '外观');
    expect(find.text('主题皮肤'), findsOneWidget);
    expect(find.text('深色模式'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('connection-settings-section')),
      findsNothing,
    );

    await selectSettingsTab(tester, '对话');
    expect(find.text('默认权限预设'), findsOneWidget);
    expect(find.text('对话调试模式'), findsOneWidget);

    await selectSettingsTab(tester, '通知');
    expect(find.text('发送测试通知'), findsOneWidget);
    expect(find.text('后台提醒（常驻通知）'), findsOneWidget);

    await selectSettingsTab(tester, '通用');
    expect(find.text('插件管理'), findsOneWidget);
    expect(find.text('应用日志'), findsOneWidget);
    expect(find.text('环境诊断'), findsOneWidget);
    expect(find.byKey(const Key('settings-log-level')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('本次会话记住上次 Tab；连接/离线强制连接', (tester) async {
    final store = await _connectedStore();
    addTearDown(store.disposeBridge);
    await _pump(tester, store);
    await selectSettingsTab(tester, '外观');
    // 重新打开设置（模拟关闭/再进），应回到外观。
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, store);
    expect(find.text('主题皮肤'), findsOneWidget);

    // 离线时强制连接 Tab。
    store.connState = 'offline';
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, store);
    expect(
      find.byKey(const ValueKey('connection-settings-section')),
      findsOneWidget,
    );
    expect(find.text('主题皮肤'), findsNothing);
  });

  testWidgets('320×1.5 五等分不裁字；320×2.0 横向滚动', (tester) async {
    final store = await _plainStore();
    await _pump(
      tester,
      store,
      size: const Size(320, 700),
      textScaler: const TextScaler.linear(1.5),
    );
    expect(tester.widget<TabBar>(find.byType(TabBar)).isScrollable, isFalse);
    for (final label in ['连接', '对话', '外观', '通知', '通用']) {
      expect(
        find.descendant(of: find.byType(TabBar), matching: find.text(label)),
        findsOneWidget,
      );
    }
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await _pump(
      tester,
      store,
      size: const Size(320, 700),
      textScaler: const TextScaler.linear(2.0),
    );
    expect(tester.widget<TabBar>(find.byType(TabBar)).isScrollable, isTrue);
    expect(find.byType(TabBar), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('每 Tab 独立滚动位置（PageStorage）与 Semantics 选中态', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store, size: const Size(390, 500));
    await selectSettingsTab(tester, '通用');
    final list = find.byType(ListView).last;
    await tester.drag(list, const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 200));
    final before = tester
        .state<ScrollableState>(
          find.descendant(of: list, matching: find.byType(Scrollable)),
        )
        .position
        .pixels;
    expect(before, greaterThan(0));

    await selectSettingsTab(tester, '外观');
    await selectSettingsTab(tester, '通用');
    final after = tester
        .state<ScrollableState>(
          find.descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          ),
        )
        .position
        .pixels;
    expect(after, closeTo(before, 1.0), reason: '切回通用应恢复独立滚动位置');

    final semantics = tester.ensureSemantics();
    final tab = tester.getSemantics(
      find.descendant(of: find.byType(TabBar), matching: find.text('通用')),
    );
    expect(tab.getSemanticsData().hasFlag(SemanticsFlag.isSelected), isTrue);
    semantics.dispose();
  });
}
