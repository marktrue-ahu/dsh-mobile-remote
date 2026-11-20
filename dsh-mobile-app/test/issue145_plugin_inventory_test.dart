// issue #145：设置 → 插件管理（只读）验收。
//
// 覆盖：清单/版本/来源/启停/健康/兼容；无写入口；旧宿主降级；空/加载/失败/重试；
// 320 / 深色 / 1.5x；Semantics 行播报。
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_inventory_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

PluginInfo plugin(
  String name, {
  String version = '1.2.3',
  PluginSource source = const PluginSource(kind: 'registry', label: '配置渠道'),
  bool enabled = true,
  bool current = false,
  PluginHealth health = const PluginHealth(state: 'ok'),
  PluginCompatibility compatibility = const PluginCompatibility(),
  Object? title,
}) => PluginInfo(
  id: name,
  name: name,
  title: title,
  packageName: name,
  version: version,
  source: source,
  enabled: enabled,
  current: current,
  health: health,
  compatibility: compatibility,
);

PluginInventory supported(List<PluginInfo> plugins) => PluginInventory(
  supported: true,
  host: const PluginInventoryHost(
    id: 'host-1234567890',
    pluginVersion: '3.3.0',
  ),
  plugins: plugins,
);

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.api.hostIdentity = 'host-1234567890';
  store.connState = 'connected';
  return store;
}

Future<void> pumpScreen(
  WidgetTester tester, {
  required Future<PluginInventory> Function() loader,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
}) async {
  final store = await makeStore();
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.forSkin(DshSkin.dsh, brightness),
      home: MediaQuery(
        data: MediaQueryData(
          size: size,
          textScaler: TextScaler.linear(textScale),
        ),
        child: PluginInventoryScreen(store: store, loader: loader),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('清单与宿主事实一致，且没有安装/升级/卸载/启停/重启入口', (tester) async {
    final semantics = tester.ensureSemantics();
    await pumpScreen(
      tester,
      loader: () async => supported([
        plugin(
          '@marktrue/dsh-mobile-remote',
          version: '3.3.0',
          title: {'zh': '移动端', 'en': 'Mobile Remote'},
          current: true,
          source: const PluginSource(kind: 'builtin', label: '内置'),
        ),
        plugin(
          'dsh-extra',
          version: '2.0.0',
          enabled: false,
          health: const PluginHealth(state: 'disabled'),
          source: const PluginSource(kind: 'git', label: 'Git'),
        ),
        plugin(
          'dsh-bad',
          version: '0.1.0',
          health: const PluginHealth(
            state: 'failed',
            reasonCode: 'incompatible-version',
          ),
          compatibility: const PluginCompatibility(
            ok: false,
            requirements: 'engines.dsh: >=0.3.0',
          ),
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('当前电脑'), findsOneWidget);
    expect(find.text('移动端'), findsOneWidget);
    expect(find.textContaining('v3.3.0'), findsOneWidget);
    expect(find.textContaining('内置'), findsOneWidget);
    expect(find.text('当前连接'), findsOneWidget);
    expect(find.text('已停用'), findsOneWidget);
    expect(find.text('不兼容'), findsOneWidget);
    expect(find.text('运行中'), findsOneWidget);
    expect(find.textContaining('engines.dsh'), findsOneWidget);
    // 只读：没有任何写操作按钮。
    for (final label in ['安装', '升级', '更新', '卸载', '启用', '停用', '重启']) {
      expect(
        find.widgetWithText(ElevatedButton, label),
        findsNothing,
        reason: '不得出现 $label 按钮',
      );
      expect(find.widgetWithText(OutlinedButton, label), findsNothing);
      expect(find.widgetWithText(TextButton, label), findsNothing);
    }
    // 行 Semantics 同时播报名、版本与状态，不只是颜色/图标。
    expect(
      find.bySemanticsLabel(RegExp(r'移动端，v3\.3\.0，运行中，当前连接')),
      findsOneWidget,
    );

    await tester.tap(find.text('dsh-bad'));
    await tester.pumpAndSettle();
    expect(find.text('只读视图：当前版本不提供安装、升级、卸载、启停或重启操作。'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('旧宿主/缺能力：整页降级且无写入口', (tester) async {
    await pumpScreen(
      tester,
      loader: () async => const PluginInventory(
        supported: false,
        reason: 'host-plugin-manager-unavailable',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('当前电脑端不支持手机端插件管理'), findsOneWidget);
    expect(find.textContaining('电脑端 DSH 设置 → 插件'), findsOneWidget);
    expect(find.text('重新检测'), findsOneWidget);
    for (final label in ['安装', '升级', '卸载', '启用', '停用', '重启']) {
      expect(find.widgetWithText(TextButton, label), findsNothing);
    }
  });

  testWidgets('加载中显示 spinner；失败可重试；空清单有独立空态', (tester) async {
    var calls = 0;
    await pumpScreen(
      tester,
      loader: () async {
        calls += 1;
        if (calls == 1) {
          await Future<void>.delayed(const Duration(milliseconds: 200));
          throw Exception('offline');
        }
        return supported([plugin('dsh-ok')]);
      },
    );
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(find.text('无法读取插件清单'), findsOneWidget);
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(find.text('dsh-ok'), findsOneWidget);

    // 空清单（连接正常）不显示安装 CTA。
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await pumpScreen(tester, loader: () async => supported([]));
    await tester.pumpAndSettle();
    expect(find.text('未读取到插件'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });

  testWidgets('320 / 深色 / 1.5x：不溢出，版本与状态仍可读', (tester) async {
    await pumpScreen(
      tester,
      size: const Size(320, 700),
      brightness: Brightness.dark,
      textScale: 1.5,
      loader: () async => supported([
        plugin(
          'dsh-very-long-plugin-name-that-needs-ellipsis',
          version: '9.9.9',
          current: true,
          health: const PluginHealth(
            state: 'failed',
            reasonCode: 'runtime-start-failed',
          ),
        ),
      ]),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.textContaining('v9.9.9'), findsOneWidget);
    expect(find.text('当前连接'), findsOneWidget);
    // 紧凑行仍可点开详情。
    await tester.tap(
      find.text('dsh-very-long-plugin-name-that-needs-ellipsis'),
    );
    await tester.pumpAndSettle();
    expect(find.text('包名'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
