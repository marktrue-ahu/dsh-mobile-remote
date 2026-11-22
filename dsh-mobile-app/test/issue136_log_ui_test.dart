// issue #136：设置页级别选择 + 日志查看页过滤/复制/清空/适配。
import 'package:dsh_mobile_app/logger.dart';
import 'package:dsh_mobile_app/screens/log_sheet.dart';
import 'package:dsh_mobile_app/screens/settings_screen.dart';
import 'package:dsh_mobile_app/store.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'settings_tabs_helper.dart';

import 'package:shared_preferences/shared_preferences.dart';

Future<AppStore> _store() async {
  final store = AppStore();
  await store.loadPrefs();
  return store;
}

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
              onPressed: () => showLogSheet(ctx),
              child: const Text('open-log'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open-log'));
  await tester.pumpAndSettle();
}

String _richText(WidgetTester tester) {
  final widget = tester.widget<SelectableText>(
    find.byKey(const ValueKey('log-text')),
  );
  return widget.textSpan!.toPlainText();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await AppLog.instance.clear();
    await AppLog.instance.setLevel(AppLogLevel.info);
    AppLog.instance.debug('debug-line');
    AppLog.instance.info('info-line');
    AppLog.instance.warn('warn-line');
    AppLog.instance.error('error-line');
  });

  testWidgets('设置页选择日志级别：立即生效并持久化', (tester) async {
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
    await selectSettingsTab(tester, '通用');
    expect(find.text('日志记录级别'), findsOneWidget);
    expect(find.text('信息'), findsOneWidget, reason: '默认 info');

    await tester.tap(find.text('日志记录级别'));
    await tester.pumpAndSettle();
    expect(find.text('调试（debug）'), findsOneWidget);
    expect(find.text('警告（warn）'), findsOneWidget);
    await tester.tap(find.text('警告（warn）'));
    await tester.pumpAndSettle();

    expect(AppLog.instance.level, AppLogLevel.warn);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(AppLog.prefsKey), 'warn');
    expect(find.text('警告'), findsOneWidget);
  });

  testWidgets('设置页 320 / 深色 / 1.5x：级别行与选择器不溢出', (tester) async {
    final store = await _store();
    await tester.binding.setSurfaceSize(const Size(320, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: DshTheme.dark(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(320, 640),
            textScaler: TextScaler.linear(1.5),
          ),
          child: Scaffold(
            body: SettingsScreen(store: store, onReconfigure: () async {}),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await selectSettingsTab(tester, '通用');
    await tester.scrollUntilVisible(
      find.text('日志记录级别'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('日志记录级别'));
    await tester.pumpAndSettle();
    expect(find.text('调试（debug）'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('日志页：info 过滤 debug、复制当前/全部、切换 debug、清空', (tester) async {
    String? copied;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );
    // 历史文件里保留 debug 行（先以 debug 写入，再切回 info 展示）。
    await AppLog.instance.setLevel(AppLogLevel.debug);
    await AppLog.instance.clear();
    AppLog.instance.debug('debug-line');
    AppLog.instance.info('info-line');
    AppLog.instance.warn('warn-line');
    AppLog.instance.error('error-line');
    await AppLog.instance.setLevel(AppLogLevel.info);
    await _pumpLogButton(tester);
    expect(find.textContaining('记录 ≥ INFO'), findsOneWidget);
    expect(find.text('INFO ▾'), findsOneWidget);
    expect(_richText(tester), contains('[INFO]'));
    expect(_richText(tester), contains('[WARN]'));
    expect(_richText(tester), contains('[ERROR]'));
    expect(_richText(tester), isNot(contains('[DEBUG]')));
    expect(find.text('复制当前（3 行）'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('log-copy-current')));
    await tester.pumpAndSettle();
    expect(find.textContaining('已复制 3 行（显示 ≥ INFO）'), findsOneWidget);

    // 等上一个 toast 消失，避免浮动 SnackBar 挡住“复制全部”按钮。
    await tester.pump(const Duration(seconds: 3));
    await tester.tap(find.byKey(const ValueKey('log-copy-all')));
    await tester.pumpAndSettle();
    expect(copied, isNotNull);
    expect(copied!, contains('[DEBUG]'));
    expect(copied!, contains('[INFO]'));

    await tester.tap(find.byKey(const ValueKey('log-level-chip')));
    await tester.pumpAndSettle();
    expect(find.text('日志显示筛选'), findsOneWidget);
    await tester.tap(find.text('调试（debug）'));
    await tester.pumpAndSettle();
    expect(find.text('DEBUG ▾'), findsOneWidget);
    expect(_richText(tester), contains('[DEBUG]'));
    expect(find.text('复制当前（4 行）'), findsOneWidget);
    // issue #154：显示筛选只影响查看，不得改记录级别/记录级偏好。
    expect(AppLog.instance.level, AppLogLevel.info);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(AppLog.prefsKey), 'info');
    expect(prefs.getString(AppLog.displayPrefsKey), 'debug');

    // 复制当前必须尊重当前显示筛选：debug 行现在可见且应被复制。
    copied = null;
    await tester.tap(find.byKey(const ValueKey('log-copy-current')));
    await tester.pumpAndSettle();
    expect(copied, contains('[DEBUG]'));
    expect(copied, contains('[WARN]'));

    // 等 toast 消失再点清空。
    await tester.pump(const Duration(seconds: 3));
    await tester.tap(find.byKey(const ValueKey('log-clear')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('log-empty')), findsOneWidget);
    expect(find.text('（暂无日志）'), findsOneWidget);
    expect(AppLog.instance.lines, isEmpty);
    expect(AppLog.instance.level, AppLogLevel.info, reason: '清空保持记录级别');
    expect(AppLog.instance.loadDisplayLevel(), completion(AppLogLevel.debug));
  });

  testWidgets('全部被过滤：显示筛选空态且 chip 仍可调', (tester) async {
    // 历史只有 info 行；记录级别提高到 error 后旧 info 行仍在文件中。
    await AppLog.instance.setLevel(AppLogLevel.info);
    await AppLog.instance.clear();
    AppLog.instance.info('hidden-info-1');
    AppLog.instance.info('hidden-info-2');
    await AppLog.instance.setLevel(AppLogLevel.error);
    expect(AppLog.instance.level, AppLogLevel.error);
    expect(AppLog.instance.lines, isNotEmpty);
    await _pumpLogButton(tester);

    // 显示筛选默认 info：旧 info 行可见；但显示级别低于记录级别，提示更详细
    // 日志未被记录。
    expect(_richText(tester), contains('hidden-info-1'));
    expect(find.byKey(const ValueKey('log-display-below-record')), findsOneWidget);
    expect(AppLog.instance.level, AppLogLevel.error);

    // 把显示筛选提高到 error：旧 info 行被隐藏，出现明确的显示空态。
    await tester.tap(find.byKey(const ValueKey('log-level-chip')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('错误（error）'));
    await tester.pumpAndSettle();
    expect(find.text('ERROR ▾'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('log-text')),
      findsNothing,
      reason: '过滤后应为空态而不是渲染空文本',
    );
    expect(find.text('当前显示级别下没有日志'), findsOneWidget);
    expect(find.byKey(const ValueKey('log-empty-hint')), findsOneWidget);
    expect(find.text('复制当前（0 行）'), findsOneWidget);
    expect(find.byKey(const ValueKey('log-level-chip')), findsOneWidget);
    expect(AppLog.instance.level, AppLogLevel.error, reason: '筛选不改记录级别');
  });

  testWidgets('Semantics：级别 chip 带当前级别标签', (tester) async {
    final handle = tester.ensureSemantics();
    try {
      await _pumpLogButton(tester);
      expect(
        find.bySemanticsLabel(RegExp('日志显示筛选，当前 INFO；仅筛选显示')),
        findsOneWidget,
      );
    } finally {
      handle.dispose();
    }
  });

  testWidgets('320 / 深色 / 1.5x：日志页不溢出', (tester) async {
    await _pumpLogButton(
      tester,
      size: const Size(320, 640),
      scaler: const TextScaler.linear(1.5),
      theme: DshTheme.dark(),
    );
    expect(find.byKey(const ValueKey('log-text')), findsOneWidget);
    expect(find.byKey(const ValueKey('log-copy-current')), findsOneWidget);
    final chipSize = tester.getSize(
      find.byKey(const ValueKey('log-level-chip')),
    );
    expect(chipSize.width, greaterThanOrEqualTo(44));
    expect(chipSize.height, greaterThanOrEqualTo(44));
    expect(tester.takeException(), isNull);
  });
}
