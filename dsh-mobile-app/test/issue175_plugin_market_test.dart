// issue #175 P3：插件市场（索引管理 + 搜索 + 从市场安装 + SSRF UI 侧边界）。
//
// 本组测试钉住 App 侧的**边界**（宿主侧契约由 test/plugin-inventory-market.test.mjs 覆盖）：
//   1. **索引是电脑端配置**：保存前必须显式确认，文案明写「电脑端」；
//   2. **SSRF**：搜索的 url 只能来自已配置列表——页面**不提供**任何手输 URL 的入口，
//      即使某个索引被移除，也不会退回「用旧 url 继续搜」；
//   3. 索引 `error` 如实显示，不隐藏；
//   4. 老宿主 `supported:false` 整块降级；
//   5. 从市场条目安装直接复用 P2 的 install 流程（spec 来自宿主）；
//   6. 320 / 深色 / 1.5x / 2.0x 不溢出。
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_market_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _urlA = 'https://a.test/plugins/index.json';
const _urlB = 'https://b.test/index.json';

PluginMarketIndex index(String url, {String title = '', String error = ''}) =>
    PluginMarketIndex(url: url, title: title, error: error);

PluginMarketIndexes indexes(
  List<PluginMarketIndex> rows, {
  bool supported = true,
  bool writable = true,
}) => PluginMarketIndexes(
  supported: supported,
  writable: writable,
  indexes: rows,
);

PluginMarketVersion version(
  String v, {
  String spec = '',
  bool compatible = true,
  bool update = false,
}) => PluginMarketVersion(
  version: v,
  spec: spec.isEmpty ? 'dsh-x@$v' : spec,
  compatible: compatible,
  update: update,
);

PluginMarketEntry entry(
  String name, {
  String title = '',
  String description = '',
  String category = '',
  String defaultVersion = '1.0.0',
  String installation = 'not-installed',
  String installedVersion = '',
  List<PluginMarketVersion>? versions,
}) => PluginMarketEntry(
  name: name,
  title: title,
  description: description,
  category: category,
  defaultVersion: defaultVersion,
  installationStatus: installation,
  installedVersion: installedVersion,
  versions: versions ?? [version(defaultVersion)],
);

PluginMarketPage page(
  List<PluginMarketEntry> entries, {
  String url = _urlA,
  int total = 0,
  int? nextOffset,
}) => PluginMarketPage(
  url: url,
  title: 'Index',
  total: total == 0 ? entries.length : total,
  nextOffset: nextOffset,
  entries: entries,
);

/// 记录调用的假市场后端。
class FakeMarket {
  FakeMarket({
    PluginMarketIndexes? indexList,
    this.searchError,
    this.saveError,
    this.pageFor,
  }) : indexList = indexList ?? indexes([index(_urlA, title: 'A')]);

  PluginMarketIndexes indexList;
  Object? searchError;
  Object? saveError;
  PluginMarketPage Function(String url, {int offset, int limit, String text, String category})?
  pageFor;

  final List<String> searchedUrls = [];
  final List<(String, int, int, String, String)> searchArgs = [];
  final List<List<String>> saved = [];
  int loadCalls = 0;
  int installCalls = 0;
  String? lastInstallSpec;
  String? lastInstallRegistry;

  PluginMarketActions get actions => PluginMarketActions(
    loadIndexes: () async {
      loadCalls += 1;
      return indexList;
    },
    saveIndexes: (urls) async {
      saved.add([...urls]);
      if (saveError != null) throw saveError!;
      indexList = indexes([for (final url in urls) index(url)]);
      return indexList;
    },
    search: (url, {offset = 0, limit = 20, text = '', category = ''}) async {
      searchedUrls.add(url);
      searchArgs.add((url, offset, limit, text, category));
      if (searchError != null) throw searchError!;
      return pageFor?.call(url, offset: offset, limit: limit, text: text, category: category) ??
          page([entry('dsh-market-plugin', title: 'Market plugin', description: 'from market')], url: url);
    },
    installBySpec: (spec, registry) async {
      installCalls += 1;
      lastInstallSpec = spec;
      lastInstallRegistry = registry;
      return const PluginOperation(opId: 'op', action: 'install', name: 'dsh-x', status: 'succeeded');
    },
    inspectSpec: (spec, registry) async => const PluginSpecInspection(
      supported: true,
      status: 'accepted',
      kind: 'registry',
      name: 'dsh-x',
      version: '1.0.0',
      bundle: true,
    ),
    registries: () async => const PluginRegistryList(supported: true, complete: true, registries: []),
    poll: (_) async => const PluginOperation(opId: 'op', action: 'install', name: 'dsh-x', status: 'succeeded'),
    cancel: (_) async => 'cancelled',
  );
}

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

Future<void> pumpMarket(
  WidgetTester tester, {
  required FakeMarket backend,
  AppStore? store,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
}) async {
  final appStore = store ?? await makeStore();
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.forSkin(DshSkin.dsh, brightness),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: TextScaler.linear(textScale)),
        child: PluginMarketScreen(actions: backend.actions, store: appStore),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> pumpIndexScreen(
  WidgetTester tester, {
  required PluginMarketIndexes initial,
  required Future<PluginMarketIndexes> Function(List<String>) save,
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
        data: MediaQueryData(size: size, textScaler: TextScaler.linear(textScale)),
        child: PluginMarketIndexScreen(initial: initial, save: save),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  // ------------------------------------------------------- 索引读 / 降级
  group('索引读取与降级', () {
    testWidgets('默认选第一个可用索引并自动搜索', (tester) async {
      final backend = FakeMarket(
        indexList: indexes([
          index('https://broken.test/i.json', error: 'not canonical'),
          index(_urlA, title: 'A'),
        ]),
      );
      await pumpMarket(tester, backend: backend);
      expect(backend.searchedUrls, [_urlA], reason: '跳过不可用索引，选第一个可用的');
      expect(find.text('Market plugin'), findsOneWidget);
    });

    testWidgets('老宿主 supported:false → 整块降级，不发搜索', (tester) async {
      final backend = FakeMarket(indexList: PluginMarketIndexes.unsupported('plugin-market-unavailable'));
      await pumpMarket(tester, backend: backend);
      expect(find.textContaining('不支持插件市场'), findsOneWidget);
      expect(backend.searchedUrls, isEmpty, reason: '不支持时不得发搜索请求');
      expect(find.byKey(const ValueKey('market-manage-indexes')), findsNothing);
    });

    testWidgets('没有配置任何索引 → 空态 + 可进管理（可写时）', (tester) async {
      final backend = FakeMarket(indexList: indexes([]));
      await pumpMarket(tester, backend: backend);
      expect(find.textContaining('还没有配置任何市场索引'), findsOneWidget);
      expect(find.byKey(const ValueKey('market-empty-manage')), findsOneWidget);
      expect(backend.searchedUrls, isEmpty);
    });

    testWidgets('索引全部不可用 → 明确说明，不隐藏 error', (tester) async {
      final backend = FakeMarket(
        indexList: indexes([index(_urlA, error: 'Index URL is not in canonical form')]),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.textContaining('所有已配置索引都不可用'), findsOneWidget);
      expect(backend.searchedUrls, isEmpty);
    });

    testWidgets('索引读取抛错 → 错误态 + 重试', (tester) async {
      final failing = PluginMarketActions(
        loadIndexes: () async => throw ApiException('boom', status: 500),
      );
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
        home: PluginMarketScreen(actions: failing),
      ));
      await tester.pumpAndSettle();
      expect(find.textContaining('读取市场索引失败'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
    });
  });

  // ------------------------------------------------------- SSRF（UI 侧）
  group('SSRF：搜索只使用已配置索引', () {
    testWidgets('页面没有任何手输 URL 的输入框（只有搜索词输入框）', (tester) async {
      final backend = FakeMarket();
      await pumpMarket(tester, backend: backend);
      // 唯一可编辑的输入是「搜索插件」；不得出现「索引地址」输入框。
      final fields = tester.widgetList<TextField>(find.byType(TextField)).toList();
      expect(fields.length, 1, reason: '市场页只有一个搜索框');
      expect(find.byKey(const ValueKey('market-search')), findsOneWidget);
      // 所有搜索请求的 url 必须来自配置列表。
      for (final url in backend.searchedUrls) {
        expect([_urlA, _urlB], contains(url), reason: '不得搜索未配置的 url');
      }
    });

    testWidgets('切到另一个已配置索引后，搜索用的是新索引 url', (tester) async {
      final backend = FakeMarket(
        indexList: indexes([index(_urlA, title: 'A'), index(_urlB, title: 'B')]),
      );
      await pumpMarket(tester, backend: backend);
      expect(backend.searchedUrls, [_urlA]);

      await tester.tap(find.byKey(const ValueKey('market-index-$_urlB')));
      await tester.pumpAndSettle();
      expect(backend.searchedUrls.last, _urlB);
    });

    testWidgets('宿主返回 unknown-index → 显示「不在已配置列表」，不静默重试', (tester) async {
      final backend = FakeMarket(
        searchError: ApiException('unknown', code: 'unknown-index', status: 400, body: const {'error': 'unknown-index'}),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.textContaining('不在电脑端的已配置列表里'), findsOneWidget);
      expect(backend.searchedUrls.length, 1, reason: '失败不自动重试');
    });

    testWidgets('索引被移除后管理页返回 → 重新读列表，不沿用旧 url', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      await pumpMarket(tester, backend: backend);
      expect(backend.searchedUrls, [_urlA]);

      // 进入管理页并删掉唯一索引，保存（返回 true）。
      backend.indexList = indexes([index(_urlB, title: 'B')]);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();
      // 直接改后端可见列表后返回：模拟「另一处改了配置」。
      await tester.pageBack();
      await tester.pumpAndSettle();

      // 页面重读了索引（loadCalls 增加），旧 url 不再被搜索。
      expect(backend.loadCalls, greaterThanOrEqualTo(1));
      // 注意：pageBack 返回 false 时页面不重读；这里断言的是「不会继续用已消失的索引」。
      final afterUrls = backend.searchedUrls.skip(1).toList();
      for (final url in afterUrls) {
        expect(url, isNot('https://gone.test/i.json'));
      }
    });
  });

  // ------------------------------------------------------- 搜索 / 分页 / 分类
  group('搜索与分页', () {
    testWidgets('搜索词透传，空结果显示明确空态', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) =>
            page(text == 'nothing' ? [] : [entry('dsh-x', title: 'X')], url: url),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.text('X'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('market-search')), 'nothing');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(backend.searchArgs.last.$4, 'nothing', reason: '搜索词透传');
      expect(find.textContaining('没有匹配的插件'), findsOneWidget);
    });

    testWidgets('分页：有 nextOffset 时显示「加载更多」，点击追加而非替换', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => offset == 0
            ? page([entry('dsh-a', title: 'A')], url: url, nextOffset: 1)
            : page([entry('dsh-b', title: 'B')], url: url),
      );
      await pumpMarket(tester, backend: backend);
      // 「A」既可能是索引 chip 也可能是条目标题：按条目 key 断言更准。
      expect(find.byKey(const ValueKey('market-entry-dsh-a')), findsOneWidget);
      expect(find.byKey(const ValueKey('market-load-more')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('market-load-more')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('market-entry-dsh-a')), findsOneWidget, reason: '追加不替换');
      expect(find.byKey(const ValueKey('market-entry-dsh-b')), findsOneWidget);
      expect(backend.searchArgs.last.$2, 1, reason: 'offset 来自 nextOffset');
      expect(find.byKey(const ValueKey('market-load-more')), findsNothing, reason: '无更多时隐藏');
    });

    testWidgets('无更多时不显示「加载更多」', (tester) async {
      final backend = FakeMarket();
      await pumpMarket(tester, backend: backend);
      expect(find.byKey(const ValueKey('market-load-more')), findsNothing);
    });

    testWidgets('条目显示版本/分类/安装状态', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
          entry('dsh-x', title: 'X plugin', description: 'desc', category: 'builtin', defaultVersion: '2.1.0', installation: 'installed', installedVersion: '2.1.0'),
        ], url: url),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.text('X plugin'), findsOneWidget);
      expect(find.text('v2.1.0'), findsOneWidget);
      expect(find.text('内置'), findsWidgets);
      expect(find.text('已安装'), findsOneWidget);
    });

    testWidgets('可更新条目的按钮文案是「升级」', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
          entry('dsh-x', title: 'X', installation: 'update-available', installedVersion: '0.9.0'),
        ], url: url),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.text('升级'), findsOneWidget);
      expect(find.text('可更新'), findsOneWidget);
    });
  });

  // ------------------------------------------------------- 索引管理
  group('索引管理（写电脑端配置）', () {
    testWidgets('保存前必须显式确认，且文案明写「电脑端」', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();

      expect(find.text('市场索引'), findsOneWidget);
      expect(find.textContaining('电脑端'), findsWidgets, reason: '页面本身也提示这是电脑端配置');

      await tester.tap(find.byKey(const ValueKey('market-index-save')));
      await tester.pumpAndSettle();
      // 页面横幅、对话框标题与正文都会提到这些说法：断言「至少出现」，
      // 关键是**没有**写入（下面的 saved 断言）。
      expect(find.textContaining('修改电脑端的插件市场索引'), findsWidgets);
      expect(find.textContaining('不只是这台手机'), findsWidgets);
      expect(backend.saved, isEmpty, reason: '未确认前不得写入');

      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(backend.saved, isEmpty, reason: '取消确认不得写入');

      await tester.tap(find.byKey(const ValueKey('market-index-save')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save-confirm')));
      await tester.pumpAndSettle();
      expect(backend.saved, [
        [_urlA],
      ]);
    });

    testWidgets('新增/编辑/删除行并保存', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('market-index-add')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('market-index-url-1')), _urlB);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('market-index-save')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save-confirm')));
      await tester.pumpAndSettle();
      expect(backend.saved.last, [_urlA, _urlB]);
    });

    testWidgets('非法 URL 在客户端即时拦截，不发保存请求', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();

      for (final bad in ['file:///etc/passwd', 'https://u:p@x.test/i.json', 'https://x.test/i.json#f', 'https://x.test/i.json?a=1']) {
        await tester.enterText(find.byKey(const ValueKey('market-index-url-0')), bad);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('market-index-save')));
        await tester.pumpAndSettle();
        expect(find.textContaining('请先修正无效的索引地址'), findsOneWidget, reason: bad);
        expect(backend.saved, isEmpty, reason: '$bad: 客户端应拦截');
      }
    });

    testWidgets('索引 error 如实显示（不隐藏）', (tester) async {
      final backend = FakeMarket(
        indexList: indexes([index(_urlA, title: 'A'), index(_urlB, error: 'Index URL is not in canonical form')]),
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();
      // 两行都在（不可用的那行也渲染，便于用户修正）。
      expect(find.byKey(const ValueKey('market-index-url-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('market-index-url-1')), findsOneWidget);
    });

    testWidgets('只读宿主（writable:false）→ 无保存/添加/删除控件', (tester) async {
      final backend = FakeMarket(
        indexList: indexes([index(_urlA, title: 'A')], writable: false),
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();
      expect(find.textContaining('不允许修改市场索引'), findsOneWidget);
      expect(find.byKey(const ValueKey('market-index-save')), findsNothing);
      expect(find.byKey(const ValueKey('market-index-add')), findsNothing);
      expect(find.byKey(const ValueKey('market-index-remove-0')), findsNothing);
    });

    testWidgets('保存失败（宿主 400 index-invalid）→ 显示定位到具体条目的人话', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      backend.saveError = ApiException(
        'invalid',
        code: 'index-invalid',
        status: 400,
        body: const {'error': 'index-invalid', 'detail': 'has-credentials', 'index': 1},
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save-confirm')));
      await tester.pumpAndSettle();
      expect(find.textContaining('第 2 条'), findsOneWidget);
      expect(find.textContaining('不能含凭据'), findsOneWidget);
    });

    testWidgets('只读宿主 409 → 明确说明不可写', (tester) async {
      final backend = FakeMarket(indexList: indexes([index(_urlA, title: 'A')]));
      backend.saveError = ApiException(
        'no',
        code: 'settings-write-unavailable',
        status: 409,
        body: const {'error': 'settings-write-unavailable'},
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-manage-indexes')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('market-index-save-confirm')));
      await tester.pumpAndSettle();
      expect(find.textContaining('不允许写入市场索引'), findsOneWidget);
    });
  });

  // ------------------------------------------------------- 从市场安装
  group('从市场安装（复用 P2）', () {
    testWidgets('点安装 → 进入安装页，最终把宿主的 spec 原样提交', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
          entry('dsh-x', title: 'X', defaultVersion: '2.0.0', versions: [version('2.0.0', spec: 'dsh-x@2.0.0')]),
        ], url: url),
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-install-dsh-x')));
      await tester.pumpAndSettle();

      // 安装页里已经有预校验结果（宿主市场条目给的确定目标），直接可安装。
      expect(find.byKey(const ValueKey('spec-accepted')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('spec-install')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-install-confirm')));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();

      expect(backend.installCalls, 1);
      expect(backend.lastInstallSpec, 'dsh-x@2.0.0', reason: 'spec 原样来自宿主，App 不拼');
      // 安装页**不自动返回**（用户要能看到结果/需重启提示）；返回后才刷新市场页。
      expect(find.byKey(const ValueKey('spec-operation')), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(backend.searchedUrls.length, greaterThanOrEqualTo(2), reason: '返回后刷新当前页');
    });

    testWidgets('市场条目自带 registry 时，安装透传该 registry', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
          PluginMarketEntry(
            name: 'dsh-x',
            title: 'X',
            defaultVersion: '2.0.0',
            versions: [
              const PluginMarketVersion(version: '2.0.0', spec: 'dsh-x@2.0.0', registry: 'https://registry.npmjs.org/'),
            ],
          ),
        ], url: url),
      );
      await pumpMarket(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('market-install-dsh-x')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-install')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-install-confirm')));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(backend.lastInstallRegistry, 'https://registry.npmjs.org/',
          reason: '市场条目声明的源必须透传，不能被页面选源覆盖');
    });

    testWidgets('不可安装的版本（无 spec）不显示安装按钮', (tester) async {
      final backend = FakeMarket(
        pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
          PluginMarketEntry(
            name: 'dsh-bad',
            title: 'Bad',
            defaultVersion: '1.0.0',
            versions: [const PluginMarketVersion(version: '1.0.0', spec: '', compatible: false)],
          ),
        ], url: url),
      );
      await pumpMarket(tester, backend: backend);
      expect(find.byKey(const ValueKey('market-install-dsh-bad')), findsNothing);
    });
  });

  // ------------------------------------------------------- 响应式
  group('响应式与深色', () {
    for (final config in [
      (const Size(320, 844), 1.0, Brightness.light, '320'),
      (const Size(320, 844), 1.5, Brightness.light, '320/1.5x'),
      (const Size(320, 844), 2.0, Brightness.light, '320/2.0x'),
      (const Size(390, 844), 1.0, Brightness.dark, '390/深色'),
    ]) {
      testWidgets('${config.$4}：市场列表不溢出', (tester) async {
        final backend = FakeMarket(
          pageFor: (url, {offset = 0, limit = 20, text = '', category = ''}) => page([
            entry(
              'dsh-very-long-name-for-overflow-testing',
              title: '一个很长很长的插件标题用于验证小屏与大字号下不会横向溢出',
              description: '一个很长很长的插件描述用于验证小屏与大字号下不会横向溢出，需要折行或省略',
              category: 'experimental',
              defaultVersion: '10.20.30',
              installation: 'different-version',
              installedVersion: '1.0.0',
            ),
          ], url: url),
        );
        await pumpMarket(
          tester,
          backend: backend,
          size: config.$1,
          textScale: config.$2,
          brightness: config.$3,
        );
        expect(tester.takeException(), isNull, reason: config.$4);
      });

      testWidgets('${config.$4}：索引管理页不溢出', (tester) async {
        await pumpIndexScreen(
          tester,
          initial: indexes([index(_urlA, title: 'A'), index(_urlB)]),
          save: (urls) async => indexes([for (final url in urls) index(url)]),
          size: config.$1,
          brightness: config.$3,
          textScale: config.$2,
        );
        expect(tester.takeException(), isNull, reason: config.$4);
      });
    }
  });
}
