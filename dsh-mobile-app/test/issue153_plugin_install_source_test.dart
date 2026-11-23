// issue #153：安装源选择页（三选一 + 手动 URL 仅本次生效 + 校验失败明确归因）。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_install_source_screen.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _registryList = PluginRegistryList(
  supported: true,
  complete: true,
  registries: [
    PluginRegistry(
      id: 'registry',
      kind: 'registry',
      url: 'https://registry.npmjs.org/',
      display: 'registry.npmjs.org/',
      role: 'primary',
    ),
    PluginRegistry(
      id: 'fallback:0',
      kind: 'registry',
      url: 'https://registry.npmmirror.com/',
      display: 'registry.npmmirror.com/',
      role: 'fallback',
    ),
  ],
);

PluginOperation op({String status = 'running', bool restartRequired = false}) =>
    PluginOperation(
      opId: 'op-1',
      action: 'install',
      name: 'dsh-voice-input',
      status: status,
      restartRequired: restartRequired,
      steps: const [
        PluginOperationStep(key: 'prepare', state: 'done'),
        PluginOperationStep(key: 'install', state: 'running'),
      ],
      answeredRegistry: 'https://registry.npmjs.org/',
    );

Future<void> pumpScreen(
  WidgetTester tester, {
  required Future<PluginOperation> Function(String registry) onInstall,
  Future<PluginRegistryList> Function()? loadRegistries = _loadList,
  Future<PluginOperation> Function(String opId)? poll,
  Future<String> Function(String opId)? cancel,
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
          category: const PluginCategory(kind: 'experimental', label: '实验性'),
          restartHint: true,
          loadRegistries: loadRegistries,
          onInstall: onInstall,
          poll: poll,
          cancel: cancel,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<PluginRegistryList> _loadList() async => _registryList;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('手动 URL 校验（与宿主同类判据，权威判定仍在服务端）', () {
    test('合法 http(s) 通过；末尾补斜杠由宿主负责（客户端不改写用户输入）', () {
      expect(pluginRegistryUrlError('https://npm.internal.test/'), '');
      expect(pluginRegistryUrlError('http://127.0.0.1:4873/'), '');
      expect(pluginRegistryUrlError('https://192.168.1.9:8081/repository/npm/'), '');
    });

    test('拒绝空、超长、空白、非 http(s)、凭据、query、fragment', () {
      expect(pluginRegistryUrlError(''), isNotEmpty);
      expect(pluginRegistryUrlError('   '), isNotEmpty);
      expect(pluginRegistryUrlError('https://exa mple.test/'), isNotEmpty);
      expect(pluginRegistryUrlError('file:///tmp/registry'), contains('http(s)'));
      expect(pluginRegistryUrlError('ftp://example.test/'), contains('http(s)'));
      expect(pluginRegistryUrlError('git+ssh://git@example.test/x.git'), contains('http(s)'));
      expect(pluginRegistryUrlError('https://u:p@example.test/'), contains('凭据'));
      expect(pluginRegistryUrlError('https://example.test/?q=1'), contains('查询'));
      expect(pluginRegistryUrlError('https://example.test/#f'), contains('片段'));
      expect(pluginRegistryUrlError('registry.npmjs.org'), isNotEmpty);
      expect(pluginRegistryUrlError('https://example.test/${'a' * 2100}'), isNotEmpty);
    });
  });

  group('页面', () {
    testWidgets('列出宿主只读源 + 手动 URL；默认选宿主配置渠道', (tester) async {
      var calls = 0;
      await pumpScreen(
        tester,
        onInstall: (_) async {
          calls += 1;
          return op(status: 'succeeded');
        },
      );
      expect(find.text('安装「语音输入」'), findsOneWidget);
      expect(find.text('宿主配置渠道'), findsOneWidget);
      expect(find.text('备选镜像'), findsOneWidget);
      expect(find.text('手动 http(s) URL'), findsOneWidget);
      // 首选源的 display 显示出来（不回显凭据/原始 URL）。
      expect(find.textContaining('registry.npmjs.org/'), findsWidgets);
      // 「将执行的安装」摘要。
      expect(find.text('将执行的安装'), findsOneWidget);
      expect(find.text('dsh-voice-input@0.7.0'), findsOneWidget);
      expect(find.textContaining('不传任意 tarball'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(calls, 1, reason: '默认来源也应当能直接安装');
    });

    testWidgets('默认来源传 null（沿用宿主解析顺序），不伪造具体 URL', (tester) async {
      String? received;
      await pumpScreen(
        tester,
        onInstall: (registry) async {
          received = registry;
          return op(status: 'succeeded');
        },
      );
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(received, '', reason: '未选具体源时不传 registry（页面用空串表示 null）');
    });

    testWidgets('选备选镜像 → 传该源 URL', (tester) async {
      String? received;
      await pumpScreen(
        tester,
        onInstall: (registry) async {
          received = registry;
          return op(status: 'succeeded');
        },
      );
      await tester.tap(find.text('备选镜像'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(received, 'https://registry.npmmirror.com/');
    });

    testWidgets('手动 URL：非法输入明确归因、不发请求；修好后可继续', (tester) async {
      final asked = <String>[];
      await pumpScreen(
        tester,
        onInstall: (registry) async {
          asked.add(registry);
          return op(status: 'succeeded');
        },
      );
      await tester.tap(find.text('手动 http(s) URL'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'https://u:p@npm.example.com/',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(asked, isEmpty, reason: '非法来源不得发请求');
      expect(find.textContaining('凭据'), findsWidgets);
      expect(find.text('修正来源后继续'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('install-source-url')),
        'https://npm.example.com',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(asked, ['https://npm.example.com']);
    });

    testWidgets('服务器 registry-invalid → 明确归因，不静默换源', (tester) async {
      await pumpScreen(
        tester,
        onInstall: (_) async => throw StateError('unused'),
        loadRegistries: _loadList,
      );
      // 用宿主侧错误码触发文案（模拟服务端拒绝客户端已通过的地址）。
      await tester.binding.setSurfaceSize(const Size(390, 844));
      await tester.pumpWidget(
        MaterialApp(
          theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
          home: PluginInstallSourceScreen(
            packageName: 'dsh-voice-input',
            displayName: '语音输入',
            packageSpec: 'dsh-voice-input@0.7.0',
            loadRegistries: _loadList,
            onInstall: (_) async => throw _FakeApiException('registry-invalid'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('安装源地址无效'), findsOneWidget);
    });

    testWidgets('旧宿主无 registries → 提示但仍可安装', (tester) async {
      await pumpScreen(
        tester,
        onInstall: (_) async => op(status: 'succeeded'),
        loadRegistries: () async => PluginRegistryList.unsupported('endpoint-missing'),
      );
      expect(find.textContaining('不提供安装源信息'), findsOneWidget);
      expect(find.text('手动 http(s) URL'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('安装完成'), findsWidgets);
    });

    testWidgets('安装中显示步骤；取消按钮在安装中可用；完成后显示结果', (tester) async {
      var cancels = 0;
      await pumpScreen(
        tester,
        onInstall: (_) async => op(status: 'running'),
        poll: (_) async => op(status: 'succeeded', restartRequired: true),
        cancel: (_) async {
          cancels += 1;
          return 'cancelled';
        },
      );
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pump();
      expect(find.textContaining('正在安装'), findsOneWidget);
      // 步骤可见。
      expect(find.textContaining('安装·'), findsWidgets);
      expect(find.textContaining('来源：https://registry.npmjs.org/'), findsOneWidget);
      // 取消入口存在且真的委托给宿主（安装仍可取消）。
      expect(find.widgetWithText(TextButton, '取消'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, '取消'));
      await tester.pump();
      expect(cancels, 1);

      // 轮询后完成。
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('需重启电脑端宿主'), findsOneWidget);
    });

    testWidgets('安装失败/回滚文案可见', (tester) async {
      await pumpScreen(
        tester,
        onInstall: (_) async => PluginOperation(
          opId: 'op-1',
          action: 'install',
          name: 'dsh-voice-input',
          status: 'failed',
          rolledBack: true,
          errorCode: 'incompatible-version',
        ),
      );
      await tester.tap(find.byKey(const ValueKey('install-source-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('已自动回滚'), findsOneWidget);
    });

    for (final config in [
      (const Size(320, 844), 1.5, Brightness.light, '320/1.5x'),
      (const Size(320, 844), 2.0, Brightness.light, '320/2.0x'),
      (const Size(390, 844), 1.0, Brightness.dark, '390/深色'),
    ]) {
      testWidgets('${config.$4}：不溢出、选项可读', (tester) async {
        await pumpScreen(
          tester,
          onInstall: (_) async => op(status: 'succeeded'),
          size: config.$1,
          textScale: config.$2,
          brightness: config.$3,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('宿主配置渠道'), findsOneWidget);
        expect(find.text('手动 http(s) URL'), findsOneWidget);
      });
    }
  });
}

/// 只带稳定 code 的假异常（模拟 ApiException 的可见契约）。
class _FakeApiException implements Exception {
  final String code;
  const _FakeApiException(this.code);
}
