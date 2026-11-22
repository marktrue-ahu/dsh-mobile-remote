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

  test('逐块 watermark：拒绝旧块绝不下调 cut，后续旧块仍被拒', () {
    final current = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 100, 'contextWindow': 1000},
      'asOfSeq': 100,
    });
    final older = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 200, 'contextWindow': 1000},
      'asOfSeqByBlock': {'pressure': 80},
    });
    final first = current.mergeRefresh(older);
    expect(first.snapshot.pressure?.pressureTokens, 100);
    expect(first.snapshot.cutOf('pressure'), 100);

    final older2 = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 300, 'contextWindow': 1000},
      'asOfSeqByBlock': {'pressure': 90},
    });
    final second = first.snapshot.mergeRefresh(older2);
    expect(second.snapshot.pressure?.pressureTokens, 100);
    expect(second.snapshot.cutOf('pressure'), 100);
  });

  test('逐块 watermark：新全局覆盖 per-block cut，后续更旧块被拒', () {
    final current = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 100, 'contextWindow': 1000},
      'asOfSeqByBlock': {'pressure': 10},
    });
    final global = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 200, 'contextWindow': 1000},
      'asOfSeq': 100,
    });
    final first = current.mergeRefresh(global);
    expect(first.snapshot.pressure?.pressureTokens, 200);
    expect(first.snapshot.cutOf('pressure'), 100);

    final olderBlock = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 300, 'contextWindow': 1000},
      'asOfSeqByBlock': {'pressure': 20},
    });
    final second = first.snapshot.mergeRefresh(olderBlock);
    expect(second.snapshot.pressure?.pressureTokens, 200);
    expect(second.snapshot.cutOf('pressure'), 100);
  });

  test('无可比较水位：无 cut 的非 legacy incoming 不覆盖可信块，并标 stale', () {
    final current = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 100, 'contextWindow': 1000},
      'asOfSeq': 100,
    });
    final unknown = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 200, 'contextWindow': 1000},
    });
    final merged = current.mergeRefresh(unknown);
    expect(merged.snapshot.pressure?.pressureTokens, 100);
    expect(merged.snapshot.cutOf('pressure'), 100);
    expect(merged.staleBlocks, contains('pressure'));
  });

  test('逐块 legacy：只对实际 fallback 块走旧源策略，新宿主 pressure 继续更新', () {
    final newHost = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 100, 'contextWindow': 1000},
      'timing': {
        'turns': 1,
        'steps': 1,
        'llmMs': 10,
        'toolMs': 20,
        'ttftMs': 30,
        'decodeMs': 40,
      },
      'asOfSeq': 10,
    });
    final withLegacyToken = newHost.mergedWithLegacyUsage({
      'inputTokens': 100,
      'outputTokens': 50,
      'cacheReadTokens': 300,
      'cacheWriteTokens': 100,
      'pressureTokens': 999,
      'contextWindow': 1000,
    });
    expect(withLegacyToken.legacyBlocks, {'tokenUsage'});
    expect(withLegacyToken.legacyBlocks.contains('pressure'), isFalse);
    expect(withLegacyToken.pressure?.pressureTokens, 100);

    final newerPressure = ContextStatsSnapshot.fromJson({
      'pressure': {'pressureTokens': 200, 'contextWindow': 1000},
      'asOfSeq': 11,
    });
    final merged = withLegacyToken.mergeRefresh(newerPressure);
    expect(
      merged.snapshot.pressure?.pressureTokens,
      200,
      reason: '新 pressure 不被 legacy 阻止',
    );
    expect(
      merged.snapshot.tokenUsage?.uncachedInput,
      100,
      reason: 'legacy token 块保留',
    );
    expect(merged.snapshot.legacyBlocks, {'tokenUsage'});

    // 旧源 pressure 不得覆盖新宿主 pressure。
    final legacyOlder = ContextStatsSnapshot.fromLegacyUsage({
      'pressureTokens': 300,
      'contextWindow': 1000,
      'inputTokens': 1,
      'outputTokens': 1,
      'cacheReadTokens': 0,
      'cacheWriteTokens': 0,
    });
    final stillNew = merged.snapshot.mergeRefresh(legacyOlder);
    expect(stillNew.snapshot.pressure?.pressureTokens, 200);
  });
}
