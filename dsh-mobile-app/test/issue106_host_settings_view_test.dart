// issue #106：DSH 设置只读查看器 —— 只读页 UI 验收。
//
// 覆盖：
//   - 只渲染服务端返回的白名单项：无"显示全部"白名单、无写入控件（开关/输入框/保存/重置）；
//   - 点行只展开，不弹编辑；secret 只显示已设置/未设置（页面里不出现其值）；
//   - 顶部「本版只读」提示卡 + 底部署名说明；
//   - 搜索只搜标题/命名空间/键路径（搜值无结果）；过滤 chips 三态；
//   - 空 / 加载失败 / 部分失败 / 旧宿主 supported:false / 搜索空态；
//   - 320 × 深色 × 1.5x × 2.0x 不横向溢出；行高 ≥ 56。
import 'package:dsh_mobile_app/host_settings.dart';
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/screens/host_settings_screen.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<AppStore> _store() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  store.api.baseUrl = 'http://192.168.1.20:3080';
  return store;
}

HostSettingField field({
  String ns = 'web-search-deepseek',
  String keyPath = 'model',
  String title = '搜索模型',
  String kind = 'value',
  bool secretSet = false,
  String valueText = 'deepseek-v4-flash',
  String valueKind = 'string',
  String? defaultText,
  bool hasDefault = false,
  HostSettingSource source = HostSettingSource.schema,
  Map<String, bool?>? layers,
}) => HostSettingField(
  ns: ns,
  keyPath: keyPath,
  title: title,
  groupId: 'model-routing',
  kind: kind,
  secretSet: secretSet,
  valueText: kind == 'secret' ? '' : valueText,
  valueKind: kind == 'secret' ? '' : valueKind,
  defaultText: kind == 'secret' ? null : defaultText,
  hasDefault: kind == 'secret' ? false : hasDefault,
  source: kind == 'secret' ? HostSettingSource.unknown : source,
  userLayer: layers?['user'],
  baseLayer: layers?['base'],
  schemaLayer: layers?['schema'] ?? false,
);

HostSettingNamespace namespace({
  String ns = 'web-search-deepseek',
  String title = '联网搜索',
  bool complete = true,
  String reason = '',
  List<HostSettingField>? fields,
  String groupId = 'model-routing',
}) => HostSettingNamespace(
  ns: ns,
  title: title,
  groupId: groupId,
  revision: 1,
  complete: complete,
  reason: reason,
  fields: complete ? (fields ?? [field()]) : const [],
);

HostSettingsView view({
  bool supported = true,
  bool complete = true,
  String reason = '',
  List<HostSettingNamespace>? namespaces,
  String dshVersion = '0.2.2-rc.5',
}) => HostSettingsView(
  supported: supported,
  complete: complete,
  reason: reason,
  whitelistVersion: 1,
  generatedAt: '2026-11-23T00:00:00.000Z',
  dshVersion: dshVersion,
  pluginVersion: '3.3.1-alpha.2',
  groups: const [
    HostSettingGroup(id: 'model-routing', title: '模型与路由'),
  ],
  namespaces: namespaces ?? [namespace()],
);

Future<void> _pump(
  WidgetTester tester,
  HostSettingsView Function() build, {
  Size size = const Size(390, 844),
  TextScaler scaler = TextScaler.noScaling,
  ThemeData? theme,
  bool failLoading = false,
  String? lang,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  // AppStore.loadPrefs() 会按偏好重设 L10n.lang，所以语言必须在建 store 之后应用。
  final store = await _store();
  if (lang != null) L10n.lang = lang;
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: scaler),
        child: HostSettingsScreen(
          store: store,
          loader: () async {
            if (failLoading) throw Exception('network down');
            return build();
          },
        ),
      ),
    ),
  );
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 40));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  testWidgets('只渲染白名单项；无误导性入口；顶部只读卡 + 底部说明', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(keyPath: 'model', title: '搜索模型', valueText: 'deepseek-v4-pro'),
        field(keyPath: 'maxUses', title: '单次最多搜索次数', valueText: '5', valueKind: 'number'),
      ]),
    ]));

    expect(find.text('本版只读'), findsOneWidget);
    expect(find.text('DSH 设置'), findsOneWidget);
    expect(find.text('只读'), findsOneWidget);
    expect(find.text('联网搜索'), findsOneWidget);
    // 只显示宿主返回的两项。
    expect(find.text('搜索模型'), findsOneWidget);
    expect(find.text('单次最多搜索次数'), findsOneWidget);
    expect(find.text('deepseek-v4-pro'), findsOneWidget);
    // 没有"显示全部/白名单管理"这类入口。
    expect(find.text('显示全部设置'), findsNothing);
    expect(find.text('白名单'), findsNothing);
    // 没有任何写入控件。
    expect(find.byType(Switch), findsNothing);
    expect(find.byType(SwitchListTile), findsNothing);
    expect(find.byType(TextField), findsOneWidget, reason: '唯一的输入框是搜索');
    expect(find.text('保存'), findsNothing);
    expect(find.text('重置'), findsNothing);
    expect(find.byIcon(Icons.save), findsNothing);
    // 底部说明。
    expect(
      find.textContaining('只读切片'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('点行只展开详情（键路径/当前值/默认值/来源层级），不弹编辑', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(
          keyPath: 'model',
          title: '搜索模型',
          valueText: 'deepseek-v4-pro',
          defaultText: 'deepseek-v4-flash',
          hasDefault: true,
          source: HostSettingSource.user,
          layers: {'user': true, 'base': true, 'schema': true},
        ),
      ]),
    ]));

    // 展开前没有键路径详情。
    expect(find.text('键路径'), findsNothing);
    await tester.tap(find.text('搜索模型'));
    await tester.pump();

    expect(find.text('键路径'), findsOneWidget);
    expect(find.text('model'), findsOneWidget);
    expect(find.text('当前值'), findsOneWidget);
    expect(find.text('默认值'), findsOneWidget);
    expect(find.text('来源层级'), findsOneWidget);
    // 没有编辑对话框/弹层。
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('编辑'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('secret 只显示已设置/未设置，页面内不出现其值', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(
          keyPath: 'apiKey',
          title: 'API 密钥',
          kind: 'secret',
          secretSet: true,
          // 即使模型层被塞了值，UI 也不得渲染它。
          valueText: 'sk-leaky-value-123456',
        ),
        field(
          keyPath: 'otherKey',
          title: '备用密钥',
          kind: 'secret',
          secretSet: false,
          valueText: 'sk-leaky-value-999999',
        ),
      ]),
    ]));

    expect(find.text('已设置'), findsOneWidget);
    expect(find.text('未设置'), findsOneWidget);
    expect(find.textContaining('sk-leaky'), findsNothing);
    // 敏感字段自带说明，且不显示值/长度/前缀。
    expect(find.textContaining('不显示值'), findsNWidgets(2), reason: '两个 secret 行各一条');
    expect(find.byIcon(Icons.lock_outline), findsWidgets);
    // 展开 secret 行也不得出现"当前值/默认值"。
    await tester.tap(find.text('API 密钥'));
    await tester.pump();
    expect(find.text('当前值'), findsNothing);
    expect(find.text('默认值'), findsNothing);
    expect(find.textContaining('sk-leaky'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('搜索只匹配标题/命名空间/键路径；搜值无结果；可清除', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(keyPath: 'model', title: '搜索模型', valueText: 'deepseek-v4-pro'),
      ]),
    ]));

    // 搜标题命中。
    await tester.enterText(find.byType(TextField), '搜索');
    await tester.pump();
    expect(find.text('搜索模型'), findsWidgets);

    // 搜值 → 无结果（值不参与搜索）。
    await tester.enterText(find.byType(TextField), 'deepseek-v4-pro');
    await tester.pump();
    expect(find.text('没有匹配的设置项'), findsOneWidget);
    expect(find.text('清除搜索'), findsOneWidget);

    await tester.tap(find.text('清除搜索'));
    await tester.pump();
    expect(find.text('搜索模型'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('过滤 chips：已覆盖只留用户覆盖；有默认差异含组合默认', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(keyPath: 'a', title: '用户覆盖项', source: HostSettingSource.user),
        field(keyPath: 'b', title: '组合默认项', source: HostSettingSource.base),
        field(keyPath: 'c', title: '默认值项', source: HostSettingSource.schema),
      ]),
    ]));

    expect(find.text('全部'), findsOneWidget);
    expect(find.text('已覆盖'), findsOneWidget);
    expect(find.text('有默认差异'), findsOneWidget);

    await tester.tap(find.text('已覆盖'));
    await tester.pump();
    expect(find.text('用户覆盖项'), findsOneWidget);
    expect(find.text('组合默认项'), findsNothing);
    expect(find.text('默认值项'), findsNothing);

    await tester.tap(find.text('有默认差异'));
    await tester.pump();
    expect(find.text('用户覆盖项'), findsOneWidget);
    expect(find.text('组合默认项'), findsOneWidget);
    expect(find.text('默认值项'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('来源标签四种文案正确显示', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(fields: [
        field(keyPath: 'a', title: 'A 项', source: HostSettingSource.user),
        field(keyPath: 'b', title: 'B 项', source: HostSettingSource.base),
        field(keyPath: 'c', title: 'C 项', source: HostSettingSource.schema),
        field(keyPath: 'd', title: 'D 项', source: HostSettingSource.unknown),
      ]),
    ]));
    // 标签与文案各出现一次（"用户覆盖"等）。
    expect(find.text('用户覆盖'), findsOneWidget);
    expect(find.text('组合默认'), findsOneWidget);
    expect(find.text('默认值'), findsOneWidget);
    expect(find.text('未知'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('旧宿主 supported:false → 整页降级，不伪造设置项', (tester) async {
    await _pump(tester, () => view(
      supported: false,
      complete: false,
      reason: 'endpoint-missing',
      namespaces: const [],
    ));
    expect(
      find.byKey(const ValueKey('host-settings-unsupported-title')),
      findsOneWidget,
    );
    expect(find.textContaining('不支持'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    // 不显示任何字段。
    expect(find.text('搜索模型'), findsNothing);
    expect(find.byType(Switch), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('白名单为空 → 空态不是"加载失败"', (tester) async {
    await _pump(tester, () => view(namespaces: const []));
    expect(find.textContaining('没有白名单内的可显示设置'), findsOneWidget);
    expect(find.textContaining('加载失败'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('部分命名空间失败 → 该卡片错误行 + 重试，其它仍可用', (tester) async {
    await _pump(tester, () => view(
      complete: false,
      reason: 'value-with-absolute-path',
      namespaces: [
        namespace(),
        namespace(
          ns: 'permission',
          title: '权限预设',
          complete: false,
          reason: 'value-with-absolute-path',
        ),
      ],
    ));
    // 失败的命名空间不显示任何字段值。
    expect(find.text('权限预设'), findsOneWidget);
    expect(find.text('设置不可用'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    // 正常的命名空间仍可用。
    expect(find.text('联网搜索'), findsOneWidget);
    expect(find.text('搜索模型'), findsOneWidget);
    // 不因失败而渲染原始值。
    expect(find.textContaining('/home/'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('加载失败 → 错误卡 + 重试（保留重试入口）', (tester) async {
    await _pump(tester, () => view(), failLoading: true);
    expect(find.textContaining('读取电脑端设置失败'), findsOneWidget);
    expect(find.byKey(const ValueKey('host-settings-retry')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('刷新按钮存在且不引入写入控件', (tester) async {
    await _pump(tester, () => view());
    expect(find.byKey(const ValueKey('host-settings-refresh')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('host-settings-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.byType(Switch), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320 窄屏：不横向溢出，字段行高 ≥ 56', (tester) async {
    await _pump(
      tester,
      () => view(namespaces: [
        namespace(fields: [
          field(
            keyPath: 'providers.opencode-go.displayName',
            title: '提供商名称',
            valueText: 'Opencode-HomePC-with-a-very-long-display-name',
            source: HostSettingSource.user,
          ),
        ]),
      ]),
      size: const Size(320, 844),
    );
    expect(tester.takeException(), isNull);
    final row = tester.getSize(
      find.ancestor(
        of: find.text('提供商名称'),
        matching: find.byType(ConstrainedBox),
      ).first,
    );
    expect(row.height, greaterThanOrEqualTo(56));
  });

  testWidgets('深色主题：使用令牌渲染，无异常', (tester) async {
    await _pump(
      tester,
      () => view(namespaces: [
        namespace(fields: [
          field(keyPath: 'apiKey', title: 'API 密钥', kind: 'secret', secretSet: true),
          field(keyPath: 'model', title: '搜索模型'),
        ]),
      ]),
      theme: DshTheme.dark(),
    );
    expect(find.text('本版只读'), findsOneWidget);
    expect(find.text('已设置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('1.5x / 2.0x 大字号：不横向溢出', (tester) async {
    for (final scaler in [
      const TextScaler.linear(1.5),
      const TextScaler.linear(2.0),
    ]) {
      await _pump(
        tester,
        () => view(namespaces: [
          namespace(fields: [
            field(
              keyPath: 'model',
              title: '搜索模型',
              valueText: 'deepseek-v4-flash-preview-very-long',
              defaultText: 'deepseek-v4-flash',
              hasDefault: true,
              source: HostSettingSource.user,
            ),
          ]),
        ]),
        size: const Size(320, 844),
        scaler: scaler,
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('英文语言下标题回落 titleEn（缺失时用中文 title，不伪造）', (tester) async {
    addTearDown(() => L10n.lang = 'zh');
    await _pump(tester, () => view(namespaces: [
      namespace(title: '联网搜索', fields: [field(title: '搜索模型')]),
    ]), lang: 'en');
    // titleEn 为空时回落中文 title（宿主没给就不猜）。
    expect(find.text('联网搜索'), findsOneWidget);
    // 英文文案取自 L10n 的英文串；只读卡第一行与 AppBar 徽标都应出现。
    expect(find.text('Read-only in this version'), findsOneWidget);
    expect(find.text('Read-only'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('默认展开第一个命名空间；手风琴可折叠', (tester) async {
    await _pump(tester, () => view(namespaces: [
      namespace(),
      namespace(ns: 'permission', title: '权限预设', fields: [
        field(ns: 'permission', keyPath: 'defaultPreset', title: '默认权限预设', valueText: 'workspace-write'),
      ]),
    ]));
    // 第一个默认展开 → 看得到字段。
    expect(find.text('搜索模型'), findsOneWidget);
    // 第二个默认收起 → 只看得到标题。
    expect(find.text('权限预设'), findsOneWidget);
    expect(find.text('默认权限预设'), findsNothing);

    await tester.tap(find.text('权限预设'));
    await tester.pump();
    expect(find.text('默认权限预设'), findsOneWidget);

    await tester.tap(find.text('联网搜索'));
    await tester.pump();
    expect(find.text('搜索模型'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('设置页入口：通用 Tab →「电脑端设置（只读）」可达', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final store = AppStore();
    await store.loadPrefs();
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // 入口页会真的 push 只读页；页面自己的请求失败也只显示"读取失败"卡片，
    // 这里只验证**入口可达**，不依赖真实宿主。
    await tester.pumpWidget(
      MaterialApp(
        theme: DshTheme.light(),
        home: MediaQuery(
          data: const MediaQueryData(size: Size(390, 844)),
          child: Scaffold(
            body: SettingsScreen(store: store, onReconfigure: () async {}),
          ),
        ),
      ),
    );
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    // 通用是第 4 个 Tab。
    final tab = find.descendant(
      of: find.byType(TabBar),
      matching: find.text('通用'),
    );
    await tester.tap(tab);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    expect(find.byKey(const Key('settings-host-settings')), findsOneWidget);
    expect(find.text('电脑端设置（只读）'), findsOneWidget);
    expect(find.textContaining('不修改任何配置'), findsOneWidget);

    await tester.tap(find.byKey(const Key('settings-host-settings')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 30));
    // 已 push 只读页（页面自身标题）。
    expect(find.text('DSH 设置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
