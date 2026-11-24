// issue #175 P1：**记住上次选择的安装源**（只存手机本地，不写电脑端配置）。
//
// 本组测试钉住容易写错的几件事：
//   1. 切换即保存 —— 不等「开始安装」，取消安装也不丢；
//   2. 真持久化 —— 新开一个 AppStore + loadPrefs 仍读得回（等价「杀掉 App 重开」）；
//   3. 存值失效（registry 从宿主列表消失）→ 静默回退「宿主默认源」，不崩、不显示幽灵选项；
//   4. 手动 URL **默认不记**；勾了「记住此地址」才记；
//   5. 无任何写电脑端配置的路径（本文件只碰 AppStore 的本地偏好）。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_install_source_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _officialUrl = 'https://registry.npmjs.org/';
const _mirrorUrl = 'https://registry.npmmirror.com/';

const _registryList = PluginRegistryList(
  supported: true,
  complete: true,
  registries: [
    PluginRegistry(
      id: 'registry',
      kind: 'registry',
      url: _officialUrl,
      display: 'registry.npmjs.org/',
      role: 'primary',
    ),
    PluginRegistry(
      id: 'fallback:0',
      kind: 'registry',
      url: _mirrorUrl,
      display: 'registry.npmmirror.com/',
      role: 'fallback',
    ),
  ],
);

PluginOperation succeeded() => const PluginOperation(
  opId: 'op-1',
  action: 'install',
  name: 'dsh-voice-input',
  status: 'succeeded',
);

/// 新建一个「重开 App」等价的 store：新的 mock prefs 状态 + 重新 loadPrefs。
///
/// `SharedPreferences.setMockInitialValues` 只在建 store 前设置初值；
/// 要验「杀掉 App 重开仍是上次那个」，必须**复用同一份底层存储**，
/// 所以这里不清空 initial values，直接再建一个 AppStore（SharedPreferences
/// 的 mock 实现是进程内单例，数据在同一个实例上保留）。
Future<AppStore> reopenStore({Map<String, Object>? seed}) async {
  if (seed != null) SharedPreferences.setMockInitialValues(seed);
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

Future<void> pumpScreen(
  WidgetTester tester, {
  required AppStore store,
  Future<PluginOperation> Function(String registry)? onInstall,
  Future<PluginRegistryList> Function() loadRegistries = _loadList,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
}) async {
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
        child: PluginInstallSourceScreen(
          packageName: 'dsh-voice-input',
          displayName: '语音输入',
          packageSpec: 'dsh-voice-input@0.7.0',
          version: '0.7.0',
          loadRegistries: loadRegistries,
          onInstall: onInstall ?? (_) async => succeeded(),
          store: store,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<PluginRegistryList> _loadList() async => _registryList;

/// 某个选项当前是否被选中。
///
/// 用 radio 图标的形状判断，而不是读私有 state：选项行用
/// `Icons.radio_button_checked` / `Icons.radio_button_unchecked` 区分选中态，
/// 这是用户真正看到的东西。
bool isSelected(WidgetTester tester, String key) {
  final row = find.byKey(ValueKey('install-source-$key'));
  if (row.evaluate().isEmpty) return false;
  final checked = find.descendant(
    of: row,
    matching: find.byIcon(Icons.radio_button_checked),
  );
  return checked.evaluate().isNotEmpty;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('切换即保存（不等「开始安装」）', () {
    testWidgets('选大陆镜像 → 立刻写进本地偏好（还没点安装）', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      expect(isSelected(tester, 'host'), isTrue, reason: '默认是宿主配置渠道');

      await tester.tap(find.byKey(const ValueKey('install-source-$_mirrorUrl')));
      await tester.pumpAndSettle();

      expect(isSelected(tester, _mirrorUrl), isTrue);
      expect(
        store.pluginInstallSource,
        _mirrorUrl,
        reason: '切换那一刻就要保存，不等安装',
      );
      // 明确：没有发起任何安装。
      expect(find.textContaining('安装完成'), findsNothing);
    });

    testWidgets('取消安装后重开 → 仍是上次那个（不是安装成功才记住）', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      await tester.tap(find.byKey(const ValueKey('install-source-$_mirrorUrl')));
      await tester.pumpAndSettle();

      // 用户直接离开（等价「取消安装」）：不点提交。
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();

      final reopened = await reopenStore();
      await pumpScreen(tester, store: reopened);
      expect(isSelected(tester, _mirrorUrl), isTrue);
    });
  });

  group('真持久化（杀掉 App 重开）', () {
    testWidgets('新 store + loadPrefs 仍读回上次选择的源', (tester) async {
      final first = await reopenStore(seed: {});
      await pumpScreen(tester, store: first);
      // 用**列表第二个**源（镜像）：列表第一项在 UI 上就是「宿主配置渠道」那一行，
      // 不单独成为一个可选中项（见实现里 `_validatedSelection` 的说明）。
      await tester.tap(find.byKey(const ValueKey('install-source-$_mirrorUrl')));
      await tester.pumpAndSettle();
      expect(first.pluginInstallSource, _mirrorUrl);

      // 「杀掉 App 重开」：全新 store + 重新 loadPrefs（同一底层 prefs）。
      final second = await reopenStore();
      expect(second.pluginInstallSource, _mirrorUrl);
      await pumpScreen(tester, store: second);
      expect(isSelected(tester, _mirrorUrl), isTrue);
    });

    testWidgets('偏好键名稳定（显式钉住，避免以后改名丢用户设置）', (tester) async {
      final store = await reopenStore(seed: {});
      await store.setPluginInstallSource(_mirrorUrl);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('dsh_mr_plugin_install_source'), _mirrorUrl);
      expect(
        prefs.getString('dsh_mr_plugin_manual_registry_url'),
        isNull,
        reason: '手动地址单独一个键，默认不写',
      );
    });

    testWidgets('首次使用（没存过）→ 宿主配置渠道', (tester) async {
      final store = await reopenStore(seed: {});
      expect(store.pluginInstallSource, '');
      await pumpScreen(tester, store: store);
      expect(isSelected(tester, 'host'), isTrue);
    });
  });

  group('存值失效 → 回退宿主默认源（不崩、不显示幽灵选项）', () {
    testWidgets('registry 从宿主列表消失 → 回退 host', (tester) async {
      final store = await reopenStore(
        seed: {'dsh_mr_plugin_install_source': 'https://gone.example.test/'},
      );
      await pumpScreen(tester, store: store);
      expect(isSelected(tester, 'host'), isTrue, reason: '失效值必须回退，不能停在幽灵项');
      // 幽灵 URL 不该被渲染成可选行。
      expect(find.byKey(const ValueKey('install-source-https://gone.example.test/')), findsNothing);
    });

    testWidgets('宿主列表读取失败 → 回退 host，不崩', (tester) async {
      final store = await reopenStore(
        seed: {'dsh_mr_plugin_install_source': _mirrorUrl},
      );
      await pumpScreen(
        tester,
        store: store,
        loadRegistries: () async => throw StateError('boom'),
      );
      expect(tester.takeException(), isNull);
      expect(isSelected(tester, 'host'), isTrue);
      // 仍可安装（不阻断）。
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('安装完成'), findsWidgets);
    });

    testWidgets('宿主不支持 registries（老宿主）→ 回退 host', (tester) async {
      final store = await reopenStore(
        seed: {'dsh_mr_plugin_install_source': _mirrorUrl},
      );
      await pumpScreen(
        tester,
        store: store,
        loadRegistries: () async =>
            PluginRegistryList.unsupported('endpoint-missing'),
      );
      expect(isSelected(tester, 'host'), isTrue);
      expect(find.textContaining('不提供安装源信息'), findsOneWidget);
    });

    testWidgets('存的就是 host → 保持 host', (tester) async {
      final store = await reopenStore(
        seed: {'dsh_mr_plugin_install_source': 'host'},
      );
      await pumpScreen(tester, store: store);
      expect(isSelected(tester, 'host'), isTrue);
    });
  });

  group('手动 URL：默认不记住', () {
    testWidgets('选手动 URL 后重开 → 回到上次的非 manual 选项，URL 框为空', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      // 先选个会被记住的源。
      await tester.tap(find.byKey(const ValueKey('install-source-$_mirrorUrl')));
      await tester.pumpAndSettle();
      // 再切到手动并输入地址（不勾「记住此地址」）。
      await tester.tap(find.byKey(const ValueKey('install-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'https://npm.internal.test/',
      );
      await tester.pumpAndSettle();

      expect(
        store.pluginManualRegistryUrl,
        '',
        reason: '未勾选时不得记住手动地址',
      );
      expect(
        store.pluginInstallSource,
        _mirrorUrl,
        reason: 'manual 本身不进记忆，保留上一个非 manual 选择',
      );

      // 重开：回到镜像源，且 URL 框为空、手动行未展开。
      await tester.pumpWidget(const SizedBox.shrink());
      final reopened = await reopenStore();
      await pumpScreen(tester, store: reopened);
      expect(isSelected(tester, _mirrorUrl), isTrue);
      expect(find.byKey(const ValueKey('install-source-url')), findsNothing);
    });

    testWidgets('勾「记住此地址」→ 存到本机；重开时回到手动并带出地址', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      await tester.tap(find.byKey(const ValueKey('install-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'https://npm.internal.test/',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-remember')));
      await tester.pumpAndSettle();

      expect(store.pluginManualRegistryUrl, 'https://npm.internal.test/');

      final reopened = await reopenStore();
      await pumpScreen(tester, store: reopened);
      expect(isSelected(tester, 'manual'), isTrue);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('install-source-url')),
      );
      expect(field.controller?.text, 'https://npm.internal.test/');
    });

    testWidgets('取消勾选 → 清掉已记住的手动地址', (tester) async {
      final store = await reopenStore(
        seed: {
          'dsh_mr_plugin_manual_registry_url': 'https://npm.internal.test/',
        },
      );
      await pumpScreen(tester, store: store);
      expect(isSelected(tester, 'manual'), isTrue, reason: '有记住的地址时回到手动');

      await tester.tap(find.byKey(const ValueKey('install-source-remember')));
      await tester.pumpAndSettle();
      expect(store.pluginManualRegistryUrl, '');

      // 重开页面：必须先卸载旧 widget，否则 Flutter 会复用同一个 State，
      // 相当于「没重开」（等价真机上退出页面再进来）。
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      final reopened = await reopenStore();
      await pumpScreen(tester, store: reopened);
      expect(isSelected(tester, 'host'), isTrue, reason: '清掉后回退默认源');
    });

    testWidgets('记住的地址不合法 → 不写入（避免下次出现幽灵项）', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      await tester.tap(find.byKey(const ValueKey('install-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'file:///tmp/registry',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-remember')));
      await tester.pumpAndSettle();
      expect(store.pluginManualRegistryUrl, '');
    });

    testWidgets('已勾选后清空输入 → 记忆随之清掉（不留幽灵地址）', (tester) async {
      final store = await reopenStore(seed: {});
      await pumpScreen(tester, store: store);
      await tester.tap(find.byKey(const ValueKey('install-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'https://npm.internal.test/',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-remember')));
      await tester.pumpAndSettle();
      expect(store.pluginManualRegistryUrl, 'https://npm.internal.test/');

      // 清空输入框：勾选仍在，但存的地址必须跟着清掉。
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        '',
      );
      await tester.pumpAndSettle();
      expect(
        store.pluginManualRegistryUrl,
        '',
        reason: '空输入不得留下上次的地址',
      );
    });
  });

  group('按次选源语义不变（#153 契约不退化）', () {
    testWidgets('记住的源只影响**默认选中**，实际传的仍是本次所选', (tester) async {
      final asked = <String>[];
      final store = await reopenStore(
        seed: {'dsh_mr_plugin_install_source': _mirrorUrl},
      );
      await pumpScreen(
        tester,
        store: store,
        onInstall: (registry) async {
          asked.add(registry);
          return succeeded();
        },
      );
      expect(isSelected(tester, _mirrorUrl), isTrue);
      // 用户改选**宿主默认源** → 传空串（记忆不劫持本次选择）。
      await tester.tap(find.byKey(const ValueKey('install-source-host')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(
        asked,
        [''],
        reason: '改选宿主默认源时传空串，不因为记住过镜像源就替换本次选择',
      );
      expect(store.pluginInstallSource, 'host', reason: '改选也应立刻更新记忆');
    });

    testWidgets('选宿主默认源 → 仍传空串（沿用宿主解析顺序）', (tester) async {
      final asked = <String>[];
      final store = await reopenStore(seed: {});
      await pumpScreen(
        tester,
        store: store,
        onInstall: (registry) async {
          asked.add(registry);
          return succeeded();
        },
      );
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(asked, ['']);
    });
  });

  group('窄屏 / 深色 / 大字号不溢出（含新的勾选项）', () {
    for (final spec in [
      (width: 320.0, brightness: Brightness.light, scale: 1.0, label: '320 正常'),
      (width: 320.0, brightness: Brightness.dark, scale: 1.0, label: '320 深色'),
      (width: 320.0, brightness: Brightness.light, scale: 1.5, label: '320 · 1.5x'),
      (width: 320.0, brightness: Brightness.dark, scale: 2.0, label: '320 · 2.0x'),
      (width: 390.0, brightness: Brightness.dark, scale: 2.0, label: '390 深色 · 2.0x'),
    ]) {
      testWidgets('${spec.label}：展开手动 URL（含勾选项）后无异常', (tester) async {
        final store = await reopenStore(seed: {});
        await pumpScreen(
          tester,
          store: store,
          size: Size(spec.width, 844),
          brightness: spec.brightness,
          textScale: spec.scale,
        );
        // 大字号下手动项可能滚出视口：先滚到它。
        final manual = find.byKey(const ValueKey('install-source-manual'));
        await tester.scrollUntilVisible(
          manual,
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(manual);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('install-source-remember')),
          findsOneWidget,
          reason: spec.label,
        );
        expect(tester.takeException(), isNull, reason: spec.label);
      });
    }
  });
}
