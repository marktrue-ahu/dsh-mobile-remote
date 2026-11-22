// #155 设置页 Tab 测试辅助：真实点击 TabBar，不绕过生产导航。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> selectSettingsTab(WidgetTester tester, String label) async {
  const aliases = <String, List<String>>{
    '连接': ['连接', 'Connect'],
    '对话': ['对话', 'Chat'],
    '外观': ['外观', 'Style'],
    '通知': ['通知', 'Alerts'],
    '通用': ['通用', 'General'],
  };
  final labels = aliases[label] ?? [label];
  final tab = find.descendant(
    of: find.byType(TabBar),
    matching: find.byWidgetPredicate(
      (widget) => widget is Text && labels.contains(widget.data),
    ),
  );
  expect(tab, findsWidgets, reason: '设置页应有 $label Tab');
  await tester.tap(tab.first);
  // 有些 Tab（插件更新进度）含持续 spinner，不能 pumpAndSettle；用有界 pump。
  await tester.pump();
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pump();
}
