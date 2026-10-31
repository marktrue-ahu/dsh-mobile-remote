import 'dart:convert';

import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/plugin_update_status.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<AppStore> makeStore() async {
    final store = AppStore();
    await store.loadPrefs();
    return store;
  }

  Future<void> openPreferenceDialog(WidgetTester tester, AppStore store) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final gitTabsIcon = find.byIcon(Icons.tab_outlined);
    await tester.scrollUntilVisible(
      gitTabsIcon,
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.ancestor(of: gitTabsIcon, matching: find.byType(InkWell)).first,
    );
    await tester.pumpAndSettle();
  }

  List<String?> displayedGitTabNames(WidgetTester tester) => tester
      .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
      .map((tile) => (tile.title! as Text).data)
      .toList();

  testWidgets('selects one tab and disables removing the last tab', (
    tester,
  ) async {
    final store = await makeStore();
    await openPreferenceDialog(tester, store);

    await tester.tap(find.text('图谱').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作区').last);
    await tester.pumpAndSettle();
    final removeBranches = tester.widget<CheckboxListTile>(
      find
          .ancestor(
            of: find.text('分支').last,
            matching: find.byType(CheckboxListTile),
          )
          .first,
    );
    expect(removeBranches.onChanged, isNull);
    expect(store.gitTabs, ['branches', 'graph', 'worktree']);

    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(store.gitTabs, ['branches']);
  });

  testWidgets(
    'reorders tabs, saves, and shows persisted order after reopening',
    (tester) async {
      final store = await makeStore();
      await openPreferenceDialog(tester, store);

      await tester.tap(find.byTooltip('上移 工作区'));
      await tester.pumpAndSettle();
      expect(displayedGitTabNames(tester), [
        '分支',
        '工作区',
        '图谱',
      ], reason: '设置弹窗应立即按已选标签顺序展示');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(store.gitTabs, ['branches', 'worktree', 'graph']);

      final restored = await makeStore();
      await openPreferenceDialog(tester, restored);
      expect(restored.gitTabs, ['branches', 'worktree', 'graph']);
      expect(find.text('分支 · 工作区 · 图谱'), findsOneWidget);
      expect(displayedGitTabNames(tester), ['分支', '工作区', '图谱']);
      expect(find.byTooltip('上移 工作区'), findsOneWidget);
    },
  );

  testWidgets('reorders tabs down and updates displayed row order', (
    tester,
  ) async {
    final store = await makeStore();
    await openPreferenceDialog(tester, store);

    await tester.tap(find.byTooltip('下移 图谱'));
    await tester.pumpAndSettle();

    expect(displayedGitTabNames(tester), ['分支', '工作区', '图谱']);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(store.gitTabs, ['branches', 'worktree', 'graph']);
  });

  testWidgets('keeps unselected tabs below selected tabs', (tester) async {
    final store = await makeStore();
    await openPreferenceDialog(tester, store);

    await tester.tap(find.byTooltip('上移 工作区'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('图谱').last);
    await tester.pumpAndSettle();

    final rows = tester
        .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
        .toList();
    expect(rows.map((tile) => (tile.title! as Text).data).toList(), [
      '分支',
      '工作区',
      '图谱',
    ]);
    expect(rows.last.value, isFalse);
  });

  testWidgets(
    'always exposes a desktop plugin update entry that checks the host',
    (tester) async {
      final requestedPaths = <String>[];
      String? copied;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String?;
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final api = Api(
        client: MockClient((request) async {
          requestedPaths.add(request.url.path);
          if (request.url.path.endsWith('/api/plugin-update/check')) {
            return http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'ok': true,
                  'pluginUpdate': {
                    'state': 'up-to-date',
                    'reason': 'same-version-same-content',
                    'canSelfUpdate': true,
                    'installShape': 'npm',
                    'restartForm': 'systemd',
                    'transaction': null,
                    'remote': {'version': '3.2.2-alpha.4'},
                    'checkLog': [
                      '# 本机版本 3.2.2-alpha.4 · NPM 通道 alpha',
                      r'$ npm view @marktrue/dsh-mobile-remote dist-tags --json',
                      '→ alpha=3.2.2-alpha.4',
                    ],
                  },
                }),
              ),
              200,
            );
          }
          return http.Response('{}', 200);
        }),
      )..baseUrl = 'https://desktop.example';
      final store = AppStore(apiClient: api);
      addTearDown(store.dispose);
      await store.loadPrefs();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SettingsScreen(store: store, onReconfigure: () async {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final title = find.text('更新电脑端插件');
      await tester.scrollUntilVisible(
        title,
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(title, findsOneWidget, reason: '未知是否有新版时也必须能触发检查');
      final row = find
          .ancestor(of: title, matching: find.byType(InkWell))
          .first;
      expect(
        find.descendant(of: row, matching: find.text('检查 ▸')),
        findsOneWidget,
      );
      await tester.tap(row);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        requestedPaths.where((p) => p.endsWith('/api/plugin-update/check')),
        isNotEmpty,
      );
      expect(find.text('电脑端插件已是最新'), findsOneWidget);
      // 更新详情：与桌面端一致，展示宿主的脱敏 npm 查询/结果，并可复制。
      final detailsTitle = find.text('插件更新详情');
      expect(detailsTitle, findsOneWidget);
      await tester.scrollUntilVisible(
        detailsTitle,
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      final detailsRow = find
          .ancestor(of: detailsTitle, matching: find.byType(InkWell))
          .first;
      await tester.tap(
        find.descendant(of: detailsRow, matching: find.text('查看 ▸')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining(r'$ npm view'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('复制'),
        ),
      );
      await tester.pump();
      expect(copied, contains(r'$ npm view @marktrue/dsh-mobile-remote'));
    },
  );

  testWidgets('merged update details show install log and failure reason', (
    tester,
  ) async {
    String? copied;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    final api = Api(
      client: MockClient((request) async {
        if (request.url.path.endsWith('/api/plugin-update/log')) {
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'ok': true,
                'opId': 'op-fail',
                'phase': 'failed',
                'events': [
                  {
                    'seq': 1,
                    'stage': 'staging',
                    'stream': 'status',
                    'text': 'NPM plugin update accepted',
                  },
                  {
                    'seq': 2,
                    'stage': 'failed',
                    'stream': 'status',
                    'text': 'Plugin update failed: npm-carrier-plugin-identity-mismatch',
                  },
                ],
              }),
            ),
            200,
          );
        }
        return http.Response('{}', 200);
      }),
    )..baseUrl = 'https://desktop.example';
    api.pluginUpdate = PluginUpdateStatus.fromJson({
      'state': 'unavailable',
      'reason': 'update-failed',
      'canSelfUpdate': true,
      'checkLog': [
        '# 本机版本 3.2.1-alpha.3 · NPM 通道 alpha',
        r'$ npm view @marktrue/dsh-mobile-remote dist-tags --json',
        '→ alpha=3.2.2-alpha.6',
      ],
      'transaction': {
        'opId': 'op-fail',
        'phase': 'failed',
        'targetVersion': '3.2.2-alpha.6',
        'targetContentSha256': List.filled(64, 'b').join(),
        'result': {
          'ok': false,
          'reason': 'npm-carrier-plugin-identity-mismatch',
        },
      },
    });
    final store = AppStore(apiClient: api);
    addTearDown(store.dispose);
    await store.loadPrefs();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final title = find.text('插件更新详情');
    await tester.scrollUntilVisible(
      title,
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    final row = find.ancestor(of: title, matching: find.byType(InkWell)).first;
    await tester.tap(find.descendant(of: row, matching: find.text('查看 ▸')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byType(BottomSheet), findsOneWidget);
    // 检查详情、安装详情、失败原因三部分都在同一个详情里。
    expect(find.textContaining(r'$ npm view'), findsOneWidget);
    expect(find.textContaining('安装详情'), findsOneWidget);
    expect(
      find.textContaining(
        'Plugin update failed: npm-carrier-plugin-identity-mismatch',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('载体清单与 NPM 包身份不一致'), findsOneWidget);
    final copyButton = find.descendant(
      of: find.byType(BottomSheet),
      matching: find.text('复制'),
    );
    await tester.tap(copyButton);
    await tester.pump();
    expect(copied, contains('npm-carrier-plugin-identity-mismatch'));
    expect(copied, contains(r'$ npm view'));
  });
}
