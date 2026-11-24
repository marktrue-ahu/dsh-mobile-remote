// issue #174：插件页三个真机验收问题。
//
//   1. AppBar「检查全部更新」与「刷新清单」图标形状太像 → 换图标 + 区分层级；
//   2. 详情页没复用列表已有的扫描结果 → 点开还要再检查一次；
//   3. 升级成功后该行仍显示「可更新」→ 操作终态只失效**该插件**的扫描结果。
//
// 第 3 项的负例是重点：失效必须**只**作用于该插件，其他插件的扫描结果不得被清空。
import 'dart:async';

import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_inventory_screen.dart';
import 'package:dsh_mobile_app/screens/plugin_update_scan.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

PluginInfo plugin(
  String name, {
  bool canUpdate = true,
  String updateKind = 'registry',
  String version = '1.0.0',
  bool canUninstall = true,
  bool canToggle = true,
  String category = 'builtin',
}) => PluginInfo(
  id: name,
  name: name,
  packageName: name,
  version: version,
  health: const PluginHealth(state: 'ok'),
  canUpdate: canUpdate,
  updateKind: updateKind,
  canUninstall: canUninstall,
  canToggle: canToggle,
  category: PluginCategory(kind: category, label: ''),
  hasCategory: true,
);

PluginInventory inventory(List<PluginInfo> plugins) => PluginInventory(
  supported: true,
  complete: true,
  host: const PluginInventoryHost(id: 'host-1', pluginVersion: '3.3.1'),
  plugins: plugins,
  classification: const PluginClassification(
    tableVersion: '2026.11',
    targetDsh: '0.2.2',
    dshVersion: '0.2.2-rc.5',
    matched: true,
    source: 'static-table',
  ),
);

PluginVersionCheck listed(String latest, {String installed = '1.0.0'}) =>
    PluginVersionCheck(
      status: 'listed',
      installedVersion: installed,
      answeredRegistry: 'https://registry.npmjs.org/',
      versions: [PluginVersionInfo(version: latest)],
    );

const PluginVersionCheck uptodate = PluginVersionCheck(
  status: 'listed',
  installedVersion: '1.0.0',
  versions: [],
);

PluginOperation operation({
  String action = 'update',
  String status = 'running',
  String name = 'dsh-up',
  String version = '',
  String fromVersion = '',
  bool rolledBack = false,
  bool outcomeUnknown = false,
}) => PluginOperation(
  opId: 'op-1',
  action: action,
  name: name,
  status: status,
  version: version,
  fromVersion: fromVersion,
  rolledBack: rolledBack,
  outcomeUnknown: outcomeUnknown,
);

/// 固定返回值的动作集合；记录调用次数供断言。
class FakeActions {
  FakeActions({
    this.versionCheck,
    this.upgradeStatus = 'succeeded',
    this.upgradeRolledBack = false,
    this.upgradeOutcomeUnknown = false,
    this.uninstallStatus = 'succeeded',
    this.toggleStatus = 'succeeded',
  });

  final PluginVersionCheck? versionCheck;
  final String upgradeStatus;
  final bool upgradeRolledBack;
  final bool upgradeOutcomeUnknown;
  final String uninstallStatus;
  final String toggleStatus;

  int checkCalls = 0;
  int upgradeCalls = 0;
  int uninstallCalls = 0;
  int toggleCalls = 0;
  int installCalls = 0;
  String? lastUpgradeName;
  String? lastUpgradeVersion;
  String? lastUninstallName;

  /// 每次升级成功后回调（测试用它改清单版本，模拟宿主已升到新版本）。
  void Function(String name, String version)? onUpgraded;

  PluginInventoryActions get actions => PluginInventoryActions(
    checkVersions: (name) async {
      checkCalls += 1;
      return versionCheck ?? uptodate;
    },
    install: (name) async {
      installCalls += 1;
      return operation(action: 'install', name: name, status: 'succeeded');
    },
    upgrade: (name, version) async {
      upgradeCalls += 1;
      lastUpgradeName = name;
      lastUpgradeVersion = version;
      return operation(
        action: 'update',
        name: name,
        status: 'running',
        fromVersion: '1.0.0',
      );
    },
    uninstall: (name) async {
      uninstallCalls += 1;
      lastUninstallName = name;
      return operation(
        action: 'uninstall',
        name: name,
        status: 'running',
      );
    },
    toggle: (name, enabled) async {
      toggleCalls += 1;
      return operation(
        action: 'toggle',
        name: name,
        status: 'running',
        version: enabled ? 'on' : 'off',
      );
    },
    restartHost: () async => '',
    poll: (opId) async {
      if (upgradeStatus == 'running') {
        return operation(action: 'update', status: 'running');
      }
      if (upgradeOutcomeUnknown) {
        return operation(
          action: 'update',
          status: 'failed',
          outcomeUnknown: true,
        );
      }
      return operation(
        action: 'update',
        status: upgradeStatus,
        version: '2.0.0',
        fromVersion: '1.0.0',
        rolledBack: upgradeRolledBack,
      );
    },
    cancel: (opId) async => 'cancelled',
  );
}

Future<void> pumpScreen(
  WidgetTester tester, {
  required Future<PluginInventory> Function() loader,
  required PluginInventoryActions actions,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
}) async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.connState = 'connected';
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.forSkin(DshSkin.dsh, brightness),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: TextScaler.linear(textScale)),
        child: PluginInventoryScreen(
          store: store,
          actions: actions,
          refreshAll: () async {},
          loader: loader,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _iconIn(String key, IconData icon) => find.descendant(
  of: find.byKey(ValueKey(key)),
  matching: find.byIcon(icon),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  // ---------------------------------------------------------------- 修复 1
  group('1. AppBar：两个动作可一眼区分', () {
    testWidgets('宽屏：检查全部更新=system_update_alt 且是主按钮，刷新=refresh 纯图标',
        (tester) async {
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        loader: () async => data,
        actions: FakeActions().actions,
      );

      // 「检查全部更新」用与详情页一致的 system_update_alt，且带 tonal 底色（主层级）。
      expect(_iconIn('plugin-check-all', Icons.system_update_alt), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is FilledButton &&
              widget.key == const ValueKey('plugin-check-all'),
        ),
        findsOneWidget,
        reason: '主要动作要有比纯图标更强的视觉层级',
      );
      // 「刷新清单」仍是次要的纯图标动作。
      expect(_iconIn('plugin-refresh', Icons.refresh), findsOneWidget);
      expect(find.widgetWithIcon(IconButton, Icons.refresh), findsOneWidget);
      // 旧的圆形同步箭头不再出现在本页（两个动作不再同形）。
      expect(find.byIcon(Icons.sync), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('窄屏 320：都退化为图标，但图标不同、各自动作仍可用', (tester) async {
      final fake = FakeActions(versionCheck: uptodate);
      var loads = 0;
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        size: const Size(320, 844),
        loader: () async {
          loads += 1;
          return data;
        },
        actions: fake.actions,
      );

      expect(_iconIn('plugin-check-all', Icons.system_update_alt), findsOneWidget);
      expect(_iconIn('plugin-refresh', Icons.refresh), findsOneWidget);
      expect(find.byIcon(Icons.sync), findsNothing, reason: '窄屏同样不得保留旧图标');
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is IconButton &&
              widget.key == const ValueKey('plugin-check-all'),
        ),
        findsOneWidget,
      );

      // 行为不变：刷新=重拉清单；检查=发版本检查（且不安装）。
      final before = loads;
      await tester.tap(find.byKey(const ValueKey('plugin-refresh')));
      await tester.pumpAndSettle();
      expect(loads, before + 1, reason: '刷新行为不变');

      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(fake.checkCalls, 1, reason: '检查全部更新行为不变');
      expect(fake.installCalls, 0);
      expect(fake.upgradeCalls, 0);
      expect(tester.takeException(), isNull);
    });

    testWidgets('深色 390：两个图标仍不同且不溢出', (tester) async {
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        brightness: Brightness.dark,
        loader: () async => data,
        actions: FakeActions().actions,
      );
      expect(_iconIn('plugin-check-all', Icons.system_update_alt), findsOneWidget);
      expect(_iconIn('plugin-refresh', Icons.refresh), findsOneWidget);
      expect(find.byIcon(Icons.sync), findsNothing);
      expect(tester.takeException(), isNull);
    });

    for (final config in [
      (const Size(320, 844), 1.5, '320/1.5x'),
      (const Size(320, 844), 2.0, '320/2.0x'),
    ]) {
      testWidgets('${config.$3}：AppBar 两动作不溢出', (tester) async {
        final data = inventory([plugin('dsh-up')]);
        await pumpScreen(
          tester,
          size: config.$1,
          textScale: config.$2,
          loader: () async => data,
          actions: FakeActions().actions,
        );
        expect(find.byKey(const ValueKey('plugin-check-all')), findsOneWidget);
        expect(find.byKey(const ValueKey('plugin-refresh')), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });

  // ---------------------------------------------------------------- 修复 2
  group('2. 详情页复用列表已拿到的扫描结果', () {
    testWidgets('列表显示「可更新 v2.0.0」→ 详情页直接给「升级到 v2.0.0」，不再检查',
        (tester) async {
      final fake = FakeActions(versionCheck: listed('2.0.0'));
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        loader: () async => data,
        actions: fake.actions,
      );

      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(find.textContaining('可更新 v2.0.0'), findsOneWidget);
      expect(fake.checkCalls, 1);

      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();

      // 关键断言：打开详情后**直接**有升级入口，且没有触发第二次检查。
      expect(find.byKey(const ValueKey('plugin-detail-upgrade')), findsOneWidget);
      expect(find.text('升级到 v2.0.0'), findsOneWidget);
      expect(find.text('检查更新'), findsNothing, reason: '不再要求用户二次检查');
      expect(fake.checkCalls, 1, reason: '详情页不得再发一次版本检查');

      // 点该按钮进入既有确认流程，升级的是列表给出的那个版本。
      await tester.tap(find.byKey(const ValueKey('plugin-detail-upgrade')));
      await tester.pumpAndSettle();
      expect(find.text('升级「dsh-up」'), findsOneWidget);
      expect(find.textContaining('升级到 v2.0.0'), findsWidgets);
      await tester.tap(find.widgetWithText(FilledButton, '升级'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(fake.upgradeCalls, 1);
      expect(fake.lastUpgradeVersion, '2.0.0');
      expect(fake.lastUpgradeName, 'dsh-up');
    });

    testWidgets('列表未扫描过 → 详情页仍是「检查更新」（回归）', (tester) async {
      final fake = FakeActions(versionCheck: listed('2.0.0'));
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        loader: () async => data,
        actions: fake.actions,
      );
      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();
      expect(find.text('检查更新'), findsOneWidget);
      expect(find.byKey(const ValueKey('plugin-detail-upgrade')), findsNothing);

      // 手动检查仍然照旧可用。
      await tester.tap(find.text('检查更新'));
      await tester.pumpAndSettle();
      expect(fake.checkCalls, 1);
      expect(find.text('v2.0.0'), findsOneWidget);
    });

    testWidgets('扫描失败 → 不被当成「已检查」，仍给「检查更新」', (tester) async {
      final fake = FakeActions(
        versionCheck: const PluginVersionCheck(status: 'refused', problem: 'network'),
      );
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        loader: () async => data,
        actions: fake.actions,
      );
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(find.textContaining('检查失败'), findsWidgets);

      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();
      expect(find.text('检查更新'), findsOneWidget);
      expect(find.byKey(const ValueKey('plugin-detail-upgrade')), findsNothing);
      expect(find.text('升级到 v'), findsNothing);
    });

    testWidgets('扫描结果是「最新」→ 详情页直接显示已是最新，不出升级按钮',
        (tester) async {
      final fake = FakeActions(versionCheck: uptodate);
      final data = inventory([plugin('dsh-up')]);
      await pumpScreen(
        tester,
        loader: () async => data,
        actions: fake.actions,
      );
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();
      expect(find.text('已是最新版本'), findsOneWidget);
      expect(find.byKey(const ValueKey('plugin-detail-upgrade')), findsNothing);
      expect(find.text('检查更新'), findsNothing);
      expect(fake.checkCalls, 1);
    });
  });

  // ---------------------------------------------------------------- 修复 3
  group('3. 操作终态只失效该插件的扫描结果', () {
    test('PluginUpdateScan.withoutResult：只丢指定项，其余项与顺序保留', () {
      const scan = PluginUpdateScan(
        results: {
          'a': PluginUpdateCheckResult(name: 'a', state: 'available', latest: '2.0.0'),
          'b': PluginUpdateCheckResult(name: 'b', state: 'available', latest: '3.0.0'),
          'c': PluginUpdateCheckResult(name: 'c', state: 'current'),
        },
        totalItemCount: 3,
        dispatched: 3,
      );
      final next = scan.withoutResult('a');
      expect(next.results.keys, ['b', 'c'], reason: '只失效 a，b/c 必须保留');
      expect(next.results['b']!.latest, '3.0.0');
      expect(next.results['c']!.state, 'current');
      expect(next.totalItemCount, 3, reason: '失效单结果不改变本轮总数');

      // 不存在的名字：原样返回（不制造无谓的 UI 更新）。
      expect(identical(scan.withoutResult('nope'), scan), isTrue);
      expect(identical(scan.withoutResults(const []), scan), isTrue);
    });

    test('controller.invalidate：只清该项，其他项保留', () async {
      final controller = PluginUpdateScanController(
        checkVersions: (name) async => listed(name == 'a' ? '2.0.0' : '3.0.0'),
        onUpdate: (_) {},
      );
      await controller.start(
        inventory([plugin('a'), plugin('b')]),
      );
      expect(controller.scan.results.keys, containsAll(['a', 'b']));

      controller.invalidate(['a']);
      expect(controller.scan.results.containsKey('a'), isFalse);
      expect(controller.scan.results['b']!.latest, '3.0.0',
          reason: '其他插件的扫描结果不得被无故清空');
      // 单项失效后不该重新变回「正在检查」。
      expect(controller.scan.running, isFalse);
    });

    test('controller.invalidate：在飞结果作废后不写回，别的项照常落地', () async {
      final gate = <String, Completer<PluginVersionCheck>>{};
      final controller = PluginUpdateScanController(
        concurrency: 1,
        checkVersions: (name) {
          final completer = Completer<PluginVersionCheck>();
          gate[name] = completer;
          return completer.future;
        },
        onUpdate: (_) {},
      );
      final run = controller.start(inventory([plugin('a'), plugin('b')]));
      await Future<void>.delayed(Duration.zero);
      expect(gate.keys, ['a']);

      // 升级完成 → 作废 a（此时 a 的检查还在飞）。
      controller.invalidate(['a']);
      gate['a']!.complete(listed('9.9.9'));
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // b 正常检查、正常落地。
      expect(gate.keys, contains('b'));
      gate['b']!.complete(listed('8.8.8'));
      await run.timeout(const Duration(seconds: 5));

      expect(controller.scan.results.containsKey('a'), isFalse,
          reason: '作废项迟到的结果必须丢弃');
      expect(controller.scan.results['b']!.latest, '8.8.8',
          reason: '其他项不受影响');
    });

    test('controller.start：新一轮重查会重新采信上一轮被作废的项', () async {
      final controller = PluginUpdateScanController(
        checkVersions: (_) async => listed('2.0.0'),
        onUpdate: (_) {},
      );
      await controller.start(inventory([plugin('a')]));
      controller.invalidate(['a']);
      expect(controller.scan.results, isEmpty);
      await controller.start(inventory([plugin('a')]));
      expect(controller.scan.results['a']!.latest, '2.0.0',
          reason: '作废只针对本轮，重新检查应恢复结果');
    });

    testWidgets('升级成功：该行「可更新」消失，其他插件的扫描结果保留', (tester) async {
      final fake = FakeActions(versionCheck: null);
      // 两个插件都有可更新；升级 a 后宿主清单里 a 变成 2.0.0，
      // 而旧 scan 仍记 a 的 latest=2.0.0 —— 不失效就会继续显示「可更新 v2.0.0」。
      var current = inventory([
        plugin('a', version: '1.0.0'),
        plugin('b', version: '1.0.0'),
      ]);
      fake.onUpgraded = (name, version) {
        current = inventory([
          plugin('a', version: version),
          plugin('b', version: '1.0.0'),
        ]);
      };
      final actions = PluginInventoryActions(
        checkVersions: (name) async => listed(name == 'a' ? '2.0.0' : '3.0.0'),
        install: (name) async => operation(action: 'install', name: name),
        upgrade: (name, version) async {
          fake.upgradeCalls += 1;
          fake.lastUpgradeName = name;
          fake.lastUpgradeVersion = version;
          return operation(action: 'update', name: name);
        },
        uninstall: (name) async => operation(action: 'uninstall', name: name),
        toggle: (name, enabled) async => operation(action: 'toggle', name: name),
        restartHost: () async => '',
        poll: (_) async {
          fake.onUpgraded?.call(fake.lastUpgradeName!, fake.lastUpgradeVersion!);
          return operation(
            action: 'update',
            name: fake.lastUpgradeName!,
            status: 'succeeded',
            version: fake.lastUpgradeVersion!,
            fromVersion: '1.0.0',
          );
        },
        cancel: (_) async => 'cancelled',
      );

      await pumpScreen(
        tester,
        loader: () async => current,
        actions: actions,
      );
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(find.textContaining('可更新 v2.0.0'), findsOneWidget);
      expect(find.textContaining('可更新 v3.0.0'), findsOneWidget);

      // a 行 → 详情（已复用 scan）→ 升级 → 成功。
      await tester.tap(find.text('a'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('plugin-detail-upgrade')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '升级'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('升级完成 v2.0.0'), findsOneWidget);

      // 负例 + 正例：a 的过期结果被清掉，b 的结果必须还在。
      expect(find.textContaining('可更新 v2.0.0'), findsNothing,
          reason: '升级完成后该行不得再显示过期的「可更新」');
      expect(find.textContaining('可更新 v3.0.0'), findsOneWidget,
          reason: '只失效该项：其他插件的扫描结果不得被清空');
      expect(find.text('最新'), findsNothing,
          reason: 'b 仍是可更新，不能被误标为最新');
    });

    testWidgets('升级失败但已回滚：版本未变，扫描结果保留（不制造未扫描态）',
        (tester) async {
      final fake = FakeActions(upgradeRolledBack: true);
      final data = inventory([plugin('dsh-up')]);
      final actions = PluginInventoryActions(
        checkVersions: (_) async => listed('2.0.0'),
        install: (name) async => operation(action: 'install', name: name),
        upgrade: (name, version) async {
          fake.upgradeCalls += 1;
          fake.lastUpgradeName = name;
          fake.lastUpgradeVersion = version;
          return operation(action: 'update', name: name);
        },
        uninstall: (name) async => operation(action: 'uninstall', name: name),
        toggle: (name, enabled) async => operation(action: 'toggle', name: name),
        restartHost: () async => '',
        poll: (_) async => operation(
          action: 'update',
          name: 'dsh-up',
          status: 'failed',
          fromVersion: '1.0.0',
          rolledBack: true,
        ),
        cancel: (_) async => 'cancelled',
      );

      await pumpScreen(tester, loader: () async => data, actions: actions);
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('plugin-detail-upgrade')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '升级'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('已自动恢复'), findsOneWidget);

      expect(find.textContaining('可更新 v2.0.0'), findsOneWidget,
          reason: '回滚后版本未变，旧结果仍然成立，不应清空');
    });

    testWidgets('卸载成功：只失效被卸载的那一项', (tester) async {
      final fake = FakeActions();
      var current = inventory([
        plugin('a', version: '1.0.0'),
        plugin('b', version: '1.0.0'),
      ]);
      final actions = PluginInventoryActions(
        checkVersions: (name) async => listed(name == 'a' ? '2.0.0' : '3.0.0'),
        install: (name) async => operation(action: 'install', name: name),
        upgrade: (name, version) async => operation(action: 'update', name: name),
        uninstall: (name) async {
          fake.uninstallCalls += 1;
          fake.lastUninstallName = name;
          return operation(action: 'uninstall', name: name);
        },
        toggle: (name, enabled) async => operation(action: 'toggle', name: name),
        restartHost: () async => '',
        poll: (_) async {
          // 卸载后 a 从清单消失。
          current = inventory([plugin('b', version: '1.0.0')]);
          return operation(action: 'uninstall', name: 'a', status: 'succeeded');
        },
        cancel: (_) async => 'cancelled',
      );

      await pumpScreen(tester, loader: () async => current, actions: actions);
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(find.textContaining('可更新 v3.0.0'), findsOneWidget);

      await tester.tap(find.text('a'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('卸载插件'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '卸载'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(fake.uninstallCalls, 1);
      expect(find.text('a'), findsNothing, reason: '卸载后行已从清单移除');
      expect(find.textContaining('可更新 v3.0.0'), findsOneWidget,
          reason: 'b 的扫描结果不受 a 的卸载影响');
    });

    testWidgets('结果未知的操作也失效该项（可能已改，不能继续声称可更新）',
        (tester) async {
      final fake = FakeActions(upgradeOutcomeUnknown: true);
      final data = inventory([plugin('dsh-up')]);
      final actions = PluginInventoryActions(
        checkVersions: (_) async => listed('2.0.0'),
        install: (name) async => operation(action: 'install', name: name),
        upgrade: (name, version) async {
          fake.upgradeCalls += 1;
          fake.lastUpgradeName = name;
          fake.lastUpgradeVersion = version;
          return operation(action: 'update', name: name);
        },
        uninstall: (name) async => operation(action: 'uninstall', name: name),
        toggle: (name, enabled) async => operation(action: 'toggle', name: name),
        restartHost: () async => '',
        poll: (_) async => operation(
          action: 'update',
          name: 'dsh-up',
          status: 'failed',
          outcomeUnknown: true,
        ),
        cancel: (_) async => 'cancelled',
      );

      await pumpScreen(tester, loader: () async => data, actions: actions);
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('dsh-up'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('plugin-detail-upgrade')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '升级'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('结果未知'), findsOneWidget);
      expect(find.textContaining('可更新 v2.0.0'), findsNothing,
          reason: '结果未知时不能继续声称该行可更新');
    });
  });
}
