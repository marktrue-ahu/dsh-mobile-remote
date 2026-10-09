// issue #24：定位机制回归测试（Seam 3）。
//
// 这条风险线是本功能最容易出错的地方：消息流是**懒构建**的 `SliverList` 且带
// `center` 锚点（偏移 0 是中间占位块、上翻后最小滚动范围为负），屏幕外的条目
// 没有渲染对象。
//
// 本文件做三件事：
//   1. 用真实 Flutter 布局把"`ensureVisible` 不足以定位未构建条目"这一**约束**
//      钉死——它是 ADR 0018 实现期修订的直接依据；
//   2. 验证有界迭代定位（`TurnLocator`）在这套真实结构上**能收敛**，且成功判据
//      是"目标与视口相交"（不是"已构建"）；
//   3. 钉死失败原因（notInWindow / exhausted）、硬截止（kTurnLocateTimeoutMs）
//      与基于实测几何的校正（不等高条目也能收敛）。
//
// 与 `chat_scroll_regression_test.dart` 同一条风险线（负偏移、prepend 保位）。

import 'package:dsh_mobile_app/turn_navigation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 每条第 10 项是"轮次边界"，挂 GlobalKey——与聊天页给轮次边界挂 key 同构。
const int _kRowHeight = 60;
const int _kRowCount = 200;
const int _kTurnStride = 10;

/// 构造一个带默认回调的定位器；各用例只覆盖自己关心的那几个。
TurnLocator _locator({
  required void Function(double) scrollTo,
  double Function()? minScrollExtent,
  double Function()? maxScrollExtent,
  bool Function()? isTargetLoaded,
  bool Function()? isTargetBuilt,
  bool Function()? isTargetInView,
  Future<void> Function()? reveal,
  List<TurnMeasurement> Function()? measure,
  Future<void> Function()? settle,
  Duration timeout = const Duration(milliseconds: kTurnLocateTimeoutMs),
  DateTime Function()? clock,
}) {
  return TurnLocator(
    scrollTo: scrollTo,
    minScrollExtent: minScrollExtent ?? () => 0,
    maxScrollExtent: maxScrollExtent ?? () => 1000,
    isTargetLoaded: isTargetLoaded ?? () => true,
    isTargetBuilt: isTargetBuilt ?? () => false,
    isTargetInView: isTargetInView ?? () => false,
    reveal: reveal ?? () async {},
    measure: measure ?? () => const [],
    settle: settle ?? () async {},
    timeout: timeout,
    clock: clock,
  );
}

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
    test('目标已在视口内时立即成功，不做任何滚动', () async {
      var scrolls = 0;
      final locator = _locator(
        scrollTo: (_) => scrolls++,
        isTargetInView: () => true,
      );
      final outcome =
          await locator.locate(targetTurn: 3, targetIndex: 3, childCount: 10);
      expect(outcome.ok, isTrue);
      expect(scrolls, 0);
    });

    test('目标已构建但不在视口：先精调，精调后可见即成功', () async {
      var reveals = 0;
      var inView = false;
      final locator = _locator(
        scrollTo: (_) {},
        isTargetBuilt: () => true,
        isTargetInView: () => inView,
        reveal: () async {
          reveals++;
          inView = true;
        },
      );
      final outcome =
          await locator.locate(targetTurn: 3, targetIndex: 3, childCount: 10);
      expect(outcome.ok, isTrue);
      expect(reveals, 1);
    });

    test('落点后目标进入视口即收敛，且尝试次数在上限内', () async {
      var built = false;
      var inView = false;
      var attempts = 0;
      final locator = _locator(
        scrollTo: (_) {
          attempts++;
          built = true; // 模拟"跳过去后该处条目被构建"
        },
        isTargetBuilt: () => built,
        isTargetInView: () => inView,
        settle: () async {
          if (built) inView = true;
        },
      );
      final outcome =
          await locator.locate(targetTurn: 5, targetIndex: 5, childCount: 10);
      expect(outcome.ok, isTrue);
      expect(attempts, 1);
    });

    test('始终不可见时，尝试次数有界且如实返回 exhausted', () async {
      var attempts = 0;
      final locator = _locator(
        scrollTo: (_) => attempts++,
        // 病态：目标既不构建也不可见。
      );
      final outcome =
          await locator.locate(targetTurn: 5, targetIndex: 5, childCount: 10);
      expect(outcome.ok, isFalse);
      expect(outcome.failure, TurnLocateFailure.exhausted);
      expect(attempts, kTurnLocateMaxAttempts, reason: '必须有界——不得无限抖动');
    });

    test('目标不在已加载窗口内 → notInWindow，且不做任何滚动', () async {
      var scrolls = 0;
      final locator = _locator(
        scrollTo: (_) => scrolls++,
        isTargetLoaded: () => false,
      );
      final outcome =
          await locator.locate(targetTurn: 9, targetIndex: 9, childCount: 10);
      expect(outcome.ok, isFalse);
      expect(outcome.failure, TurnLocateFailure.notInWindow);
      expect(scrolls, 0);
    });

    test('截止时间用尽后不再产生副作用，返回 exhausted', () async {
      var now = DateTime(2026, 1, 1);
      var scrolls = 0;
      final locator = _locator(
        scrollTo: (_) => scrolls++,
        settle: () async => now = now.add(const Duration(seconds: 5)),
        clock: () => now,
      );
      final outcome =
          await locator.locate(targetTurn: 5, targetIndex: 5, childCount: 10);
      expect(outcome.ok, isFalse);
      expect(outcome.failure, TurnLocateFailure.exhausted);
      expect(scrolls, 1, reason: '超时后不得再滚动（硬截止）');
    });

    test('落点被夹在可滚动范围内（center 锚点下的负最小偏移）', () async {
      final offsets = <double>[];
      final locator = _locator(
        scrollTo: offsets.add,
        minScrollExtent: () => -300,
        maxScrollExtent: () => 700,
      );
      await locator.locate(targetTurn: 0, targetIndex: 0, childCount: 5);
      expect(offsets.first, -300);
      expect(offsets.every((o) => o >= -300 && o <= 700), isTrue);
    });
  });

  group('estimateTurnOffsetFromMeasurements：按实测几何校正', () {
    test('目标被两个实测点夹逼时线性插值', () {
      final offset = estimateTurnOffsetFromMeasurements(
        targetTurn: 3,
        measurements: const [
          TurnMeasurement(turn: 1, offset: 100),
          TurnMeasurement(turn: 5, offset: 900),
        ],
        targetIndex: 2,
        childCount: 10,
        minScrollExtent: 0,
        maxScrollExtent: 1000,
      );
      expect(offset, 500);
    });

    test('目标在实测点之后时按最近两点割线外推', () {
      final offset = estimateTurnOffsetFromMeasurements(
        targetTurn: 4,
        measurements: const [
          TurnMeasurement(turn: 1, offset: 100),
          TurnMeasurement(turn: 2, offset: 300),
          TurnMeasurement(turn: 3, offset: 500),
        ],
        targetIndex: 3,
        childCount: 10,
        minScrollExtent: 0,
        maxScrollExtent: 1000,
      );
      expect(offset, 700);
    });

    test('目标在实测点之前时反向外推', () {
      final offset = estimateTurnOffsetFromMeasurements(
        targetTurn: 1,
        measurements: const [
          TurnMeasurement(turn: 3, offset: 500),
          TurnMeasurement(turn: 4, offset: 700),
        ],
        targetIndex: 0,
        childCount: 10,
        minScrollExtent: 0,
        maxScrollExtent: 1000,
      );
      expect(offset, 100);
    });

    test('没有实测点时退回比例估算', () {
      final offset = estimateTurnOffsetFromMeasurements(
        targetTurn: 5,
        measurements: const [],
        targetIndex: 4,
        childCount: 5,
        minScrollExtent: 0,
        maxScrollExtent: 1000,
      );
      expect(offset, 1000);
    });
  });

  group('TurnLocator 驱动真实懒构建列表（center 锚点，条目不等高）', () {
    testWidgets('远处轮次能被实测几何迭代定位带入视口', (tester) async {
      const centerKey = ValueKey<String>('center');
      final viewportKey = GlobalKey();
      final turnKeys = <int, GlobalKey>{};
      final controller = ScrollController();
      // 前半（center 之前）：远→近；后半（center 之后）：近→远，模拟聊天页两条列表。
      const beforeCount = 100;
      const afterCount = 100;
      // 条目高度不等高：把"轮次边界"所在行做成超高行，比例估算必然失准。
      double rowHeight(int global) =>
          global % _kTurnStride == 0 ? _kRowHeight * 3 : _kRowHeight.toDouble();

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CustomScrollView(
            key: viewportKey,
            controller: controller,
            center: centerKey,
            slivers: [
              SliverList(
                delegate: SliverChildBuilderDelegate(
                  (_, index) {
                    final global = beforeCount - 1 - index;
                    return SizedBox(
                      key: global % _kTurnStride == 0
                          ? turnKeys.putIfAbsent(global ~/ _kTurnStride, () => GlobalKey())
                          : null,
                      height: rowHeight(global),
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
                    final global = beforeCount + index;
                    return SizedBox(
                      key: global % _kTurnStride == 0
                          ? turnKeys.putIfAbsent(global ~/ _kTurnStride, () => GlobalKey())
                          : null,
                      height: rowHeight(global),
                      child: Text('after $index'),
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

      // 目标：全局第 20 项 → 序号 2，初始一定不可达。
      const targetTurn = 2;
      expect(turnKeys[targetTurn]?.currentContext, isNull,
          reason: '起始位置下目标不应已构建（否则本用例失去意义）');

      final viewport = viewportKey.currentContext!.findRenderObject() as RenderBox;
      List<TurnMeasurement> measure() {
        if (!controller.hasClients) return const [];
        final viewTop = viewport.localToGlobal(Offset.zero).dy;
        final out = <TurnMeasurement>[];
        turnKeys.forEach((turn, key) {
          final box = key.currentContext?.findRenderObject() as RenderBox?;
          if (box == null || !box.hasSize) return;
          out.add(TurnMeasurement(
            turn: turn,
            offset: controller.offset +
                (box.localToGlobal(Offset.zero).dy - viewTop),
          ));
        });
        return out;
      }

      bool inView() {
        final box =
            turnKeys[targetTurn]?.currentContext?.findRenderObject() as RenderBox?;
        if (box == null || !box.hasSize) return false;
        final top = box.localToGlobal(Offset.zero).dy;
        final bottom = top + box.size.height;
        final viewTop = viewport.localToGlobal(Offset.zero).dy;
        final viewBottom = viewTop + viewport.size.height;
        return bottom > viewTop && top < viewBottom;
      }

      final locator = _locator(
        scrollTo: (offset) {
          if (controller.hasClients) controller.jumpTo(offset);
        },
        minScrollExtent: () =>
            controller.hasClients ? controller.position.minScrollExtent : 0,
        maxScrollExtent: () =>
            controller.hasClients ? controller.position.maxScrollExtent : 0,
        isTargetBuilt: () => turnKeys[targetTurn]?.currentContext != null,
        isTargetInView: inView,
        reveal: () async {
          final ctx = turnKeys[targetTurn]?.currentContext;
          if (ctx == null) return;
          // 无动画：测试体直接 await，动画需要 pump 才能完成。
          await Scrollable.ensureVisible(ctx, alignment: 0.1);
        },
        measure: measure,
        settle: () async {
          await tester.pump();
        },
      );

      final outcome = await locator.locate(
        targetTurn: targetTurn,
        targetIndex: targetTurn * _kTurnStride,
        childCount: beforeCount + afterCount,
      );

      expect(outcome.ok, isTrue, reason: '迭代定位应把远处轮次带入视口');
      expect(inView(), isTrue, reason: '成功判据是"与视口相交"，不是"已构建"');
      // 目标真的进入视口（不只是被构建在缓存区）。
      final box =
          turnKeys[targetTurn]!.currentContext!.findRenderObject() as RenderBox;
      final dy = box.localToGlobal(Offset.zero).dy;
      expect(dy, greaterThanOrEqualTo(-box.size.height));
      expect(dy, lessThan(viewport.size.height));
    });
  });
}
