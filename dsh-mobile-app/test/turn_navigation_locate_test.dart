// issue #24：定位机制回归测试（Seam 3）。
//
// 这条风险线是本功能最容易出错的地方：消息流是**懒构建**的 `SliverList` 且带
// `center` 锚点（偏移 0 是中间占位块、上翻后最小滚动范围为负），屏幕外的条目
// 没有渲染对象。
//
// 本文件做两件事：
//   1. 用真实 Flutter 布局把"`ensureVisible` 不足以定位未构建条目"这一**约束**
//      钉死——它是 ADR 0018 实现期修订的直接依据；
//   2. 验证有界迭代定位（`TurnLocator`）在这套真实结构上**能收敛**，
//      且收敛不了时如实返回 false（调用方据此明说不可达）。
//
// 与 `chat_scroll_regression_test.dart` 同一条风险线（负偏移、prepend 保位）。

import 'package:dsh_mobile_app/turn_navigation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 每条第 10 项是"轮次边界"，挂 GlobalKey——与聊天页给轮次边界挂 key 同构。
const int _kRowHeight = 60;
const int _kRowCount = 200;
const int _kTurnStride = 10;

void main() {
  group('约束：懒构建下屏幕外的 GlobalKey 不可达', () {
    testWidgets('ensureVisible 无法直接跳到未构建的轮次', (tester) async {
      final turnKeys = <int, GlobalKey>{};
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ListView.builder(
            itemCount: _kRowCount,
            itemBuilder: (_, i) => SizedBox(
              key: i % _kTurnStride == 0
                  ? turnKeys.putIfAbsent(i ~/ _kTurnStride, () => GlobalKey())
                  : null,
              height: _kRowHeight.toDouble(),
              child: Text('row $i'),
            ),
          ),
        ),
      ));
      await tester.pump();

      expect(turnKeys[0]?.currentContext, isNotNull, reason: '首个边界在视口内');
      expect(turnKeys[15]?.currentContext, isNull,
          reason: '远处边界未构建——这正是 ensureVisible 不足的原因');
    });
  });

  group('TurnLocator：有界迭代定位', () {
    test('已构建时立即返回 true，不做任何滚动', () async {
      var scrolls = 0;
      final locator = TurnLocator(
        scrollTo: (_) => scrolls++,
        minScrollExtent: () => 0,
        maxScrollExtent: () => 1000,
        isTargetBuilt: () => true,
        settle: () async {},
      );
      expect(await locator.locate(targetIndex: 3, childCount: 10), isTrue);
      expect(scrolls, 0);
    });

    test('落点后目标被构建即收敛，且尝试次数在上限内', () async {
      var built = false;
      var attempts = 0;
      final locator = TurnLocator(
        scrollTo: (_) {
          attempts++;
          built = true; // 模拟"跳过去后该处条目被构建"
        },
        minScrollExtent: () => 0,
        maxScrollExtent: () => 1000,
        isTargetBuilt: () => built,
        settle: () async {},
      );
      expect(await locator.locate(targetIndex: 5, childCount: 10), isTrue);
      expect(attempts, 1);
    });

    test('始终构建不出来时，尝试次数有界且如实返回 false', () async {
      var attempts = 0;
      final locator = TurnLocator(
        scrollTo: (_) => attempts++,
        minScrollExtent: () => 0,
        maxScrollExtent: () => 1000,
        isTargetBuilt: () => false, // 病态：目标永远不构建
        settle: () async {},
      );
      expect(await locator.locate(targetIndex: 5, childCount: 10), isFalse);
      expect(attempts, kTurnLocateMaxAttempts,
          reason: '必须有界——不得无限抖动');
    });

    test('落点被夹在可滚动范围内（center 锚点下的负最小偏移）', () async {
      final offsets = <double>[];
      final locator = TurnLocator(
        scrollTo: offsets.add,
        minScrollExtent: () => -300,
        maxScrollExtent: () => 700,
        isTargetBuilt: () => false,
        settle: () async {},
      );
      await locator.locate(targetIndex: 0, childCount: 5);
      expect(offsets.first, -300);
      expect(offsets.every((o) => o >= -300 && o <= 700), isTrue);
    });
  });

  group('TurnLocator 驱动真实懒构建列表（center 锚点）', () {
    testWidgets('远处轮次能被迭代定位带入视口', (tester) async {
      const centerKey = ValueKey<String>('center');
      final turnKeys = <int, GlobalKey>{};
      final controller = ScrollController();
      // 前半（center 之前）：远→近；后半（center 之后）：近→远，模拟聊天页两条列表。
      const beforeCount = 100;
      const afterCount = 100;
      final before = List<int>.generate(beforeCount, (i) => i);
      final after = List<int>.generate(afterCount, (i) => i);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CustomScrollView(
            controller: controller,
            center: centerKey,
            slivers: [
              SliverList(
                delegate: SliverChildBuilderDelegate(
                  (_, index) {
                    final global = before[beforeCount - 1 - index];
                    return SizedBox(
                      key: global % _kTurnStride == 0
                          ? turnKeys.putIfAbsent(global ~/ _kTurnStride, () => GlobalKey())
                          : null,
                      height: _kRowHeight.toDouble(),
                      child: Text('before $global'),
                    );
                  },
                  childCount: beforeCount,
                ),
              ),
              const SliverToBoxAdapter(key: centerKey, child: SizedBox.shrink()),
              SliverList(
                delegate: SliverChildBuilderDelegate(
                  (_, index) {
                    final global = beforeCount + after[index];
                    return SizedBox(
                      key: global % _kTurnStride == 0
                          ? turnKeys.putIfAbsent(global ~/ _kTurnStride, () => GlobalKey())
                          : null,
                      height: _kRowHeight.toDouble(),
                      child: Text('after ${after[index]}'),
                    );
                  },
                  childCount: afterCount,
                ),
              ),
            ],
          ),
        ),
      ));
      await tester.pump();

      // 目标：很靠前的一轮（全局第 20 项 → 序号 2），初始一定不可达。
      const targetIndex = 2;
      expect(turnKeys[targetIndex]?.currentContext, isNull,
          reason: '起始位置下目标不应已构建（否则本用例失去意义）');

      final totalRows = beforeCount + afterCount;
      final locator = TurnLocator(
        scrollTo: (offset) {
          if (controller.hasClients) controller.jumpTo(offset);
        },
        minScrollExtent: () => controller.hasClients ? controller.position.minScrollExtent : 0,
        maxScrollExtent: () => controller.hasClients ? controller.position.maxScrollExtent : 0,
        isTargetBuilt: () => turnKeys[targetIndex]?.currentContext != null,
        settle: () async {
          await tester.pump();
        },
      );

      final landed = await locator.locate(
        // 把轮次序号映射到子项序号：每 _kTurnStride 项一个边界，
        // 且前半是倒序排列。
        targetIndex: targetIndex * _kTurnStride,
        childCount: totalRows,
      );

      expect(landed, isTrue, reason: '迭代定位应把远处轮次带入构建范围');
      expect(turnKeys[targetIndex]?.currentContext, isNotNull);

      // 目标真的进入视口（不只是被构建在缓存区）。
      final box = turnKeys[targetIndex]!.currentContext!.findRenderObject() as RenderBox;
      final dy = box.localToGlobal(Offset.zero).dy;
      expect(dy, greaterThanOrEqualTo(-_kRowHeight.toDouble()));
      expect(dy, lessThan(tester.view.physicalSize.height));
    });
  });
}
