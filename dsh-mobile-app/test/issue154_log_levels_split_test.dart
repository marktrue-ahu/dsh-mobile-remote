// issue #154：日志「记录级别」与「显示筛选」拆分。
//
// 覆盖：显示筛选不改记录级别/不写 app_log_level、记住上次、低记录+高显示
// 明确空态/提示、旧格式按 info、设置页文案仍为「日志记录级别」。
import 'package:dsh_mobile_app/logger.dart';
import 'package:dsh_mobile_app/screens/log_sheet.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'settings_tabs_helper.dart';

Future<void> _pumpLogButton(
  WidgetTester tester, {
  Size size = const Size(390, 844),
  TextScaler scaler = TextScaler.noScaling,
  ThemeData? theme,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? DshTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: scaler),
        child: Scaffold(
          body: Builder(
            builder: (ctx) => TextButton(
              key: const ValueKey('open-log'),
              onPressed: () => showLogSheet(ctx),
              child: const Text('open-log'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const ValueKey('open-log')));
  await tester.pumpAndSettle();
}

Future<void> _closeSheet(WidgetTester tester) async {
  // 点击 sheet 外的遮罩关闭；再点 open-log 重新打开。
  await tester.tapAt(const Offset(10, 10));
  await tester.pumpAndSettle();
}

String _richText(WidgetTester tester) {
  final widget = tester.widget<SelectableText>(
    find.byKey(const ValueKey('log-text')),
  );
  return widget.textSpan!.toPlainText();
}

Future<void> _pickDisplay(WidgetTester tester, String label) async {
  await tester.tap(find.byKey(const ValueKey('log-level-chip')));
  await tester.pumpAndSettle();
  expect(find.text('日志显示筛选'), findsOneWidget);
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Future<AppStore> _store() async {
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await AppLog.instance.clear();
    await AppLog.instance.setLevel(AppLogLevel.info);
  });

  testWidgets('显示筛选只影响查看，不改变记录级别与 app_log_level', (tester) async {
    AppLog.instance.info('info-line');
    AppLog.instance.warn('warn-line');
    AppLog.instance.error('error-line');
    await _pumpLogButton(tester);

    expect(find.textContaining('记录 ≥ INFO'), findsOneWidget);
    expect(find.text('INFO ▾'), findsOneWidget);
    expect(find.byKey(const ValueKey('log-filter-hint')), findsOneWidget);
    final semantics = tester.ensureSemantics();
    expect(
      find.bySemanticsLabel(RegExp('复制全部，已记录 3 行')),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel(RegExp('日志显示筛选，当前 INFO；仅筛选显示')),
      findsOneWidget,
    );
    semantics.dispose();

    await _pickDisplay(tester, '调试（debug）');
    expect(find.text('DEBUG ▾'), findsOneWidget);
    // debug 没有被记录：显示筛选不会伪造/补记低级别日志。
    expect(_richText(tester), isNot(contains('[DEBUG]')));

    expect(AppLog.instance.level, AppLogLevel.info);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(AppLog.prefsKey), 'info');
    expect(prefs.getString(AppLog.displayPrefsKey), 'debug');
  });

  testWidgets('显示筛选记住上次；修改记录级别只影响之后写入', (tester) async {
    AppLog.instance.info('old-info-before-record-change');
    await _pumpLogButton(tester);
    await _pickDisplay(tester, '警告（warn）');
    expect(find.text('WARN ▾'), findsOneWidget);
    await _closeSheet(tester);

    // 设置页语义：记录级别只影响之后写入；已有 info 行不删除。
    // 先以降后的 warn 记录 new-warn/error，再把记录级别提高到 error；
    // 显示筛选仍是 WARN，因此能看到已记录的 warn，但看不到旧 info。
    await AppLog.instance.setLevel(AppLogLevel.warn);
    AppLog.instance.info('dropped-after-record-change');
    AppLog.instance.warn('new-warn');
    AppLog.instance.error('new-error');
    await AppLog.instance.setLevel(AppLogLevel.error);
    expect(
      AppLog.instance.lines.join('\n'),
      allOf(
        contains('old-info-before-record-change'),
        contains('new-warn'),
        isNot(contains('dropped-after-record-change')),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('open-log')));
    await tester.pumpAndSettle();
    expect(find.textContaining('记录 ≥ ERROR'), findsOneWidget);
    // 显示筛选记住 WARN，不随记录级别复位。
    expect(find.text('WARN ▾'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('log-display-below-record')),
      findsOneWidget,
    );
    expect(_richText(tester), contains('[WARN] new-warn'));
    expect(_richText(tester), contains('[ERROR] new-error'));
    // 旧 info 仍被记录（AppLog.lines 有），只是被显示筛选 WARN 隐藏。
    expect(_richText(tester), isNot(contains('old-info-before-record-change')));
    expect(_richText(tester), isNot(contains('dropped-after-record-change')));
    expect(AppLog.instance.level, AppLogLevel.error);
  });

  testWidgets('低记录级别 + 高显示筛选：空态与未记录提示', (tester) async {
    AppLog.instance.info('only-info-1');
    AppLog.instance.info('only-info-2');
    await _pumpLogButton(tester);

    // 显示 error 只筛出 error/warn；这两行 info 被隐藏。
    await _pickDisplay(tester, '错误（error）');
    expect(find.text('ERROR ▾'), findsOneWidget);
    expect(find.byKey(const ValueKey('log-text')), findsNothing);
    expect(find.text('当前显示级别下没有日志'), findsOneWidget);
    expect(find.byKey(const ValueKey('log-empty-hint')), findsOneWidget);
    expect(find.text('复制当前（0 行）'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('log-display-below-record')),
      findsNothing,
      reason: '显示 error 高于记录 info，不应提示“低于记录级别”',
    );
    expect(AppLog.instance.level, AppLogLevel.info);

    // 显示 debug 低于记录 info：明确提示更详细日志未被记录，且没有 debug 行。
    await _pickDisplay(tester, '调试（debug）');
    expect(find.text('DEBUG ▾'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('log-display-below-record')),
      findsOneWidget,
    );
    expect(_richText(tester), contains('[INFO] only-info-1'));
    expect(_richText(tester), isNot(contains('[DEBUG]')));
    expect(AppLog.instance.level, AppLogLevel.info);
  });

  testWidgets('设置页仍叫「日志记录级别」，并说明显示筛选不改变记录', (tester) async {
    final store = await _store();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SettingsScreen(store: store, onReconfigure: () async {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await selectSettingsTab(tester, '通用');
    await tester.scrollUntilVisible(
      find.text('日志记录级别'),
      260,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(find.text('日志记录级别'), findsOneWidget);
    expect(find.text('日志显示筛选'), findsNothing);
    expect(
      find.byKey(const ValueKey('settings-log-filter-note')),
      findsOneWidget,
    );
    expect(find.textContaining('只影响查看，不会改变记录级别'), findsOneWidget);

    await tester.tap(find.text('日志记录级别'));
    await tester.pumpAndSettle();
    expect(find.textContaining('不会改变记录级别'), findsWidgets);
  });

  test('旧格式无级别行按 info 参与显示筛选与复制集合', () {
    final entries = AppLog.parseLines(
      '[11-21 01:02:03.456] legacy line\n'
      '[11-21 01:02:03.456] [DEBUG] debug line\n'
      '[11-21 01:02:03.456] [WARN] warn line',
    );
    final info = AppLog.filterEntries(entries, AppLogLevel.info);
    expect(info.map((e) => e.raw).toList(), [
      '[11-21 01:02:03.456] legacy line',
      '[11-21 01:02:03.456] [WARN] warn line',
    ]);
    final debug = AppLog.filterEntries(entries, AppLogLevel.debug);
    expect(debug, hasLength(3));
  });
}
