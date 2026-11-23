// issue #153：插件管理主页三分类 Tab（谓词 B）+ HIDDEN 折叠 + 搜索 + 分类表对账 + 降级。
//
// 分类**事实来自宿主**：这些用例都用宿主动词形状（`category`/`hidden`/`classification`）
// 构造数据，验证 App 只渲染、不重算；缺字段时退回扁平列表。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_inventory_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

PluginCategory category(String kind, {String reason = ''}) =>
    PluginCategory(kind: kind, label: '', reason: reason);

PluginInfo plugin(
  String name, {
  String version = '1.2.3',
  PluginCategory? cat,
  bool hidden = false,
  bool hasCategory = true,
  bool enabled = true,
  bool current = false,
  PluginHealth health = const PluginHealth(state: 'ok'),
  String updateKind = '',
  bool canUpdate = false,
  Object? title,
}) => PluginInfo(
  id: name,
  name: name,
  title: title,
  packageName: name,
  version: version,
  enabled: enabled,
  current: current,
  health: health,
  category: cat ?? category('custom'),
  hasCategory: hasCategory,
  hidden: hidden,
  updateKind: updateKind,
  canUpdate: canUpdate,
);

PluginInventory inventory({
  required List<PluginInfo> plugins,
  List<PluginInstallable> installable = const [],
  PluginClassification classification = const PluginClassification(
    tableVersion: '2026.11',
    targetDsh: '0.2.2',
    dshVersion: '0.2.2-rc.5',
    matched: true,
    source: 'static-table',
  ),
  bool supported = true,
}) => PluginInventory(
  supported: supported,
  complete: supported,
  host: const PluginInventoryHost(
    id: 'host-1',
    pluginVersion: '3.3.1',
    restartSupported: true,
  ),
  plugins: plugins,
  installable: installable,
  classification: classification,
);

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  store.api.hostIdentity = 'host-1';
  store.connState = 'connected';
  return store;
}

Future<void> pumpScreen(
  WidgetTester tester, {
  required PluginInventory data,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  PluginInventoryActions? actions,
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

  group('分类事实解析（宿主下发，App 不重算）', () {
    test('category 缺失 → hasCategory=false；hasCategories 要求每一行都有', () {
      final old = PluginInventory.fromJson({
        'ok': true,
        'supported': true,
        'plugins': [
          {'name': 'a', 'packageName': 'a', 'version': '1.0.0'},
          {'name': 'b', 'packageName': 'b', 'version': '2.0.0'},
        ],
      });
      expect(old.plugins.every((p) => p.hasCategory), isFalse);
      expect(old.hasCategories, isFalse, reason: '缺 category 必须走扁平降级');

      final partial = PluginInventory.fromJson({
        'ok': true,
        'supported': true,
        'plugins': [
          {
            'name': 'a',
            'packageName': 'a',
            'category': {'kind': 'builtin', 'label': '内置', 'reason': ''},
          },
          {'name': 'b', 'packageName': 'b'},
        ],
      });
      expect(partial.hasCategories, isFalse, reason: '部分缺失同样不能展示三 Tab');
    });

    test('classification 解析：matched/dshVersion/tableVersion；无字段时 present=false', () {
      final parsed = PluginInventory.fromJson({
        'ok': true,
        'supported': true,
        'classification': {
          'tableVersion': '2026.11',
          'targetDsh': '0.2.2',
          'dshVersion': '0.2.2-rc.5',
          'matched': true,
          'source': 'static-table',
        },
        'plugins': [],
      });
      expect(parsed.classification.present, isTrue);
      expect(parsed.classification.matched, isTrue);
      expect(parsed.classification.tableVersion, '2026.11');

      final older = PluginInventory.fromJson({'ok': true, 'supported': true, 'plugins': []});
      expect(older.classification.present, isFalse);
      expect(older.classificationMismatch, isFalse);
    });

    test('各类别计数与过滤：hidden 默认不显示，showHidden 后显示', () {
      final data = inventory(
        plugins: [
          plugin('a', cat: category('builtin')),
          plugin('b', cat: category('experimental')),
          plugin('c', cat: category('custom')),
          plugin('d', cat: category('custom'), hidden: true),
        ],
      );
      expect(data.pluginsFor('custom', showHidden: false).length, 1);
      expect(data.pluginsFor('custom', showHidden: true).length, 2);
      expect(data.visiblePlugins(showHidden: false).length, 3);
      expect(data.visiblePlugins(showHidden: true).length, 4);
    });

    test('分类展示名本地化：宿主 label 只作兜底', () {
      expect(category('builtin').displayLabel, '内置');
      expect(category('experimental').displayLabel, '实验性');
      expect(category('custom').displayLabel, '自定义');
      expect(category('unclassified').displayLabel, '已安装（未分类）');
      L10n.lang = 'en';
      expect(category('builtin').displayLabel, 'Built-in');
      expect(category('experimental').displayLabel, 'Experimental');
      expect(category('unclassified').displayLabel, 'Installed (unclassified)');
      L10n.lang = 'zh';
    });
  });

  group('三 Tab 页面', () {
    testWidgets('一页三 Tab：只显示当前 Tab 的行，切换后换内容', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-core', cat: category('builtin'), title: 'DSH 核心'),
          plugin('dsh-exp', cat: category('experimental'), title: '自动评审'),
          plugin('dsh-mine', cat: category('custom'), title: '我的插件'),
        ],
      );
      await pumpScreen(tester, data: data);
      // 默认「内置」。
      expect(find.text('DSH 核心'), findsOneWidget);
      expect(find.text('自动评审'), findsNothing);
      expect(find.text('我的插件'), findsNothing);
      // 三个 Tab 都在（含计数）。
      expect(find.text('内置'), findsWidgets);
      expect(find.text('实验性'), findsWidgets);
      expect(find.text('自定义'), findsWidgets);

      await tester.tap(find.text('实验性').last);
      await tester.pumpAndSettle();
      expect(find.text('自动评审'), findsOneWidget);
      expect(find.text('DSH 核心'), findsNothing);
      // 实验性 Tab 段首说明（风险 + 表版本）。
      expect(find.textContaining('可能不稳定'), findsOneWidget);
      expect(find.textContaining('2026.11'), findsWidgets);

      await tester.tap(find.text('自定义').last);
      await tester.pumpAndSettle();
      expect(find.text('我的插件'), findsOneWidget);
      expect(find.text('自动评审'), findsNothing);
    });

    testWidgets('每个 Tab 内分「已安装 / 可安装」两段', (tester) async {
      final data = inventory(
        plugins: [plugin('dsh-core', cat: category('builtin'))],
        installable: [
          PluginInstallable(
            id: 'dsh-more',
            name: 'dsh-more',
            packageName: 'dsh-more',
            version: '0.9.0',
            category: category('builtin'),
            hasCategory: true,
          ),
          PluginInstallable(
            id: 'dsh-other',
            name: 'dsh-other',
            packageName: 'dsh-other',
            version: '1.0.0',
            category: category('custom'),
            hasCategory: true,
          ),
        ],
      );
      await pumpScreen(tester, data: data);
      expect(find.text('已安装'), findsOneWidget);
      expect(find.text('可安装'), findsOneWidget);
      expect(find.text('dsh-more'), findsOneWidget);
      expect(find.text('dsh-other'), findsNothing, reason: '可安装行也按分类分 Tab');
    });

    testWidgets('空 Tab 有独立空态，不自动跳转别的 Tab', (tester) async {
      final data = inventory(
        plugins: [plugin('dsh-core', cat: category('builtin'))],
      );
      await pumpScreen(tester, data: data);
      await tester.tap(find.text('实验性').last);
      await tester.pumpAndSettle();
      expect(find.text('此电脑版本没有匹配的实验性插件'), findsOneWidget);
      // 仍在实验性 Tab（内置行不可见）。
      expect(find.text('dsh-core'), findsNothing);
    });
  });

  group('HIDDEN 折叠', () {
    testWidgets('默认不展示 hidden 行；开关后展示且计数正确', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-mine', cat: category('custom'), title: '我的插件'),
          plugin(
            'dsh-base',
            cat: category('builtin'),
            hidden: true,
            title: 'DSH 基座',
          ),
        ],
      );
      await pumpScreen(tester, data: data);
      // 内置 Tab 默认只有隐藏行 → 空态，且不展示该行。
      expect(find.text('DSH 基座'), findsNothing);
      expect(find.textContaining('显示隐藏项（1）'), findsOneWidget);

      await tester.tap(find.textContaining('显示隐藏项（1）'));
      await tester.pumpAndSettle();
      expect(find.text('DSH 基座'), findsOneWidget);
    });

    testWidgets('过滤只影响展示：宿主清单仍完整（不修改 complete/supported）', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-mine', cat: category('custom')),
          plugin('dsh-base', cat: category('builtin'), hidden: true),
        ],
      );
      expect(data.complete, isTrue);
      expect(data.plugins.length, 2, reason: '隐藏行不得从清单里消失');
      await pumpScreen(tester, data: data);
      expect(find.textContaining('清单不完整'), findsNothing);
    });
  });

  group('搜索（本地，只作用当前 Tab）', () {
    testWidgets('按标题/包名过滤；切换 Tab 会清空搜索', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-core', cat: category('builtin'), title: 'DSH 核心'),
          plugin('dsh-notify', cat: category('builtin'), title: '通知中心'),
          plugin('dsh-mine', cat: category('custom'), title: '我的插件'),
        ],
      );
      await pumpScreen(tester, data: data);
      // 用包名搜索：避免匹配到搜索框自身的文本。
      await tester.enterText(find.byKey(const ValueKey('plugin-search')), 'dsh-notify');
      await tester.pumpAndSettle();
      expect(find.text('通知中心'), findsOneWidget);
      expect(find.text('DSH 核心'), findsNothing);

      // 无结果 → 清除入口。
      await tester.enterText(find.byKey(const ValueKey('plugin-search')), 'zzz');
      await tester.pumpAndSettle();
      expect(find.text('没有匹配的插件'), findsOneWidget);
      await tester.tap(find.text('清除搜索').last);
      await tester.pumpAndSettle();
      expect(find.text('DSH 核心'), findsOneWidget);

      // 搜索只作用当前 Tab：自定义 Tab 搜“通知”应无结果，不能串到内置。
      await tester.enterText(find.byKey(const ValueKey('plugin-search')), 'dsh-notify');
      await tester.pumpAndSettle();
      await tester.tap(find.text('自定义').last);
      await tester.pumpAndSettle();
      expect(find.text('我的插件'), findsOneWidget, reason: '切换 Tab 清空搜索');
    });

    testWidgets('搜索提示随 Tab 变化', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-core', cat: category('builtin')),
          plugin('dsh-mine', cat: category('custom')),
        ],
      );
      await pumpScreen(tester, data: data);
      expect(find.text('搜索内置插件'), findsOneWidget);
      await tester.tap(find.text('自定义').last);
      await tester.pumpAndSettle();
      expect(find.text('搜索自定义插件'), findsOneWidget);
    });
  });

  group('分类表对账', () {
    testWidgets('matched=false 显示提示，但仍给分类（不改判、不挪 Tab）', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-core', cat: category('builtin')),
          plugin('dsh-exp', cat: category('experimental')),
        ],
        classification: const PluginClassification(
          tableVersion: '2026.11',
          targetDsh: '0.2.2',
          dshVersion: '0.4.0-rc.1',
          matched: false,
          source: 'static-table',
        ),
      );
      await pumpScreen(tester, data: data);
      expect(find.textContaining('分类表与当前 DSH 版本不匹配'), findsOneWidget);
      expect(find.textContaining('0.4.0-rc.1'), findsWidgets);
      // 分类照旧：内置 Tab 行仍在，实验性行在对应 Tab。
      expect(find.text('dsh-core'), findsOneWidget);
      await tester.tap(find.text('实验性').last);
      await tester.pumpAndSettle();
      expect(find.text('dsh-exp'), findsOneWidget);
    });

    testWidgets('matched=true 不显示提示', (tester) async {
      await pumpScreen(
        tester,
        data: inventory(plugins: [plugin('dsh-core', cat: category('builtin'))]),
      );
      expect(find.textContaining('分类表与当前 DSH 版本不匹配'), findsNothing);
    });
  });

  group('旧宿主降级', () {
    testWidgets('无 category → 单列表 + 提示，不渲染三 Tab', (tester) async {
      final data = inventory(
        plugins: [
          plugin('dsh-old-a', hasCategory: false),
          plugin('dsh-old-b', hasCategory: false),
        ],
        classification: const PluginClassification(),
      );
      await pumpScreen(tester, data: data);
      expect(find.textContaining('当前电脑端不提供插件分类'), findsOneWidget);
      expect(find.text('已安装（未分类）'), findsOneWidget);
      expect(find.text('dsh-old-a'), findsOneWidget);
      expect(find.text('dsh-old-b'), findsOneWidget);
      // 三 Tab 不应出现。
      expect(find.text('实验性'), findsNothing);
      expect(find.text('自定义'), findsNothing);
    });

    testWidgets('旧宿主端到端 404 → 整页不支持（不出假分类/假安装）', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final store = await makeStore();
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: PluginInventoryScreen(
            store: store,
            loader: () async => PluginInventory.unsupported('endpoint-missing'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('当前电脑端不支持手机端插件管理'), findsOneWidget);
      expect(find.text('已安装（未分类）'), findsNothing);
    });
  });

  group('响应式与深色', () {
    for (final config in [
      (const Size(320, 844), 1.0, Brightness.light, '320'),
      (const Size(320, 844), 1.5, Brightness.light, '320/1.5x'),
      (const Size(320, 844), 2.0, Brightness.light, '320/2.0x'),
      (const Size(390, 844), 1.0, Brightness.dark, '390/深色'),
    ]) {
      testWidgets('${config.$4}：三 Tab 与行不溢出、可读', (tester) async {
        final data = inventory(
          plugins: [
            plugin(
              'dsh-very-long-plugin-name-that-needs-ellipsis',
              cat: category('builtin'),
              title: '很长的内置插件名称需要省略号显示',
            ),
            plugin('dsh-exp', cat: category('experimental'), title: '实验性'),
            plugin('dsh-mine', cat: category('custom'), title: '自定义'),
          ],
        );
        await pumpScreen(
          tester,
          data: data,
          size: config.$1,
          textScale: config.$2,
          brightness: config.$3,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('内置'), findsWidgets);
        expect(find.text('实验性'), findsWidgets);
      });
    }
  });
}
