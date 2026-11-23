// issue #153：模型与 API 层契约（宿主字段解析、registry 透传、归因、Drawer 入口）。
import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/main.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_management_widgets.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Api apiWith(MockClient client) => Api(client: client)
  ..baseUrl = 'http://127.0.0.1:1'
  ..token = 't';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('解析：分类 / HIDDEN / classification', () {
    test('完整宿主形状：六个顶层字段 + category + hidden', () {
      final data = PluginInventory.fromJson({
        'ok': true,
        'supported': true,
        'complete': true,
        'classification': {
          'tableVersion': '2026.11',
          'targetDsh': '0.2.2',
          'dshVersion': '0.2.2-rc.5',
          'matched': true,
          'source': 'static-table',
        },
        'plugins': [
          {
            'name': '@deepseek-ai/dsh-experimental-auto-review',
            'packageName': '@deepseek-ai/dsh-experimental-auto-review',
            'version': '1.0.0',
            'source': {'kind': 'registry', 'label': '配置渠道'},
            'official': true,
            'optional': true,
            'availability': 'profile',
            'installed': true,
            'category': {
              'kind': 'experimental',
              'label': '实验性',
              'reason': '',
            },
            'hidden': false,
            'management': {'canUpdate': true},
            'updateKind': 'registry',
          },
          {
            'name': '@deepseek-ai/dsh-base',
            'packageName': '@deepseek-ai/dsh-base',
            'category': {'kind': 'builtin', 'label': '内置', 'reason': ''},
            'hidden': true,
          },
        ],
        'installable': [
          {
            'name': 'dsh-new',
            'packageName': 'dsh-new',
            'version': '2.0.0',
            'category': {'kind': 'custom', 'label': '自定义', 'reason': ''},
            'hidden': false,
          },
        ],
      });
      expect(data.hasCategories, isTrue);
      expect(data.classification.matched, isTrue);
      expect(data.plugins.first.category.isExperimental, isTrue);
      expect(data.plugins.first.canUpdate, isTrue);
      expect(data.plugins[1].hidden, isTrue);
      expect(data.installable.single.category.isCustom, isTrue);
      expect(data.installable.single.hasCategory, isTrue);
    });

    test('降级原因码可读：host-facts-missing / independent-entry', () {
      expect(
        const PluginCategory(
          kind: 'unclassified',
          reason: 'host-facts-missing',
        ).reasonText,
        contains('未提供分类'),
      );
      expect(
        const PluginCategory(
          kind: 'unclassified',
          reason: 'independent-entry',
        ).reasonText,
        contains('配置条目'),
      );
      expect(const PluginCategory(kind: 'builtin').reasonText, '');
    });
  });

  group('API：registry 透传与端点降级', () {
    test('pluginVersions 带 registry 时进 query；不带时不出现 registry 参数', () async {
      final urls = <String>[];
      final api = apiWith(
        MockClient((request) async {
          urls.add(request.url.toString());
          return http.Response(
            '{"status":"listed","versions":[],"answeredRegistry":"https://a.test/","attempts":[]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      await api.pluginVersions('dsh-up');
      await api.pluginVersions(
        'dsh-up',
        registry: 'https://npm.internal.test/',
      );
      expect(urls[0], isNot(contains('registry=')));
      expect(
        urls[1],
        contains('registry=${Uri.encodeQueryComponent('https://npm.internal.test/')}'),
      );
    });

    test('pluginInstall/pluginUpgrade 只在有 registry 时带字段', () async {
      final bodies = <Map<String, dynamic>>[];
      final api = apiWith(
        MockClient((request) async {
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          return http.Response(
            '{"ok":true,"operation":{"opId":"o","action":"install","name":"x"}}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      await api.pluginInstall('dsh-new');
      await api.pluginInstall('dsh-new', registry: 'https://a.test/');
      await api.pluginUpgrade('dsh-up', '1.1.0');
      await api.pluginUpgrade('dsh-up', '1.1.0', registry: 'https://a.test/');
      expect(bodies[0].containsKey('registry'), isFalse);
      expect(bodies[1]['registry'], 'https://a.test/');
      expect(bodies[2].containsKey('registry'), isFalse);
      expect(bodies[3]['registry'], 'https://a.test/');
    });

    test('pluginRegistries：404/405 → supported:false（不当作网络失败）', () async {
      final old = apiWith(
        MockClient((_) async => http.Response('{"error":"not-found"}', 404)),
      );
      final list = await old.pluginRegistries();
      expect(list.supported, isFalse);
      expect(list.available, isFalse);
      expect(list.reason, 'endpoint-missing');

      final fresh = apiWith(
        MockClient(
          (_) async => http.Response(
            '{"ok":true,"supported":true,"complete":true,"writable":false,'
            '"registries":[{"id":"registry","kind":"registry",'
            '"url":"https://registry.npmjs.org/","display":"registry.npmjs.org/",'
            '"role":"primary"}]}',
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );
      final live = await fresh.pluginRegistries();
      expect(live.available, isTrue);
      expect(live.registries.single.roleLabel, '宿主配置渠道');
      expect(live.registries.single.displayLabel, 'registry.npmjs.org/');
    });

    test('操作快照解析源归因（registries/attempt/answeredRegistry）', () {
      final operation = PluginOperation.fromJson({
        'opId': 'o',
        'action': 'install',
        'name': 'dsh-new',
        'status': 'succeeded',
        'registries': ['https://a.test/', 'https://b.test/'],
        'attempt': {'index': 2, 'total': 2},
        'answeredRegistry': 'https://b.test/',
      });
      expect(operation.registries, ['https://a.test/', 'https://b.test/']);
      expect(operation.attemptIndex, 2);
      expect(operation.attemptTotal, 2);
      expect(operation.answeredRegistry, 'https://b.test/');

      final legacy = PluginOperation.fromJson({
        'opId': 'o',
        'action': 'install',
        'name': 'dsh-new',
        'status': 'succeeded',
      });
      expect(legacy.registries, isEmpty);
      expect(legacy.answeredRegistry, '');
    });

    test('版本检查归因解析：requestedRegistry/answeredRegistry/attempts', () {
      final check = PluginVersionCheck.fromJson({
        'status': 'refused',
        'problem': 'network',
        'requestedRegistry': 'https://a.test/',
        'answeredRegistry': null,
        'attempts': [
          {'registry': 'https://a.test/', 'problem': 'network'},
        ],
      });
      expect(check.requestedRegistry, 'https://a.test/');
      expect(check.answeredRegistry, '');
      expect(check.attempts.single.problem, 'network');
      expect(check.listed, isFalse);
    });
  });

  group('Drawer 一级入口', () {
    testWidgets('插件入口可见且点击回调；未注入回调时不渲染', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final store = AppStore();
      await store.loadPrefs();
      var opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: Scaffold(
            drawer: AppDrawer(
              store: store,
              selectedIndex: 0,
              onSelect: (_) {},
              onNewSession: () {},
              onOpenConnections: () {},
              onOpenPlugins: () => opened += 1,
            ),
          ),
        ),
      );
      final state = tester.firstState<ScaffoldState>(find.byType(Scaffold));
      state.openDrawer();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('drawer-plugins')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('drawer-plugins')));
      await tester.pumpAndSettle();
      expect(opened, 1);

      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: Scaffold(
            drawer: AppDrawer(
              store: store,
              selectedIndex: 0,
              onSelect: (_) {},
              onNewSession: () {},
              onOpenConnections: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final state2 = tester.firstState<ScaffoldState>(find.byType(Scaffold));
      state2.openDrawer();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('drawer-plugins')), findsNothing);
    });
  });

  group('Tab 文案', () {
    test('分类标签/搜索提示/空态按分类区分', () {
      expect(pluginCategoryLabel('builtin'), '内置');
      expect(pluginCategoryLabel('experimental'), '实验性');
      expect(pluginCategoryLabel('custom'), '自定义');
      expect(pluginSearchHint('builtin'), '搜索内置插件');
      expect(pluginSearchHint('experimental'), '搜索实验性插件');
      expect(pluginSearchHint('custom'), '搜索自定义插件');
      expect(pluginTabEmptyText('builtin'), '没有内置插件');
      expect(pluginTabEmptyText('experimental'), contains('实验性'));
      expect(pluginTabEmptyText('custom'), '没有自定义插件');
      expect(pluginTabNoInstallableText('builtin'), contains('内置'));
      expect(pluginTabNoInstallableText('experimental'), contains('实验性'));
      expect(pluginTabNoInstallableText('custom'), contains('自定义'));
    });
  });
}
