// issue #147：卸载/启停/重启（显式确认；宿主事务；无静默重启）。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_inventory_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

PluginOperation op({
  String action = 'toggle',
  String status = 'running',
  String name = 'dsh-x',
  String target = 'off',
  bool restartRequired = false,
  bool outcomeUnknown = false,
  bool unchanged = false,
  String errorCode = '',
}) => PluginOperation(
  opId: 'op-1',
  action: action,
  name: name,
  targetVersion: target,
  status: status,
  steps: action == 'uninstall'
      ? [const PluginOperationStep(key: 'remove', state: 'running')]
      : [const PluginOperationStep(key: 'save', state: 'running')],
  restartRequired: restartRequired,
  outcomeUnknown: outcomeUnknown,
  unchanged: unchanged,
  errorCode: errorCode,
);

class FakeActions {
  FakeActions({
    required this.operation,
    required this.poll,
    this.restartMode = 'respawn',
  });
  final PluginOperation operation;
  final PluginOperation poll;
  final String restartMode;
  int uninstallCalls = 0;
  int toggleCalls = 0;
  int restartCalls = 0;
  bool? lastToggle;
  String? lastUninstall;

  PluginInventoryActions get actions => PluginInventoryActions(
    checkVersions: (_) async => const PluginVersionCheck(status: 'refused'),
    install: (_) async => operation,
    upgrade: (_, _) async => operation,
    uninstall: (name) async {
      uninstallCalls += 1;
      lastUninstall = name;
      return operation;
    },
    toggle: (name, enabled) async {
      toggleCalls += 1;
      lastToggle = enabled;
      return operation;
    },
    restartHost: () async {
      restartCalls += 1;
      return restartMode;
    },
    poll: (_) async => poll,
    cancel: (_) async => 'not-running',
  );
}

PluginInfo plugin({
  String name = 'dsh-x',
  bool current = false,
  bool enabled = true,
  bool canToggle = true,
  bool canUninstall = true,
  String reason = '',
}) => PluginInfo(
  id: name,
  name: name,
  packageName: name,
  version: '1.0.0',
  enabled: enabled,
  current: current,
  health: const PluginHealth(state: 'ok'),
  canToggle: canToggle,
  canUninstall: canUninstall,
  toggleReasonCode: reason,
);

PluginInventory inventory(
  List<PluginInfo> plugins, {
  bool restartSupported = true,
}) => PluginInventory(
  supported: true,
  complete: true,
  host: PluginInventoryHost(
    id: 'host-1',
    pluginVersion: '3.3.0',
    restartSupported: restartSupported,
  ),
  plugins: plugins,
);

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.connState = 'connected';
  return store;
}

Future<void> pump(
  WidgetTester tester, {
  required PluginInventory data,
  required PluginInventoryActions actions,
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
        child: PluginInventoryScreen(
          store: store,
          actions: actions,
          refreshAll: () async {},
          loader: () async => data,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  testWidgets('启停：当前连接插件二次确认；确认后宿主事务进度/结果刷新', (tester) async {
    final fake = FakeActions(
      operation: op(action: 'toggle', target: 'off', status: 'running'),
      poll: op(action: 'toggle', target: 'off', status: 'succeeded'),
    );
    await pump(
      tester,
      data: inventory([plugin(current: true)]),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    expect(find.text('切换后由宿主事务生效'), findsOneWidget);
    await tester.tap(find.byType(DshSwitch));
    await tester.pumpAndSettle();
    expect(find.text('停用当前连接插件？'), findsOneWidget);
    expect(find.textContaining('手机将断开'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(fake.toggleCalls, 0);
    // 取消后详情弹层已关闭（写操作从列表重新进入）。
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DshSwitch));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '停用'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(fake.toggleCalls, 1);
    expect(fake.lastToggle, false);
    expect(find.textContaining('正在停用 dsh-x'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('已停用 dsh-x'), findsOneWidget);
    // 启停不可取消（宿主无 cancel 语义）
    expect(find.widgetWithText(TextButton, '取消'), findsNothing);
  });

  testWidgets('卸载：当前连接强提示；成功/半卸载失败可见；不可卸载显示原因', (tester) async {
    final fake = FakeActions(
      operation: op(action: 'uninstall', status: 'running'),
      poll: op(action: 'uninstall', status: 'succeeded'),
    );
    await pump(
      tester,
      data: inventory([plugin(current: true)]),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('卸载插件'));
    await tester.pumpAndSettle();
    expect(find.text('卸载「dsh-x」？'), findsOneWidget);
    expect(find.textContaining('手机将无法再连接此电脑'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '卸载'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(fake.uninstallCalls, 1);
    expect(fake.lastUninstall, 'dsh-x');
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('已卸载 dsh-x'), findsOneWidget);

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    final bad = FakeActions(
      operation: op(action: 'uninstall', status: 'running'),
      poll: op(action: 'uninstall', status: 'failed', outcomeUnknown: true),
    );
    await pump(
      tester,
      data: inventory([
        plugin(
          canUninstall: false,
          canToggle: false,
          reason: 'management-required',
        ),
      ]),
      actions: bad.actions,
    );
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    expect(find.textContaining('不可卸载'), findsOneWidget);
    expect(find.text('插件管理所需，不能停用或卸载'), findsOneWidget);
    expect(find.text('卸载插件'), findsNothing);
  });

  testWidgets('重启：只提示 + 显式确认；取消不重启，确认后才调用', (tester) async {
    final fake = FakeActions(
      operation: op(action: 'toggle', target: 'off', status: 'running'),
      poll: op(
        action: 'toggle',
        target: 'off',
        status: 'succeeded',
        restartRequired: true,
      ),
    );
    await pump(
      tester,
      data: inventory([plugin(current: false)]),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DshSwitch));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('需要重启电脑端宿主'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '重启电脑端'), findsOneWidget);
    expect(fake.restartCalls, 0, reason: '重启绝不自动发生');

    await tester.tap(find.widgetWithText(OutlinedButton, '重启电脑端'));
    await tester.pumpAndSettle();
    expect(find.text('重启电脑端宿主？'), findsOneWidget);
    expect(find.textContaining('手机将断开连接'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(fake.restartCalls, 0);

    await tester.tap(find.widgetWithText(OutlinedButton, '重启电脑端'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '重启'));
    await tester.pumpAndSettle();
    expect(fake.restartCalls, 1);
    expect(find.textContaining('正在重启电脑端'), findsOneWidget);
  });

  testWidgets('宿主不支持重启：restartRequired 也不显示重启按钮', (tester) async {
    final fake = FakeActions(
      operation: op(action: 'toggle', target: 'off', status: 'running'),
      poll: op(
        action: 'toggle',
        target: 'off',
        status: 'succeeded',
        restartRequired: true,
      ),
    );
    await pump(
      tester,
      data: inventory([plugin(current: false)], restartSupported: false),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DshSwitch));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('需要重启电脑端宿主'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '重启电脑端'), findsNothing);
    expect(fake.restartCalls, 0);
  });

  testWidgets('320 / 深色 / 1.5x：启停与卸载入口仍可读/可点，不溢出', (tester) async {
    final fake = FakeActions(
      operation: op(action: 'toggle', target: 'off'),
      poll: op(action: 'toggle', target: 'off'),
    );
    await pump(
      tester,
      data: inventory([plugin(current: true)]),
      actions: fake.actions,
      size: const Size(320, 700),
      brightness: Brightness.dark,
      textScale: 1.5,
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('dsh-x'));
    await tester.pumpAndSettle();
    expect(find.byType(DshSwitch), findsOneWidget);
    expect(find.text('卸载插件'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
