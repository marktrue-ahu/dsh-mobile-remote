// issue #179：手动安装输入栏点击后弹「安全键盘 / 密码键盘」的回归测试。
//
// ## 根因（Flutter 引擎源码，非猜测）
//
// `engine/src/flutter/shell/platform/android/io/flutter/plugin/editing/TextInputPlugin.java`：
// ```java
// if (!enableSuggestions) {
//   textType |= InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
//   textType |= InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD;  // ← 安全键盘
// }
// ```
// 即 `enableSuggestions: false` 会把 Android 输入类型变成 `VISIBLE_PASSWORD`。
//
// `maxLines: 3` 只会加 `TYPE_TEXT_FLAG_MULTI_LINE`（普通多行标志），与安全键盘无关；
// 但内容本就是单行短文本，改单行更符合语义，也避免 `keyboardType` 被默认推导成 multiline。
//
// ## 本文件能证明什么 / 不能证明什么
//
// **能**：控件属性层面不再有 `VISIBLE_PASSWORD` 的触发条件（`enableSuggestions` 不为 false）、
//        且是单行 + 显式 `TextInputType.text`。
// **不能**：真机键盘长什么样。那取决于设备输入法实现，widget test 无法自证。
//        交付时已如实注明「需用户升级后真机确认」。
import 'package:dsh_mobile_app/l10n.dart';
import 'package:dsh_mobile_app/screens/plugin_spec_install_screen.dart';
import 'package:dsh_mobile_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'issue175_plugin_spec_install_test.dart'
    show FakeSpecBackend, makeStore;

Future<void> pumpScreen(WidgetTester tester, {Size size = const Size(390, 844)}) async {
  SharedPreferences.setMockInitialValues({});
  final store = await makeStore();
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final backend = FakeSpecBackend();
  await tester.pumpWidget(
    MaterialApp(
      theme: DshTheme.forSkin(DshSkin.dsh, Brightness.light),
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: TextScaler.linear(1.0)),
        child: PluginSpecInstallScreen(
          store: store,
          inspect: backend.inspect,
          onInstall: backend.install,
          poll: backend.poll,
          cancel: backend.cancel,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

TextField specField(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const ValueKey('spec-input')));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => L10n.lang = 'zh');

  group('#179 spec 输入框不再触发安全键盘', () {
    testWidgets('enableSuggestions 不得为 false（VISIBLE_PASSWORD 的唯一来源）', (tester) async {
      await pumpScreen(tester);
      final field = specField(tester);
      // Flutter 默认 true。显式 false 会让引擎加 TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      // → Android 弹安全/密码键盘。这是本 issue 的根因，必须钉死。
      expect(
        field.enableSuggestions,
        isTrue,
        reason: 'enableSuggestions=false 会让引擎设置 VISIBLE_PASSWORD（安全键盘）',
      );
    });

    testWidgets('单行：minLines/maxLines 都不设或为 1', (tester) async {
      await pumpScreen(tester);
      final field = specField(tester);
      // maxLines == null ⇒ 默认 1（单行）；显式 1 也接受。
      expect(
        field.maxLines,
        anyOf(isNull, 1),
        reason: '多行会加 TYPE_TEXT_FLAG_MULTI_LINE，且让 keyboardType 默认成 multiline',
      );
      expect(
        field.minLines,
        anyOf(isNull, 1),
        reason: 'minLines>1 会让输入框至少显示多行高度',
      );
    });

    testWidgets('keyboardType 是 TextInputType.text（不是 visiblePassword/multiline）', (tester) async {
      await pumpScreen(tester);
      final field = specField(tester);
      expect(field.keyboardType, TextInputType.text);
      expect(field.keyboardType, isNot(TextInputType.visiblePassword));
      expect(field.keyboardType, isNot(TextInputType.multiline));
      expect(field.keyboardType, isNot(TextInputType.url));
    });

    testWidgets('autocorrect 保持 false（只关自动更正，不影响键盘类型）', (tester) async {
      await pumpScreen(tester);
      // 包名/路径不该被自动更正；该参数只控制 AUTO_CORRECT 标志，不是安全键盘来源。
      expect(specField(tester).autocorrect, isFalse);
    });

    testWidgets('未设 obscureText（否则会走 PASSWORD 分支）', (tester) async {
      await pumpScreen(tester);
      expect(specField(tester).obscureText, isFalse);
    });
  });

  group('#179 功能不退化', () {
    testWidgets('四类 spec 都能输入（含 . / @ : - 符号）', (tester) async {
      await pumpScreen(tester);
      const specs = [
        '@scope/dsh-plugin-name',
        'github:owner/dsh-plugin',
        '/Users/name/my-dsh-plugin',
        'https://example.com/dsh-plugin-1.0.0.tgz',
      ];
      for (final spec in specs) {
        await tester.enterText(find.byKey(const ValueKey('spec-input')), spec);
        await tester.pumpAndSettle();
        expect(specField(tester).controller!.text, spec, reason: spec);
      }
    });

    testWidgets('长 URL 单行也能完整保存（横向滚动由 TextField 处理）', (tester) async {
      await pumpScreen(tester);
      final longUrl = 'https://example.com/${'a' * 300}.tgz';
      await tester.enterText(find.byKey(const ValueKey('spec-input')), longUrl);
      await tester.pumpAndSettle();
      expect(specField(tester).controller!.text, longUrl);
      // 单行不换行：maxLines 不是 3
      expect(specField(tester).maxLines, anyOf(isNull, 1));
    });
  });

  group('#179 响应式不溢出', () {
    for (final size in const [Size(320, 844), Size(390, 844)]) {
      testWidgets('${size.width.toInt()} 宽：输入区不溢出', (tester) async {
        await pumpScreen(tester, size: size);
        await tester.enterText(
          find.byKey(const ValueKey('spec-input')),
          'github:owner/a-very-long-plugin-name-for-layout',
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }
  });
}
