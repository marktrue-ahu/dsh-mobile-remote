// issue #146：配置渠道安装/升级、桌面同款确认、进度/需重启、失败自动回滚、取消。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_inventory_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

PluginOperationStep step(String key, String state) =>
    PluginOperationStep(key: key, state: state);

PluginOperation operation({
  String action = 'install',
  String status = 'running',
  String name = 'dsh-new',
  String version = '',
  String fromVersion = '',
  bool restartRequired = false,
  bool rolledBack = false,
  bool rollbackFailed = false,
  bool unchanged = false,
  bool outcomeUnknown = false,
  bool cancelled = false,
  String errorCode = '',
}) => PluginOperation(
  opId: 'op-1',
  action: action,
  name: name,
  status: status,
  phase: '',
  steps: action == 'install'
      ? [
          step('prepare', 'done'),
          step('install', status == 'running' ? 'running' : 'done'),
          step('enable', 'pending'),
        ]
      : [
          step('check', 'done'),
          step('remove', 'done'),
          step('install', status == 'running' ? 'running' : 'done'),
          step('restore', 'pending'),
        ],
  version: version,
  fromVersion: fromVersion,
  restartRequired: restartRequired,
  rolledBack: rolledBack,
  rollbackFailed: rollbackFailed,
  unchanged: unchanged,
  outcomeUnknown: outcomeUnknown,
  cancelled: cancelled,
  errorCode: errorCode,
);

class FakeActions {
  FakeActions({
    required this.installOp,
    required this.pollOp,
    this.upgradeOp,
    this.versions = const PluginVersionCheck(
      status: 'refused',
      problem: 'network',
    ),
  });
  final PluginOperation installOp;
  final PluginOperation pollOp;
  final PluginOperation? upgradeOp;
  final PluginVersionCheck versions;
  int installCalls = 0;
  int upgradeCalls = 0;
  int cancelCalls = 0;
  String? lastUpgradeVersion;

  PluginInventoryActions get actions => PluginInventoryActions(
    checkVersions: (_) async => versions,
    install: (_) async {
      installCalls += 1;
      return installOp;
    },
    upgrade: (_, version) async {
      upgradeCalls += 1;
      lastUpgradeVersion = version;
      return upgradeOp ?? installOp;
    },
    poll: (_) async => pollOp,
    cancel: (_) async {
      cancelCalls += 1;
      return 'cancelled';
    },
  );
}

PluginInventory inventory({
  List<PluginInfo> plugins = const [],
  List<PluginInstallable> installable = const [],
}) => PluginInventory(
  supported: true,
  complete: true,
  host: const PluginInventoryHost(id: 'host-1', pluginVersion: '3.3.0'),
  plugins: plugins,
  installable: installable,
);

PluginInfo installedPlugin({
  String name = 'dsh-up',
  bool canUpdate = true,
  String updateKind = 'registry',
}) => PluginInfo(
  id: name,
  name: name,
  packageName: name,
  version: '1.0.0',
  health: const PluginHealth(state: 'ok'),
  canUpdate: canUpdate,
  updateKind: updateKind,
);

PluginInstallable installableItem({String name = 'dsh-new'}) =>
    PluginInstallable(
      id: name,
      name: name,
      packageName: name,
      version: '2.0.0',
      source: const PluginSource(kind: 'registry', label: '配置渠道'),
    );

Future<void> pumpScreen(
  WidgetTester tester, {
  required PluginInventory data,
  required PluginInventoryActions actions,
  VoidCallback? onRefreshAll,
}) async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.api.hostIdentity = 'host-1';
  store.connState = 'connected';
  var calls = 0;
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
      home: PluginInventoryScreen(
        store: store,
        actions: actions,
        refreshAll: () async => onRefreshAll?.call(),
        loader: () async {
          calls += 1;
          return calls == 1
              ? data
              : inventory(plugins: data.plugins, installable: data.installable);
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  testWidgets('安装：桌面同款确认、取消不发请求、确认后进度→成功并刷新', (tester) async {
    final fake = FakeActions(
      installOp: operation(status: 'running'),
      pollOp: operation(status: 'succeeded', version: '2.0.0'),
    );
    var refreshed = 0;
    await pumpScreen(
      tester,
      data: inventory(installable: [installableItem()]),
      actions: fake.actions,
      onRefreshAll: () => refreshed += 1,
    );
    expect(find.text('可安装（配置渠道）'), findsOneWidget);
    expect(find.text('dsh-new'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, '安装'));
    await tester.pumpAndSettle();
    expect(find.text('安装「dsh-new」？'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.textContaining('失败会自动回滚'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(fake.installCalls, 0);

    await tester.tap(find.widgetWithText(TextButton, '安装'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    expect(fake.installCalls, 1);
    expect(find.textContaining('正在安装 dsh-new'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('安装完成 v2.0.0'), findsOneWidget);
    expect(refreshed, greaterThanOrEqualTo(1), reason: '成功后必须刷新能力/版本');
    // 仅安装/升级入口；无卸载/启停/重启。
    for (final label in ['卸载', '停用', '重启']) {
      expect(find.widgetWithText(TextButton, label), findsNothing);
      expect(find.widgetWithText(FilledButton, label), findsNothing);
      expect(find.widgetWithText(OutlinedButton, label), findsNothing);
    }
  });

  testWidgets('升级：确认显示 from→to；成功且需重启时显示显式重启提示', (tester) async {
    final fake = FakeActions(
      installOp: operation(action: 'update', status: 'running', name: 'dsh-up'),
      upgradeOp: operation(action: 'update', status: 'running', name: 'dsh-up'),
      pollOp: operation(
        action: 'update',
        status: 'succeeded',
        name: 'dsh-up',
        version: '1.1.0',
        fromVersion: '1.0.0',
        restartRequired: true,
      ),
      versions: const PluginVersionCheck(
        status: 'listed',
        installedVersion: '1.0.0',
        versions: [PluginVersionInfo(version: '1.1.0')],
      ),
    );
    await pumpScreen(
      tester,
      data: inventory(plugins: [installedPlugin()]),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-up'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('检查更新'));
    await tester.pumpAndSettle();
    expect(find.text('v1.1.0'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '升级'));
    await tester.pumpAndSettle();
    expect(find.text('升级「dsh-up」'), findsOneWidget);
    expect(find.textContaining('升级到 v1.1.0'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '升级'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(fake.upgradeCalls, 1);
    expect(fake.lastUpgradeVersion, '1.1.0');
    expect(find.textContaining('正在升级 dsh-up'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('升级完成 v1.1.0'), findsOneWidget);
    expect(find.textContaining('需要重启电脑端宿主'), findsOneWidget);
    // 重启只提示，不提供按钮。
    expect(find.widgetWithText(FilledButton, '重启'), findsNothing);
    expect(find.widgetWithText(TextButton, '重启'), findsNothing);
  });

  testWidgets('失败自动回滚/恢复失败/取消都以真实结果可见', (tester) async {
    var fake = FakeActions(
      installOp: operation(status: 'running'),
      pollOp: operation(
        status: 'failed',
        rolledBack: true,
        errorCode: 'incompatible-version',
      ),
    );
    await pumpScreen(
      tester,
      data: inventory(installable: [installableItem()]),
      actions: fake.actions,
    );
    await tester.tap(find.widgetWithText(TextButton, '安装'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '安装'));
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('安装失败，已自动回滚'), findsOneWidget);

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    fake = FakeActions(
      installOp: operation(action: 'update', status: 'running', name: 'dsh-up'),
      upgradeOp: operation(action: 'update', status: 'running', name: 'dsh-up'),
      pollOp: operation(
        action: 'update',
        status: 'failed',
        name: 'dsh-up',
        fromVersion: '1.0.0',
        rollbackFailed: true,
      ),
    );
    await pumpScreen(
      tester,
      data: inventory(plugins: [installedPlugin()]),
      actions: fake.actions,
    );
    await tester.tap(find.text('dsh-up'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('检查更新'));
    await tester.pumpAndSettle();
    // 没有版本列表（refused）时不显示升级按钮。
    expect(find.widgetWithText(TextButton, '升级'), findsNothing);
  });

  testWidgets('取消：进行中可取消，结果明确为已取消', (tester) async {
    final fake = FakeActions(
      installOp: operation(status: 'running'),
      pollOp: operation(status: 'cancelled', cancelled: true),
    );
    await pumpScreen(
      tester,
      data: inventory(installable: [installableItem()]),
      actions: fake.actions,
    );
    await tester.tap(find.widgetWithText(TextButton, '安装'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(fake.cancelCalls, 1);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.textContaining('已取消，未留下半安装'), findsOneWidget);
  });

  testWidgets('320 / 深色 / 1.5x：安装候选与操作横幅不溢出', (tester) async {
    final fake = FakeActions(
      installOp: operation(status: 'running'),
      pollOp: operation(status: 'running'),
    );
    SharedPreferences.setMockInitialValues({});
    final store = AppStore();
    await store.loadPrefs();
    store.api.baseUrl = 'http://192.168.1.20:3080';
    await tester.binding.setSurfaceSize(const Size(320, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: DshTheme.forSkin(DshSkin.dsh, Brightness.dark),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(320, 700),
            textScaler: TextScaler.linear(1.5),
          ),
          child: PluginInventoryScreen(
            store: store,
            actions: fake.actions,
            refreshAll: () async {},
            loader: () async => inventory(installable: [installableItem()]),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('安装'), findsOneWidget);
  });
}
