// issue #158：上下文统计四量分离的解析/降级/格式化（ADR 0038）。
import 'package:dsh_mobile_app/context_stats.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('完整 JSON：四块独立解析，pressure percent 使用 projected 优先', () {
    final snapshot = ContextStatsSnapshot.fromJson({
      'ok': true,
      'sessionId': 's1',
      'pressure': {
        'pressureTokens': 1000,
        'projectedTokens': 1200,
        'contextWindow': 8000,
        'percent': 15,
      },
      'breakdown': {
        'systemTokens': 400,
        'toolsTokens': 600,
        'messageTokens': 800,
        'estimated': true,
      },
      'tokenUsage': {
        'uncachedInput': 100,
        'output': 50,
        'cacheRead': 300,
        'cacheWrite': 100,
        'cacheHitRate': 0.6,
      },
      'timing': {
        'turns': 2,
        'steps': 4,
        'llmMs': 1000,
        'toolMs': 500,
        'ttftMs': 400,
        'decodeMs': 2000,
        'avgTtftMs': 200,
        'tps': 50,
      },
      'sources': {'pressure': 'provider', 'breakdown': 'heuristic'},
      'asOfSeq': 7,
    });

    expect(snapshot.pressure?.usedTokens, 1200, reason: 'projected 优先');
    expect(snapshot.pressure?.effectivePercent, 15);
    expect(snapshot.breakdown?.systemTokens, 400);
    expect(snapshot.breakdown?.toolsTokens, 600);
    expect(snapshot.breakdown?.messageTokens, 800);
    expect(snapshot.breakdown?.estimated, isTrue);
    expect(snapshot.tokenUsage?.total, 550);
    expect(snapshot.tokenUsage?.effectiveCacheHitRate, 0.6);
    expect(snapshot.timing?.turns, 2);
    expect(snapshot.timing?.avgTtftMs, 200);
    expect(snapshot.timing?.tps, 50);
    expect(snapshot.sources['pressure'], 'provider');
    expect(snapshot.asOfSeq, 7);
    // 四量不互相合成：breakdown 之和 (1800) 不等于 pressure used (1200)。
    expect(
      snapshot.breakdown!.systemTokens +
          snapshot.breakdown!.toolsTokens +
          snapshot.breakdown!.messageTokens,
      isNot(snapshot.pressure!.usedTokens),
    );
  });

  test('缺失/非法字段：整块省略，不返回 0 冒充', () {
    final snapshot = ContextStatsSnapshot.fromJson({
      'pressure': {'contextWindow': 8000},
      'breakdown': {'systemTokens': 1, 'toolsTokens': 2},
      'tokenUsage': {'uncachedInput': 'bad'},
      'timing': null,
    });
    expect(snapshot.pressure?.contextWindow, 8000);
    expect(snapshot.pressure?.effectivePercent, isNull);
    expect(snapshot.breakdown, isNull);
    expect(snapshot.tokenUsage, isNull);
    expect(snapshot.timing, isNull);
    expect(snapshot.isEmpty, isFalse);

    final empty = ContextStatsSnapshot.fromJson({'ok': true, 'sessionId': 's'});
    expect(empty.isEmpty, isTrue);
    expect(empty.legacyFallback, isFalse);
  });

  test('旧宿主 legacy /usage：只有 pressure + tokenUsage，breakdown/timing 不可用', () {
    final legacy = ContextStatsSnapshot.fromLegacyUsage({
      'inputTokens': 100,
      'outputTokens': 50,
      'cacheReadTokens': 300,
      'cacheWriteTokens': 100,
      'pressureTokens': 2000,
      'contextWindow': 8000,
    });
    expect(legacy.legacyFallback, isTrue);
    expect(legacy.pressure?.pressureTokens, 2000);
    expect(legacy.pressure?.effectivePercent, 25);
    expect(legacy.tokenUsage?.uncachedInput, 100);
    expect(legacy.tokenUsage?.effectiveCacheHitRate, 0.6);
    expect(legacy.breakdown, isNull);
    expect(legacy.timing, isNull);

    final emptyLegacy = ContextStatsSnapshot.fromLegacyUsage(const {});
    expect(emptyLegacy.isEmpty, isTrue);
    expect(emptyLegacy.legacyFallback, isTrue);
  });

  test('缺块回退：/usage 只补 pressure/token，不覆盖已有 breakdown/timing', () {
    final partial = ContextStatsSnapshot.fromJson({
      'breakdown': {'systemTokens': 1, 'toolsTokens': 2, 'messageTokens': 3},
      'timing': {
        'turns': 1,
        'steps': 1,
        'llmMs': 10,
        'toolMs': 20,
        'ttftMs': 30,
        'decodeMs': 40,
        'avgTtftMs': 30,
        'tps': 2.5,
      },
    });
    final merged = partial.mergedWithLegacyUsage({
      'inputTokens': 100,
      'outputTokens': 50,
      'cacheReadTokens': 300,
      'cacheWriteTokens': 100,
      'pressureTokens': 2000,
      'contextWindow': 8000,
    });
    expect(merged.pressure?.effectivePercent, 25);
    expect(merged.tokenUsage?.uncachedInput, 100);
    expect(merged.breakdown?.systemTokens, 1, reason: '已有投影不被 /usage 覆盖');
    expect(merged.timing?.turns, 1);
    expect(merged.legacyFallback, isTrue);

    // 两块的投影都齐全时不合并、不改 legacy 标记。
    final full = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 1, 'contextWindow': 10},
      'tokenUsage': {
        'uncachedInput': 1,
        'output': 1,
        'cacheRead': 1,
        'cacheWrite': 1,
      },
    });
    expect(identical(full.mergedWithLegacyUsage(const {}), full), isTrue);
  });

  test('格式化：token/时长/首 token/TPS/窗口文案', () {
    expect(formatStatsPercent(30), '30%');
    expect(formatStatsPercent(null), isNull);
    expect(formatStatsDuration(800), '800ms');
    expect(formatStatsDuration(1500), '1.5s');
    expect(formatStatsDuration(65000), '1m 05s');
    expect(formatStatsDuration(null), '--');
    expect(formatAvgTtft(200), '200ms');
    expect(formatTps(50), '50.0 tok/s');
    expect(formatTps(null), '--');
    expect(
      formatContextWindowUsed(
        const ContextPressureStats(projectedTokens: 1200, contextWindow: 8000),
      ),
      '~1.2k / 8.0k',
    );
    expect(formatContextWindowUsed(null), isNull);
    expect(breakdownShareOfWindow(1000, 8000), 0.125);
    expect(breakdownShareOfWindow(1000, 0), isNull);
  });
}
