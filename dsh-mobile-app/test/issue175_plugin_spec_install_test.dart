// issue #175 P2：任意 spec 安装（npm 包名 / GitHub / 电脑绝对路径 / tarball）。
//
// 本组测试钉住 App 侧的**边界**（宿主侧契约由 test/plugin-inventory-any-spec.test.mjs 覆盖）：
//   1. **App 不解析 spec**：输入原样交给宿主，不在客户端 trim/拼接/判形态；
//   2. 先预校验 → 显示宿主解析结果 → 显式确认 → 才安装；
//   3. 四种拒绝原因都有对应人话（且不显示 spec 原文）；
//   4. **build-blocked 只给「去电脑端授权」，没有批准按钮**；
//   5. 安装源复用 #175 P1 的「记住上次选择」；
//   6. 320 / 深色 / 1.5x / 2.0x 不溢出。
import 'package:dsh_mobile_app/api.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/plugin_install_source.dart';
import 'package:dsh_mobile_app/plugin_inventory.dart';
import 'package:dsh_mobile_app/screens/plugin_install_source_screen.dart'
    show pluginRegistryUrlError;
import 'package:dsh_mobile_app/screens/plugin_spec_install_screen.dart';
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
    PluginRegistry(id: 'registry', kind: 'registry', url: _officialUrl, display: 'registry.npmjs.org/', role: 'primary'),
    PluginRegistry(id: 'fallback:0', kind: 'registry', url: _mirrorUrl, display: 'registry.npmmirror.com/', role: 'fallback'),
  ],
);

PluginOperation operation({
  String action = 'install',
  String status = 'succeeded',
  String name = 'dsh-x',
  String version = '1.0.0',
  String errorCode = '',
  bool rolledBack = false,
  List<String> pendingBuilds = const [],
  List<PluginOperationStep> steps = const [],
}) => PluginOperation(
  opId: 'op-1',
  action: action,
  name: name,
  status: status,
  version: version,
  errorCode: errorCode,
  rolledBack: rolledBack,
  pendingBuilds: pendingBuilds,
  steps: steps,
  installSource: 'spec',
);

/// 记录调用参数的假宿主。
class FakeSpecBackend {
  FakeSpecBackend({
    this.inspectResult,
    this.inspectError,
    this.installResult,
    this.installError,
    this.pollResult,
  });

  PluginSpecInspection? inspectResult;
  Object? inspectError;
  PluginOperation? installResult;
  Object? installError;
  PluginOperation? pollResult;

  final List<String> inspected = [];
  final List<String?> inspectRegistries = [];
  final List<String> installed = [];
  final List<String?> installRegistries = [];
  int pollCalls = 0;

  Future<PluginSpecInspection> inspect(String spec, {String? registry}) async {
    inspected.add(spec);
    inspectRegistries.add(registry);
    if (inspectError != null) throw inspectError!;
    return inspectResult ?? accepted();
  }

  Future<PluginOperation> install(String spec, {String? registry}) async {
    installed.add(spec);
    installRegistries.add(registry);
    if (installError != null) throw installError!;
    return installResult ?? operation();
  }

  Future<PluginOperation> poll(String opId) async {
    pollCalls += 1;
    return pollResult ?? operation(status: 'succeeded');
  }

  Future<String> cancel(String opId) async => 'cancelled';

  static PluginSpecInspection accepted({
    String kind = 'registry',
    String name = 'dsh-x',
    String version = '1.0.0',
    String? host,
    String description = '',
  }) => PluginSpecInspection(
    supported: true,
    status: 'accepted',
    kind: kind,
    name: name,
    version: version,
    host: host ?? '',
    registry: _officialUrl,
    description: description,
    bundle: true,
  );

  static PluginSpecInspection refused(String problem, {String reason = ''}) =>
      PluginSpecInspection(
        supported: true,
        status: 'refused',
        problem: problem,
        reason: reason,
      );
}

Future<AppStore> makeStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

Future<void> pumpScreen(
  WidgetTester tester, {
  required FakeSpecBackend backend,
  AppStore? store,
  bool withRegistries = true,
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
        child: PluginSpecInstallScreen(
          store: appStore,
          inspect: backend.inspect,
          onInstall: backend.install,
          loadRegistries: withRegistries ? () async => _registryList : null,
          poll: backend.poll,
          cancel: backend.cancel,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> enterSpec(WidgetTester tester, String spec) async {
  await tester.enterText(find.byKey(const ValueKey('spec-input')), spec);
  await tester.pumpAndSettle();
}

/// 走完「预校验 → 安装 → 确认」。
///
/// **不**在末尾 pumpAndSettle：那会把 1 秒轮询一并推进，导致「安装中」状态被跳过。
/// 需要终态时由调用方显式 `pump(Duration(seconds: 1))` + `pumpAndSettle()`。
Future<void> inspectAndConfirm(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('spec-inspect')));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.byKey(const ValueKey('spec-install')));
  await tester.tap(find.byKey(const ValueKey('spec-install')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('spec-install-confirm')));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  // ---------------------------------------------------------- 输入与示例
  group('输入与示例', () {
    testWidgets('四类示例模板可一键填入，且示例不是真实包名', (tester) async {
      await pumpScreen(tester, backend: FakeSpecBackend());
      // 至少覆盖包名 / GitHub / 本地绝对路径 / tarball 四种形态。
      final examples = PluginSpecExample.all.map((e) => e.spec).toList();
      expect(examples.any((s) => s.startsWith('@')), isTrue, reason: 'npm 包名示例');
      expect(examples.any((s) => s.startsWith('github:')), isTrue, reason: 'GitHub 示例');
      expect(examples.any((s) => s.startsWith('/')), isTrue, reason: '本地绝对路径示例');
      expect(examples.any((s) => s.endsWith('.tgz')), isTrue, reason: 'tarball 示例');

      for (final spec in examples) {
        expect(find.byKey(ValueKey('spec-example-$spec')), findsOneWidget, reason: spec);
      }
      await tester.tap(find.byKey(const ValueKey('spec-example-github:owner/dsh-plugin')));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(find.byKey(const ValueKey('spec-input')));
      expect(field.controller!.text, 'github:owner/dsh-plugin');
    });

    testWidgets('UI 明示「填电脑上的路径，不是手机的」', (tester) async {
      await pumpScreen(tester, backend: FakeSpecBackend());
      // 文案可能出现在 hint 与说明两处，断言「至少出现」；关键是这两句都在。
      expect(find.textContaining('电脑上的绝对路径'), findsWidgets);
      expect(find.textContaining('不是手机的'), findsOneWidget);
      expect(find.textContaining('无法浏览电脑文件'), findsOneWidget);
      // 反例：不得暗示用户能浏览手机端目录。
      expect(find.textContaining('选择文件夹'), findsNothing);
      expect(find.textContaining('浏览文件'), findsNothing);
    });

    testWidgets('空输入不发请求、直接提示', (tester) async {
      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend);
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspected, isEmpty, reason: '空输入不该打宿主');
      expect(find.byKey(const ValueKey('spec-input-error')), findsOneWidget);
      expect(find.textContaining('请填写安装地址'), findsOneWidget);
    });

    testWidgets('超长（>2048）与控制字符在客户端即时拦住（仍由宿主兜底）', (tester) async {
      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, 'a' * 2049);
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspected, isEmpty);
      expect(find.textContaining('安装地址太长'), findsOneWidget);

      await enterSpec(tester, 'bad\u0000spec');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspected, isEmpty);
      expect(find.textContaining('控制字符'), findsOneWidget);
    });
  });

  // ---------------------------------------------------------- 预校验 → 确认 → 安装
  group('先预校验，再显式确认，才安装', () {
    testWidgets('accepted：显示宿主解析出的包名/版本/类型，确认后才调用安装', (tester) async {
      final backend = FakeSpecBackend(
        inspectResult: FakeSpecBackend.accepted(kind: 'git', name: 'dsh-git', version: '2.1.0', host: 'github.com'),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, 'github:owner/dsh-git');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();

      // spec 原样交给宿主（App 不 trim/拼接/改写）。
      expect(backend.inspected, ['github:owner/dsh-git']);
      expect(find.byKey(const ValueKey('spec-accepted')), findsOneWidget);
      expect(find.text('dsh-git'), findsOneWidget);
      expect(find.text('2.1.0'), findsOneWidget);
      expect(find.text('Git 仓库'), findsOneWidget);
      expect(find.text('github.com'), findsOneWidget);
      // 预校验阶段**不得**开始安装。
      expect(backend.installed, isEmpty, reason: '预校验不安装');

      // 点「安装」→ 先弹确认框（说明会改电脑端配置）。
      await tester.tap(find.byKey(const ValueKey('spec-install')));
      await tester.pumpAndSettle();
      expect(find.text('安装到电脑端？'), findsOneWidget);
      expect(find.textContaining('这会修改电脑端的插件配置'), findsOneWidget);
      expect(backend.installed, isEmpty, reason: '未确认前不得安装');

      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(backend.installed, isEmpty, reason: '取消确认不得安装');

      await tester.tap(find.byKey(const ValueKey('spec-install')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-install-confirm')));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(backend.installed, ['github:owner/dsh-git'], reason: 'spec 原样提交');
      expect(find.byKey(const ValueKey('spec-operation')), findsOneWidget);
    });

    testWidgets('安装中显示步骤，成功后显示版本', (tester) async {
      final backend = FakeSpecBackend(
        installResult: operation(
          status: 'running',
          steps: const [
            PluginOperationStep(key: 'prepare', state: 'done'),
            PluginOperationStep(key: 'install', state: 'running'),
          ],
        ),
        pollResult: operation(status: 'succeeded', version: '1.0.0'),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, '@scope/dsh-x');
      await inspectAndConfirm(tester);
      expect(find.textContaining('正在安装'), findsOneWidget);
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('安装完成 v1.0.0'), findsOneWidget);
    });

    testWidgets('旧宿主无预校验能力：说明清楚但仍可安装（不把用户卡死）', (tester) async {
      final backend = FakeSpecBackend(
        inspectResult: PluginSpecInspection.unsupported('inspect-unavailable'),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(find.textContaining('不支持安装前预校验'), findsOneWidget);
      final installButton = tester.widget<FilledButton>(find.byKey(const ValueKey('spec-install')));
      expect(installButton.onPressed, isNotNull, reason: '旧宿主不该禁用安装');
    });
  });

  // ---------------------------------------------------------- 四种拒绝原因
  group('四种拒绝原因都有人话，且不显示 spec 原文', () {
    for (final entry in <String, String>{
      'invalid-spec': '无法识别的安装地址',
      'already-installed': '已经安装在电脑上',
      'not-a-package': '不是可安装的包',
      'not-a-bundle': '没有声明 dsh.bundle',
    }.entries) {
      testWidgets('${entry.key} → 人话；安装按钮禁用；不显示原文', (tester) async {
        const secretSpec = '/home/mark/secret/internal/plugin';
        final backend = FakeSpecBackend(
          inspectResult: FakeSpecBackend.refused(entry.key),
        );
        await pumpScreen(tester, backend: backend);
        await enterSpec(tester, secretSpec);
        await tester.tap(find.byKey(const ValueKey('spec-inspect')));
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('spec-refused')), findsOneWidget);
        expect(find.textContaining(entry.value), findsOneWidget, reason: entry.key);
        // 拒绝时不得安装。
        final button = tester.widget<FilledButton>(find.byKey(const ValueKey('spec-install')));
        expect(button.onPressed, isNull, reason: '${entry.key}: 拒绝态不得安装');
        // 错误区不重复回显用户输入的原文（输入框里本来就有，但错误区不该复制）。
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('spec-refused')),
            matching: find.textContaining(secretSpec),
          ),
          findsNothing,
          reason: '拒绝原因不得回显 spec 原文',
        );
      });
    }

    test('problemText 覆盖宿主全部稳定码（缺一个就落到通用兜底）', () {
      const problems = [
        'invalid-spec',
        'already-installed',
        'not-found',
        'not-a-package',
        'not-a-bundle',
        'network',
        'unknown',
      ];
      for (final problem in problems) {
        final text = PluginSpecInspection(problem: problem).problemText;
        expect(text, isNotEmpty, reason: problem);
      }
      // 未知码用通用兜底，不臆造原因。
      expect(
        PluginSpecInspection(problem: 'something-new').problemText,
        contains('无法完成预校验'),
      );
    });

    test('服务端 400 的 detail/problem 都转成人话', () {
      expect(
        PluginSpecError.fromJson({'error': 'invalid-spec', 'detail': 'too-long'}).text(),
        contains('安装地址太长'),
      );
      expect(
        PluginSpecError.fromJson({'error': 'invalid-spec', 'detail': 'control-char'}).text(),
        contains('控制字符'),
      );
      expect(
        PluginSpecError.fromJson({'error': 'spec-refused', 'problem': 'not-a-bundle'}).text(),
        contains('dsh.bundle'),
      );
      expect(
        PluginSpecError.fromJson({'error': 'registry-invalid'}).text(),
        contains('http(s)'),
      );
    });

    testWidgets('预校验返回 400（超长）→ 显示服务端原话，不伪造成功', (tester) async {
      final backend = FakeSpecBackend(
        inspectError: ApiException(
          'too long',
          code: 'invalid-spec',
          status: 400,
          body: const {'error': 'invalid-spec', 'detail': 'too-long'},
        ),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('spec-error')), findsOneWidget);
      expect(find.textContaining('安装地址太长'), findsOneWidget);
      expect(find.byKey(const ValueKey('spec-accepted')), findsNothing);
    });
  });

  // ---------------------------------------------------------- build-blocked
  group('build-blocked：只指引去电脑端，不提供批准', () {
    testWidgets('失败显示「需电脑端授权」+ 待授权包名，且没有任何批准控件', (tester) async {
      final backend = FakeSpecBackend(
        installResult: operation(
          status: 'running',
          steps: const [PluginOperationStep(key: 'install', state: 'running')],
        ),
        pollResult: operation(
          status: 'failed',
          errorCode: 'build-blocked',
          rolledBack: true,
          version: '',
          pendingBuilds: const ['esbuild', '@scope/needs-build'],
        ),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, '@scope/dsh-scripts');
      await inspectAndConfirm(tester);
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();

      expect(find.text('需要在电脑端完成安装脚本授权'), findsOneWidget);
      expect(find.textContaining('安装脚本可以执行任意代码'), findsOneWidget);
      expect(find.textContaining('手机端不提供该授权'), findsOneWidget);
      expect(find.textContaining('esbuild'), findsOneWidget);
      expect(find.textContaining('@scope/needs-build'), findsOneWidget);
      expect(find.textContaining('在电脑端 DSH 设置'), findsOneWidget);

      // 关键断言：**没有任何可点击的批准入口**。
      // 注意不能按「文字含『批准』」判定——指引文案本身就要说“需在电脑端批准”；
      // 要判的是**控件**：不存在任何 action 按钮/开关承载批准语义。
      for (final labels in [
        ['批准', '允许', 'Approve', 'Allow', '同意'],
      ]) {
        for (final label in labels) {
          expect(
            find.widgetWithText(FilledButton, label),
            findsNothing,
            reason: '不得提供手机端批准按钮：$label',
          );
          expect(
            find.widgetWithText(OutlinedButton, label),
            findsNothing,
            reason: '不得提供手机端批准按钮：$label',
          );
          expect(
            find.widgetWithText(TextButton, label),
            findsNothing,
            reason: '不得提供手机端批准按钮：$label',
          );
        }
      }
      // 整个页面唯一的可写控件是“重新检查/安装”这类既有动作，没有构建授权通道。
      expect(find.byKey(const ValueKey('spec-approve')), findsNothing);
      expect(find.byKey(const ValueKey('spec-allow-build')), findsNothing);
      expect(find.byType(Switch), findsNothing);
      expect(find.byType(Checkbox), findsNothing);
    });

    test('PluginOperation 解析 build-blocked 与 pendingBuilds；旧载荷按 name 处理', () {
      final op = PluginOperation.fromJson({
        'opId': 'o',
        'action': 'install',
        'name': 'n',
        'status': 'failed',
        'errorCode': 'build-blocked',
        'pendingBuilds': ['a', '', 'b'],
        'source': 'spec',
      });
      expect(op.installSource, 'spec');
      expect(op.errorCode, 'build-blocked');
      expect(op.pendingBuilds, ['a', 'b']);

      final legacy = PluginOperation.fromJson({'opId': 'o', 'action': 'install', 'name': 'n'});
      expect(legacy.installSource, 'name', reason: '旧宿主无 source 字段 → 按配置渠道安装');
      expect(legacy.pendingBuilds, isEmpty);
    });

    testWidgets('普通失败不误报「需电脑端授权」', (tester) async {
      final backend = FakeSpecBackend(
        installResult: operation(status: 'running'),
        pollResult: operation(status: 'failed', errorCode: 'operation-error', rolledBack: true),
      );
      await pumpScreen(tester, backend: backend);
      await enterSpec(tester, '@scope/dsh-x');
      await inspectAndConfirm(tester);
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.text('需要在电脑端完成安装脚本授权'), findsNothing);
      expect(find.textContaining('已自动回滚'), findsOneWidget);
    });
  });

  // ---------------------------------------------------------- 复用 P1 选源
  group('安装源：复用 #175 P1 的「记住上次选择」', () {
    testWidgets('默认宿主源（registry 传 null）；选了回退源后带该 URL', (tester) async {
      final store = await makeStore();
      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend, store: store);

      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspectRegistries, [null], reason: '宿主默认源 = registry 不传');

      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('spec-source-$_mirrorUrl')),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-source-$_mirrorUrl')));
      await tester.pumpAndSettle();
      expect(
        store.pluginInstallSource,
        _mirrorUrl,
        reason: '切换即保存（复用 P1 的 PluginInstallSourceMemory）',
      );

      // 切源后重新预校验：应带上回退源 URL。
      // 预校验通过后「检查并继续」已被「重新检查/安装」取代，因此这里点「重新检查」；
      // 该按钮在预校验卡片里，需先滚回顶部。
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 1200));
      await tester.pumpAndSettle();
      await tester.tap(find.text('重新检查'));
      await tester.pumpAndSettle();
      expect(backend.inspectRegistries.last, _mirrorUrl);
    });

    testWidgets('重开页面仍记得上次选的源（偏好持久在 App 本地）', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final first = AppStore();
      await first.loadPrefs();
      await pumpScreen(tester, backend: FakeSpecBackend(), store: first);
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('spec-source-$_mirrorUrl')),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-source-$_mirrorUrl')));
      await tester.pumpAndSettle();

      // 「杀掉 App 重开」：同一份 mock 存储上新建 store + loadPrefs。
      final second = AppStore();
      await second.loadPrefs();
      expect(second.pluginInstallSource, _mirrorUrl);

      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend, store: second);
      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspectRegistries.last, _mirrorUrl, reason: '恢复上次选择');
    });

    testWidgets('存值失效（源从宿主列表消失）→ 静默回退默认源', (tester) async {
      final store = await makeStore();
      await store.setPluginInstallSource('https://gone.test/');
      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend, store: store);
      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspectRegistries, [null], reason: '失效值回退宿主默认源，不崩');
    });

    testWidgets('手动 URL 默认不记；勾了「记住此地址」才记', (tester) async {
      final store = await makeStore();
      await pumpScreen(tester, backend: FakeSpecBackend(), store: store);
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('spec-source-manual')),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('spec-manual-registry')), 'https://npm.corp.test/');
      await tester.pumpAndSettle();
      expect(store.pluginManualRegistryUrl, '', reason: '默认不记');

      await tester.tap(find.byKey(const ValueKey('spec-registry-remember')));
      await tester.pumpAndSettle();
      expect(store.pluginManualRegistryUrl, 'https://npm.corp.test/');
    });

    testWidgets('手动 URL 非法时在客户端即时提示，且不发请求', (tester) async {
      final backend = FakeSpecBackend();
      await pumpScreen(tester, backend: backend);
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('spec-source-manual')),
        240,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('spec-source-manual')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('spec-manual-registry')), 'file:///tmp/x');
      await tester.pumpAndSettle();
      await enterSpec(tester, '@scope/dsh-x');
      await tester.tap(find.byKey(const ValueKey('spec-inspect')));
      await tester.pumpAndSettle();
      expect(backend.inspected, isEmpty);
      expect(find.textContaining('只接受 http(s)'), findsWidgets);
    });

    test('共享的 URL 判据与 P1 完全一致（同一实现）', () {
      for (final url in [
        'https://npm.internal.test/',
        'http://127.0.0.1:4873/',
        'https://192.168.1.9:8081/repository/npm/',
      ]) {
        expect(pluginManualUrlError(url), '');
        expect(pluginRegistryUrlError(url), pluginManualUrlError(url));
      }
      for (final url in ['', '   ', 'file:///tmp/x', 'https://user:pw@x.test/', 'https://x.test/?a=1']) {
        expect(pluginManualUrlError(url), isNotEmpty, reason: url);
      }
    });
  });

  // ---------------------------------------------------------- 响应式
  group('响应式与深色', () {
    for (final config in [
      (const Size(320, 844), 1.0, Brightness.light, '320'),
      (const Size(320, 844), 1.5, Brightness.light, '320/1.5x'),
      (const Size(320, 844), 2.0, Brightness.light, '320/2.0x'),
      (const Size(390, 844), 1.0, Brightness.dark, '390/深色'),
    ]) {
      testWidgets('${config.$4}：输入/示例/预校验/源不溢出', (tester) async {
        final backend = FakeSpecBackend(
          inspectResult: FakeSpecBackend.accepted(
            kind: 'tarball',
            name: 'dsh-very-long-package-name-for-testing-overflow',
            version: '10.20.30',
            host: 'a-very-long-host-name-for-testing.example.internal',
            description: '一个很长的描述用于验证在小屏与大字号下不会横向溢出',
          ),
        );
        await pumpScreen(
          tester,
          backend: backend,
          size: config.$1,
          textScale: config.$2,
          brightness: config.$3,
        );
        await enterSpec(tester, 'https://example.test/a-very-long-tarball-name-1.0.0.tgz');
        await tester.tap(find.byKey(const ValueKey('spec-inspect')));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('spec-accepted')), findsOneWidget);
        expect(tester.takeException(), isNull, reason: config.$4);
        // 小屏 + 大字号下源选项在首屏之外（ListView 懒构建，元素可能还没创建）：
        // 先滚动把它造出来，再断言可点且不溢出。溢出判定已由上面的 takeException 覆盖。
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('spec-source-manual')),
          240,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('spec-source-manual')), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('spec-source-manual')));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '${config.$4}: 手动源输入');
      });
    }
  });
}

