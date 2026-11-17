// issue #114 §6.3 第 1 层：滚动跟随 owner 的策略/调度单测。
//
// 这一层不依赖 Flutter 渲染：所有几何都是构造出来的 ScrollGeometry，
// 帧调度用 [ensureFrame] 计数模拟。覆盖意图转换、取消/世代、合并、预算耗尽、
// 执行时拖拽守卫与派生展示（near-bottom 不改意图）。

import 'package:dsh_mobile_app/scroll_follow.dart';
import 'package:flutter_test/flutter_test.dart';

ScrollGeometry _geo({
  required double pixels,
  required double max,
  double min = 0,
  double viewport = 600,
}) => ScrollGeometry(
  pixels: pixels,
  minExtent: min,
  maxExtent: max,
  viewportDimension: viewport,
);

class _Harness {
  _Harness({int budget = 4}) {
    coordinator = ScrollFollowCoordinator(
      ensureFrame: () => ensureFrameCalls += 1,
      defaultBudget: budget,
    );
  }

  late final ScrollFollowCoordinator coordinator;
  int ensureFrameCalls = 0;

  /// 模拟一帧：帧后取校正；有决策则执行并回报。
  ScrollCorrection? frame(ScrollGeometry geometry) {
    final decision = coordinator.takeCorrection(geometry);
    if (decision != null) coordinator.noteCorrectionApplied(decision);
    return decision;
  }
}

void main() {
  group('意图转换', () {
    test('初始为跟随；内容/几何变化只改派生展示，不改意图', () {
      final h = _Harness();
      expect(h.coordinator.intent, FollowIntent.followLatest);
      expect(h.coordinator.showJumpToLatest, isFalse);

      h.coordinator.onMetrics(_geo(pixels: 100, max: 1000));
      expect(
        h.coordinator.intent,
        FollowIntent.followLatest,
        reason: '仅几何变化不得把意图改成阅读',
      );
      expect(
        h.coordinator.showJumpToLatest,
        isTrue,
        reason: '离底部超过阈值 → 展示回底按钮',
      );
      expect(h.coordinator.nearBottom, isFalse);

      h.coordinator.onMetrics(_geo(pixels: 980, max: 1000));
      expect(h.coordinator.intent, FollowIntent.followLatest);
      expect(h.coordinator.showJumpToLatest, isFalse);
      expect(h.coordinator.nearBottom, isTrue);
    });

    test('用户拖拽结束：近底恢复跟随，超过阈值进入阅读', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 1000, max: 1000));
      expect(h.coordinator.isDragging, isTrue);
      h.coordinator.onUserScrollEnd(_geo(pixels: 800, max: 1000));
      expect(
        h.coordinator.intent,
        FollowIntent.reading,
        reason: '离底部 200px（>160）→ 阅读',
      );
      expect(h.coordinator.isDragging, isFalse);

      h.coordinator.onUserScrollStart(_geo(pixels: 800, max: 1000));
      h.coordinator.onUserScrollEnd(_geo(pixels: 900, max: 1000));
      expect(
        h.coordinator.intent,
        FollowIntent.followLatest,
        reason: '160px 内松手 = 用户主动回到接近底部，恢复跟随',
      );
    });

    test('显式回底/强制定位：直接进入跟随', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 200, max: 1000));
      h.coordinator.onUserScrollEnd(_geo(pixels: 200, max: 1000));
      expect(h.coordinator.intent, FollowIntent.reading);

      h.coordinator.requestForcedFollow(
        reason: CorrectionReason.explicitBackToBottom,
        geometry: _geo(pixels: 200, max: 1000),
      );
      expect(h.coordinator.intent, FollowIntent.followLatest);
      expect(h.coordinator.hasPendingCorrection, isTrue);
    });

    test('显式轮次导航：进入阅读并作废旧校正', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      expect(h.coordinator.hasPendingCorrection, isTrue);
      h.coordinator.onNavigationStarted();
      expect(h.coordinator.intent, FollowIntent.reading);
      expect(h.coordinator.hasPendingCorrection, isFalse);
      expect(h.coordinator.generation, 1);
    });
  });

  group('会话 / 模式', () {
    test('会话切换：世代前进、意图复位跟随、拖拽与待执行清空', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 200, max: 1000));
      h.coordinator.onUserScrollEnd(_geo(pixels: 200, max: 1000));
      h.coordinator.requestForcedFollow(geometry: _geo(pixels: 200, max: 1000));
      expect(h.coordinator.intent, FollowIntent.followLatest);
      final before = h.coordinator.generation;
      h.coordinator.onSessionChanged();
      expect(h.coordinator.generation, before + 1);
      expect(h.coordinator.intent, FollowIntent.followLatest);
      expect(h.coordinator.isDragging, isFalse);
      expect(h.coordinator.hasPendingCorrection, isFalse);
    });

    test('bumpGeneration 不带意图时保留当前意图', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 200, max: 1000));
      h.coordinator.onUserScrollEnd(_geo(pixels: 200, max: 1000));
      expect(h.coordinator.intent, FollowIntent.reading);
      h.coordinator.bumpGeneration();
      expect(h.coordinator.intent, FollowIntent.reading);
    });
  });

  group('帧调度', () {
    test('请求即要求一帧；收敛后不再排帧（无空闲自激）', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      expect(h.ensureFrameCalls, 1, reason: '有待执行校正必须自己保证有帧');

      final first = h.frame(_geo(pixels: 990, max: 1000));
      expect(first, isNotNull);
      expect(h.ensureFrameCalls, 2, reason: '预算内排下一帧做布局后复核');

      final second = h.frame(_geo(pixels: 1000, max: 1000));
      expect(second, isNull, reason: '已收敛不动作');
      expect(h.ensureFrameCalls, 2, reason: '收敛后不得再排帧');
      expect(h.coordinator.hasPendingCorrection, isFalse);
    });

    test('合并：同一批多次请求只排一帧，原因取更显式者', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      h.coordinator.requestFollowOnLayout(_geo(pixels: 980, max: 1000));
      h.coordinator.requestForcedFollow(
        reason: CorrectionReason.explicitBackToBottom,
        geometry: _geo(pixels: 980, max: 1000),
      );
      expect(h.ensureFrameCalls, 1);
      final decision = h.frame(_geo(pixels: 980, max: 1000));
      expect(decision!.reason, CorrectionReason.explicitBackToBottom);
    });

    test('强制定位与内容跟随合并时取更显式原因与较大预算', () {
      final h = _Harness(budget: 4);
      h.coordinator.requestForcedFollow(
        reason: CorrectionReason.forcedPosition,
        budget: 2,
        geometry: _geo(pixels: 0, max: 1000),
      );
      h.coordinator.requestFollowOnLayout(_geo(pixels: 10, max: 1000));
      final decision = h.frame(_geo(pixels: 10, max: 1000));
      expect(decision!.reason, CorrectionReason.forcedPosition);
      expect(decision.budget, 4);
    });

    test('强制定位期间用户开始拖拽：执行时仍以用户手势优先', () {
      final h = _Harness();
      h.coordinator.requestForcedFollow(
        reason: CorrectionReason.explicitBackToBottom,
        geometry: _geo(pixels: 200, max: 1000),
      );
      h.coordinator.onUserScrollStart(_geo(pixels: 200, max: 1000));
      expect(h.frame(_geo(pixels: 200, max: 1000)), isNull);
      expect(h.coordinator.jumpCount, 0);
      expect(
        h.coordinator.intent,
        FollowIntent.followLatest,
        reason: '显式回底的意图保留，但不得在拖拽中执行',
      );
    });

    test('预算耗尽：几何始终不收敛时按预算停止并计数', () {
      final h = _Harness(budget: 3);
      h.coordinator.requestFollowOnLayout(_geo(pixels: 0, max: 1000));
      var attempts = 0;
      // 每帧 max 都继续变大，模拟 lazy 估值持续修正（永不收敛）。
      for (var i = 0; i < 10; i++) {
        final decision = h.frame(_geo(pixels: 0, max: 1000 + i * 100));
        if (decision != null) attempts += 1;
      }
      expect(attempts, 3, reason: '有界：最多 defaultBudget 次 jump');
      expect(h.coordinator.exhaustedCount, 1);
      expect(h.coordinator.hasPendingCorrection, isFalse);
      expect(h.ensureFrameCalls, 3, reason: '预算耗尽后不再排帧');
    });
  });

  group('取消与世代', () {
    test('用户拖拽开始立即作废已排队校正', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      expect(h.coordinator.hasPendingCorrection, isTrue);
      h.coordinator.onUserScrollStart(_geo(pixels: 990, max: 1000));
      expect(h.coordinator.hasPendingCorrection, isFalse);
      expect(h.coordinator.cancelledByUserCount, 1);
    });

    test('拖拽中不排队；执行时再查拖拽（双重守卫）', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 900, max: 1000));
      h.coordinator.requestFollowOnLayout(_geo(pixels: 900, max: 1000));
      expect(h.coordinator.hasPendingCorrection, isFalse, reason: '拖拽中不排队');
      expect(h.ensureFrameCalls, 0);
    });

    test('安排时有效、执行前开始拖拽 → 执行时取消', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      // 帧还没跑，用户先开始拖拽。
      h.coordinator.onUserScrollStart(_geo(pixels: 990, max: 1000));
      final decision = h.frame(_geo(pixels: 900, max: 1000));
      expect(decision, isNull);
      expect(h.coordinator.jumpCount, 0);
    });

    test('世代失效的校正不得执行', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      h.coordinator.bumpGeneration(intent: FollowIntent.followLatest);
      final decision = h.frame(_geo(pixels: 990, max: 1000));
      expect(decision, isNull);
      expect(
        h.coordinator.staleGenerationCount,
        0,
        reason: 'bump 时已清 pending；此处不应有 stale 决策',
      );
      expect(h.coordinator.hasPendingCorrection, isFalse);
    });

    test('阅读态不自动排队，但强制定位可以覆盖', () {
      final h = _Harness();
      h.coordinator.onUserScrollStart(_geo(pixels: 300, max: 1000));
      h.coordinator.onUserScrollEnd(_geo(pixels: 300, max: 1000));
      expect(h.coordinator.intent, FollowIntent.reading);

      h.coordinator.requestFollowOnLayout(_geo(pixels: 300, max: 1000));
      expect(
        h.coordinator.hasPendingCorrection,
        isFalse,
        reason: '阅读态不得被布局变化抢回',
      );
      expect(h.ensureFrameCalls, 0);

      h.coordinator.requestForcedFollow(geometry: _geo(pixels: 300, max: 1000));
      expect(h.coordinator.intent, FollowIntent.followLatest);
      expect(h.ensureFrameCalls, 1);
    });

    test('dispose 后不再排帧、不再执行', () {
      final h = _Harness();
      h.coordinator.dispose();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 990, max: 1000));
      h.coordinator.requestForcedFollow(geometry: _geo(pixels: 0, max: 1000));
      expect(h.ensureFrameCalls, 0);
      expect(h.frame(_geo(pixels: 0, max: 1000)), isNull);
    });
  });

  group('程序性滚动', () {
    test('begin/endProgrammaticScroll 标记可嵌套且成对归零', () {
      final h = _Harness();
      expect(h.coordinator.isProgrammaticScroll, isFalse);
      h.coordinator.beginProgrammaticScroll();
      h.coordinator.beginProgrammaticScroll();
      expect(h.coordinator.isProgrammaticScroll, isTrue);
      h.coordinator.endProgrammaticScroll();
      expect(h.coordinator.isProgrammaticScroll, isTrue);
      h.coordinator.endProgrammaticScroll();
      expect(h.coordinator.isProgrammaticScroll, isFalse);
    });
  });

  group('几何判据', () {
    test('越界（pixels > max）不算收敛，校正目标为 max', () {
      final h = _Harness();
      h.coordinator.requestForcedFollow(
        geometry: _geo(pixels: 2000, max: 1000),
      );
      final decision = h.frame(_geo(pixels: 2000, max: 1000));
      expect(decision, isNotNull);
      expect(decision!.targetPixels, 1000);
      expect(_geo(pixels: 2000, max: 1000).rangeError, 1000);
    });

    test('center 负 min 的越界按实际 min 计算，不夹成 0', () {
      final g = _geo(pixels: -20, max: 1000, min: -10);
      expect(g.rangeError, 10);
    });

    test('160px 阈值只决定展示，不决定 1px 收敛容差', () {
      final h = _Harness();
      h.coordinator.requestFollowOnLayout(_geo(pixels: 840, max: 1000));
      final decision = h.frame(_geo(pixels: 840, max: 1000));
      expect(decision, isNotNull, reason: '跟随态下 160px 内仍需收敛到真实末端');
      final converged = h.frame(_geo(pixels: 1000, max: 1000));
      expect(converged, isNull);
    });
  });
}
