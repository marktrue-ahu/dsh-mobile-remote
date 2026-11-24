// #155/#163：设置页 4 Tab 分组、默认/记忆、独立滚动、窄屏/大字号与 Semantics。
import 'dart:ui' show SemanticsFlag;

import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'settings_tabs_helper.dart';

Future<AppStore> _plainStore() async {
  SharedPreferences.setMockInitialValues({});
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

Future<void> _pump(
  WidgetTester tester,
  AppStore store, {
  Size size = const Size(390, 844),
  TextScaler textScaler = TextScaler.noScaling,
  ThemeData? theme,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: theme,
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: textScaler),
        child: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
        ),
      ),
    ),
  );
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('4 Tab 等分、默认对话；切换后各项归属正确', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store);
    final tabBar = tester.widget<TabBar>(find.byType(TabBar));
    expect(tabBar.tabs, hasLength(4));
    expect(tabBar.isScrollable, isFalse);
    for (final label in ['对话', '外观', '通知', '通用']) {
      expect(
        find.descendant(of: find.byType(TabBar), matching: find.text(label)),
        findsOneWidget,
      );
    }
    // #163：设置页不再有连接 Tab/连接卡，连接入口在 Drawer。
    expect(find.text('连接'), findsNothing);
    expect(
      find.byKey(const ValueKey('connection-settings-section')),
      findsNothing,
    );
    expect(find.text('默认权限预设'), findsOneWidget);
    expect(find.text('对话调试模式'), findsOneWidget);
    expect(find.text('主题皮肤'), findsNothing);

    // #176：Git / 文件浏览从「通用」移入「对话」，插件卡删除。
    await tester.scrollUntilVisible(
      find.text('Git 标签页'),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Git 标签页'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('显示隐藏文件'),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('显示隐藏文件'), findsOneWidget);
    expect(find.text('插件管理'), findsNothing);

    await selectSettingsTab(tester, '外观');
    expect(find.text('主题皮肤'), findsOneWidget);
    expect(find.text('深色模式'), findsOneWidget);

    await selectSettingsTab(tester, '通知');
    expect(find.text('发送测试通知'), findsOneWidget);
    expect(find.text('后台提醒（常驻通知）'), findsOneWidget);

    await selectSettingsTab(tester, '通用');
    expect(find.text('插件管理'), findsNothing);
    expect(find.text('Git 标签页'), findsNothing);
    expect(find.text('显示隐藏文件'), findsNothing);
    expect(find.text('应用日志'), findsOneWidget);
    expect(find.text('环境诊断'), findsOneWidget);
    expect(find.byKey(const Key('settings-log-level')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // #176：对话 Tab 卡片顺序固定为 默认配置 / 账户? → 对话行为 → Git → 文件浏览 → …
  // 高视口一次渲染完，用 y 坐标核对相对顺序。
  testWidgets('#176 对话 Tab 卡片顺序：Git/文件浏览在对话行为之后', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store, size: const Size(390, 2600));
    // _lastTabIndex 是进程内静态量，会沿用上一个用例停留的 Tab；显式切回「对话」。
    await selectSettingsTab(tester, '对话');
    await tester.pump(const Duration(milliseconds: 200));

    final order = <String>['默认配置', '对话行为', 'Git', '文件浏览'];
    final ys = <double>[];
    for (final title in order) {
      // 卡片标题是大写渲染，用 row 标题做锚点更稳。
      final anchor = switch (title) {
        '默认配置' => '默认权限预设',
        '对话行为' => '对话调试模式',
        'Git' => 'Git 标签页',
        _ => '显示隐藏文件',
      };
      final f = find.text(anchor);
      expect(f, findsOneWidget, reason: '「$title」卡应存在（锚点：$anchor）');
      ys.add(tester.getTopLeft(f).dy);
    }
    for (var i = 1; i < ys.length; i++) {
      expect(
        ys[i],
        greaterThan(ys[i - 1]),
        reason: '「${order[i]}」应排在「${order[i - 1]}」之后',
      );
    }
  });

  testWidgets('本次会话记住上次 Tab；离线不强制切 Tab', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store);
    await selectSettingsTab(tester, '外观');
    // 重新打开设置（模拟关闭/再进），应回到外观。
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, store);
    expect(find.text('主题皮肤'), findsOneWidget);

    // 离线时仍保留用户上次 Tab，不再强制去已移除的连接 Tab。
    store.connState = 'offline';
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, store);
    expect(find.text('主题皮肤'), findsOneWidget);
    expect(find.text('连接'), findsNothing);
  });

  testWidgets('320×1.5 四等分不裁字；320×2.0 横向滚动', (tester) async {
    final store = await _plainStore();
    await _pump(
      tester,
      store,
      size: const Size(320, 700),
      textScaler: const TextScaler.linear(1.5),
    );
    expect(tester.widget<TabBar>(find.byType(TabBar)).isScrollable, isFalse);
    for (final label in ['对话', '外观', '通知', '通用']) {
      expect(
        find.descendant(of: find.byType(TabBar), matching: find.text(label)),
        findsOneWidget,
      );
    }
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await _pump(
      tester,
      store,
      size: const Size(320, 700),
      textScaler: const TextScaler.linear(2.0),
    );
    await selectSettingsTab(tester, '对话');
    expect(tester.widget<TabBar>(find.byType(TabBar)).isScrollable, isTrue);
    expect(find.byType(TabBar), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // #176 验收：对话 Tab 新增 Git/文件浏览卡后，在 320/深色/1.5x/2.0x 下不溢出。
  // ListView 懒构建，所以逐屏滚动，让每张卡都真正布局一次；
  // 任何 RenderFlex overflow 都会以异常形式被 takeException 捕捉。
  testWidgets('#176 对话 Tab 卡片在 320/深色/1.5x/2.0x 下不溢出', (tester) async {
    for (final (scale, dark) in [
      (1.5, false),
      (2.0, false),
      (1.5, true),
      (2.0, true),
    ]) {
      final tag = '320/${scale}x${dark ? '/深色' : ''}';
      final store = await _plainStore();
      await _pump(
        tester,
        store,
        size: const Size(320, 700),
        textScaler: TextScaler.linear(scale),
        theme: dark ? DshTheme.dark() : null,
      );
      await selectSettingsTab(tester, '对话');

      // 回到顶部，再一路滚到底，覆盖全部卡片。
      // ⚠ 2.0x 下 TabBar 自身 isScrollable=true，Scrollable.first 会命中 TabBar，
      // 拖它不会滚动内容；必须锚定 ListView 内的那个 Scrollable。
      final list = find.descendant(
        of: find.byType(ListView).last,
        matching: find.byType(Scrollable),
      );
      await tester.drag(list, const Offset(0, 3000));
      await tester.pump(const Duration(milliseconds: 50));

      final seen = <String>{};
      for (var i = 0; i < 20; i++) {
        for (final anchor in ['对话调试模式', 'Git 标签页', 'Git 分支图上限', '显示隐藏文件']) {
          if (find.text(anchor).evaluate().isNotEmpty) seen.add(anchor);
        }
        expect(
          tester.takeException(),
          isNull,
          reason: '对话 Tab 在 $tag 下不应 overflow（第 $i 屏）',
        );
        await tester.drag(list, const Offset(0, -160));
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(
        seen,
        containsAll(['对话调试模式', 'Git 标签页', 'Git 分支图上限', '显示隐藏文件']),
        reason: '对话 Tab 在 $tag 下应能滚到全部新增卡片；实际见到：$seen',
      );
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    }
  });

  testWidgets('每 Tab 独立滚动位置（PageStorage）与 Semantics 选中态', (tester) async {
    final store = await _plainStore();
    await _pump(tester, store, size: const Size(390, 500));
    await selectSettingsTab(tester, '通用');
    final list = find.byType(ListView).last;
    await tester.drag(list, const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 200));
    final before = tester
        .state<ScrollableState>(
          find.descendant(of: list, matching: find.byType(Scrollable)),
        )
        .position
        .pixels;
    expect(before, greaterThan(0));

    await selectSettingsTab(tester, '外观');
    await selectSettingsTab(tester, '通用');
    final after = tester
        .state<ScrollableState>(
          find.descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          ),
        )
        .position
        .pixels;
    expect(after, closeTo(before, 1.0), reason: '切回通用应恢复独立滚动位置');

    final semantics = tester.ensureSemantics();
    final tab = tester.getSemantics(
      find.descendant(of: find.byType(TabBar), matching: find.text('通用')),
    );
    expect(tab.getSemanticsData().hasFlag(SemanticsFlag.isSelected), isTrue);
    semantics.dispose();
  });
}
