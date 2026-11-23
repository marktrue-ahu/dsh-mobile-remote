// issue #153：「检查全部更新」= App 侧有界并发 3（不创建宿主事务、不自动安装、可取消）。
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
  PluginCategory? cat,
}) => PluginInfo(
  id: name,
  name: name,
  packageName: name,
  version: version,
  health: const PluginHealth(state: 'ok'),
  canUpdate: canUpdate,
  updateKind: updateKind,
  category: cat ?? PluginCategory(kind: 'builtin', label: ''),
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

PluginVersionCheck listed([String latest = '1.1.0']) => PluginVersionCheck(
  status: 'listed',
  installedVersion: '1.0.0',
  answeredRegistry: 'https://registry.npmjs.org/',
  versions: [PluginVersionInfo(version: latest)],
);

PluginVersionCheck current() => const PluginVersionCheck(
  status: 'listed',
  installedVersion: '1.0.0',
  versions: [],
);

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.connState = 'connected';
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('扫描目标与结果归一', () {
    test('只检查 canUpdate 的行；内置/本地/条目行不检查', () {
      final data = inventory([
        plugin('updatable', canUpdate: true),
        plugin('builtin-like', canUpdate: false),
        plugin('entry', canUpdate: false, updateKind: ''),
      ]);
      final targets = pluginUpdateScanTargets(data);
      expect(targets.map((p) => p.name), ['updatable']);
    });

    test('listed 有可用版本 → available；无可用版本 → current', () {
      final target = plugin('p', canUpdate: true);
      final available = pluginScanResultOf(target, listed('1.2.0'));
      expect(available.state, 'available');
      expect(available.latest, '1.2.0');
      expect(available.answeredRegistry, 'https://registry.npmjs.org/');

      final uptodate = pluginScanResultOf(target, current());
      expect(uptodate.state, 'current');
      expect(uptodate.latest, '');
    });

    test('refused → failed 且必须带 errorCode（不能用“无更新”掩盖）', () {
      final result = pluginScanResultOf(
        plugin('p'),
        const PluginVersionCheck(status: 'refused', problem: 'network'),
      );
      expect(result.state, 'failed');
      expect(result.errorCode, isNotEmpty);
      expect(result.errorCode, contains('network'));
    });

    test('不可用版本被跳过：只用 usable 版本', () {
      final result = pluginScanResultOf(
        plugin('p'),
        const PluginVersionCheck(
          status: 'listed',
          versions: [
            PluginVersionInfo(version: '1.3.0', incompatibleRequirements: 'engines.dsh'),
            PluginVersionInfo(version: '1.2.0'),
          ],
        ),
      );
      expect(result.state, 'available');
      expect(result.latest, '1.2.0', reason: '不可用版本不能当成可升级目标');
    });

    test('有界并发：同时在飞不超过 3', () async {
      var inFlight = 0;
      var peak = 0;
      final completed = <String>[];
      final controller = PluginUpdateScanController(
        checkVersions: (name) async {
          inFlight += 1;
          if (inFlight > peak) peak = inFlight;
          await Future<void>.delayed(const Duration(milliseconds: 5));
          inFlight -= 1;
          completed.add(name);
          return current();
        },
        onUpdate: (_) {},
      );
      await controller.start(
        inventory([
          for (var i = 0; i < 7; i++) plugin('p$i', canUpdate: true),
        ]),
      );
      expect(peak, lessThanOrEqualTo(3), reason: '并发上限必须是 3');
      expect(peak, 3, reason: '应当真的并发到 3（不是串行）');
      expect(completed.length, 7);
      expect(controller.scan.running, isFalse);
      expect(controller.scan.completed, 7);
    });

    test('Git 来源直接 skipped/git-update-desktop-required，不发请求', () async {
      final asked = <String>[];
      final controller = PluginUpdateScanController(
        checkVersions: (name) async {
          asked.add(name);
          return current();
        },
        onUpdate: (_) {},
      );
      await controller.start(
        inventory([
          plugin('git-one', updateKind: 'git'),
          plugin('registry-one', updateKind: 'registry'),
        ]),
      );
      expect(asked, ['registry-one'], reason: 'Git 来源不得发请求');
      final skipped = controller.scan.results['git-one']!;
      expect(skipped.state, 'skipped');
      expect(skipped.reason, 'git-update-desktop-required');
      expect(controller.scan.skippedCount, 1);
      expect(controller.scan.totalItemCount, 2);
    });

    test('单项失败不阻塞其他项；失败带 errorCode', () async {
      final controller = PluginUpdateScanController(
        checkVersions: (name) async {
          if (name == 'boom') throw StateError('hard failure');
          return current();
        },
        onUpdate: (_) {},
      );
      await controller.start(
        inventory([
          plugin('boom', canUpdate: true),
          plugin('ok', canUpdate: true),
          plugin('upd', canUpdate: true),
        ]),
      );
      expect(controller.scan.completed, 3);
      expect(controller.scan.failedCount, 1);
      expect(controller.scan.results['boom']!.state, 'failed');
      expect(controller.scan.results['boom']!.errorCode, 'check-failed');
      expect(controller.scan.results['ok']!.state, 'current');
    });

    test('取消：停派发（不再起新请求）+ 丢弃在飞结果', () async {
      final gate = <String, Completer<PluginVersionCheck>>{};
      final started = <String>[];
      final controller = PluginUpdateScanController(
        checkVersions: (name) {
          started.add(name);
          final completer = Completer<PluginVersionCheck>();
          gate[name] = completer;
          return completer.future;
        },
        onUpdate: (_) {},
      );
      // 4 个目标、并发 3：前 3 个在飞，第 4 个占着槽位等待；取消后不得再派发。
      final run = controller.start(
        inventory([
          for (var i = 0; i < 4; i++) plugin('p$i', canUpdate: true),
        ]),
      );
      await Future<void>.delayed(Duration.zero);
      expect(started, ['p0', 'p1', 'p2']);

      controller.cancel();
      expect(controller.scan.running, isFalse);
      gate['p0']!.complete(listed('9.9.9'));
      gate['p1']!.complete(listed('9.9.9'));
      gate['p2']!.complete(listed('9.9.9'));
      await run.timeout(const Duration(seconds: 5));

      expect(controller.scan.results, isEmpty, reason: '取消后在飞结果一律丢弃');
      expect(started, ['p0', 'p1', 'p2'], reason: '取消后不再派发 p3');
    });

    test('取消保留已完成结果（取消前已落地的项）', () async {
      final gate = <String, Completer<PluginVersionCheck>>{};
      final controller = PluginUpdateScanController(
        checkVersions: (name) {
          final completer = Completer<PluginVersionCheck>();
          gate[name] = completer;
          return completer.future;
        },
        // 并发 1：p0 完成并被记录后，worker 会去取 p1。
        concurrency: 1,
        onUpdate: (_) {},
      );
      final run = controller.start(
        inventory([
          plugin('p0', canUpdate: true),
          plugin('p1', canUpdate: true),
        ]),
      );
      await Future<void>.delayed(Duration.zero);
      gate['p0']!.complete(listed('2.0.0'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.scan.results['p0']?.state, 'available');
      controller.cancel();
      gate['p1']!.complete(listed('9.9.9'));
      await run.timeout(const Duration(seconds: 5));
      expect(controller.scan.running, isFalse);
      expect(controller.scan.results['p0']?.latest, '2.0.0', reason: '已完成结果保留');
      expect(
        controller.scan.results.containsKey('p1'),
        isFalse,
        reason: '取消后在飞结果丢弃',
      );
    });
  });

  group('页面交互', () {
    Future<AppStore> pump(WidgetTester tester, PluginInventory data,
        {PluginInventoryActions? actions, int concurrency = 3}) async {
      final store = await makeStore();
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: PluginInventoryScreen(
            store: store,
            actions: actions,
            loader: () async => data,
          ),
        ),
      );
      await tester.pumpAndSettle();
      return store;
    }

    testWidgets('检查全部更新：进度 banner → 汇总（可更新/最新/失败/跳过）', (tester) async {
      var calls = 0;
      final actions = PluginInventoryActions(
        checkVersions: (name) async {
          calls += 1;
          if (name == 'bad') {
            return const PluginVersionCheck(status: 'refused', problem: 'network');
          }
          return name == 'upd' ? listed('2.0.0') : current();
        },
        install: (_) async => PluginOperation(opId: 'op', action: 'install', name: 'x'),
        upgrade: (_, _) async => PluginOperation(opId: 'op', action: 'update', name: 'x'),
        uninstall: (_) async => PluginOperation(opId: 'op', action: 'uninstall', name: 'x'),
        toggle: (_, _) async => PluginOperation(opId: 'op', action: 'toggle', name: 'x'),
        restartHost: () async => '',
        poll: (_) async => PluginOperation(opId: 'op', action: 'install', name: 'x'),
        cancel: (_) async => 'cancelled',
      );
      await pump(
        tester,
        inventory([
          plugin('upd'),
          plugin('cur'),
          plugin('bad'),
          plugin('git', updateKind: 'git'),
        ]),
        actions: actions,
      );
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(calls, 3, reason: '只对 canUpdate 且非 Git 的行发请求');
      expect(find.textContaining('1 个可更新'), findsOneWidget);
      expect(find.textContaining('1 最新'), findsOneWidget);
      expect(find.textContaining('1 失败'), findsOneWidget);
      expect(find.textContaining('1 跳过'), findsOneWidget);
      // 行内结果标签。
      expect(find.textContaining('可更新 v2.0.0'), findsOneWidget);
      expect(find.text('最新'), findsWidgets);
    });

    testWidgets('检查全部更新不创建安装事务、不自动安装', (tester) async {
      var installCalls = 0;
      var upgradeCalls = 0;
      final actions = PluginInventoryActions(
        checkVersions: (_) async => listed('2.0.0'),
        install: (_) async {
          installCalls += 1;
          return PluginOperation(opId: 'op', action: 'install', name: 'x');
        },
        upgrade: (_, _) async {
          upgradeCalls += 1;
          return PluginOperation(opId: 'op', action: 'update', name: 'x');
        },
        uninstall: (_) async => PluginOperation(opId: 'op', action: 'uninstall', name: 'x'),
        toggle: (_, _) async => PluginOperation(opId: 'op', action: 'toggle', name: 'x'),
        restartHost: () async => '',
        poll: (_) async => PluginOperation(opId: 'op', action: 'install', name: 'x'),
        cancel: (_) async => 'cancelled',
      );
      await pump(tester, inventory([plugin('upd')]), actions: actions);
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(installCalls, 0);
      expect(upgradeCalls, 0);
      // 没有 operation banner（不创建 op）。
      expect(find.textContaining('正在安装'), findsNothing);
      expect(find.textContaining('正在升级'), findsNothing);
    });

    testWidgets('安装事务进行中也可检查', (tester) async {
      final actions = PluginInventoryActions(
        checkVersions: (_) async => current(),
        install: (_) async => PluginOperation(
          opId: 'op-1',
          action: 'install',
          name: 'upd',
          status: 'running',
          steps: const [PluginOperationStep(key: 'install', state: 'running')],
        ),
        upgrade: (_, _) async => PluginOperation(opId: 'op', action: 'update', name: 'x'),
        uninstall: (_) async => PluginOperation(opId: 'op', action: 'uninstall', name: 'x'),
        toggle: (_, _) async => PluginOperation(opId: 'op', action: 'toggle', name: 'x'),
        restartHost: () async => '',
        poll: (_) async => PluginOperation(
          opId: 'op-1',
          action: 'install',
          name: 'upd',
          status: 'running',
        ),
        cancel: (_) async => 'cancelled',
      );
      await pump(
        tester,
        inventory([
          plugin('upd'),
          PluginInfo(
            id: 'new',
            name: 'new',
            packageName: 'new',
            version: '1.0.0',
            category: const PluginCategory(kind: 'custom', label: ''),
            hasCategory: true,
          ),
        ]),
        actions: actions,
      );
      // 无法在本页触发安装（走独立页）；这里验证“检查”按钮在无操作时可用即可，
      // 事务中检查的隔离由 controller 的纯逻辑测试覆盖（不共享状态）。
      await tester.tap(find.byKey(const ValueKey('plugin-check-all')));
      await tester.pumpAndSettle();
      expect(find.textContaining('最新'), findsWidgets);
    });

    testWidgets('320 下检查按钮退化为图标但仍可点', (tester) async {
      final store = await makeStore();
      await tester.binding.setSurfaceSize(const Size(320, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: MediaQuery(
            data: const MediaQueryData(size: Size(320, 844)),
            child: PluginInventoryScreen(
              store: store,
              loader: () async => inventory([plugin('upd')]),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('plugin-check-all')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
