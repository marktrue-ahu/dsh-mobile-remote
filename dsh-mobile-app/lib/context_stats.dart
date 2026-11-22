// issue #158 / ADR 0038：上下文统计四量分离。
//
// pressure = 上下文占用锚点（provider 最近一次请求，projected 优先）；
// breakdown = 启发式构成估算，三项独立、**不相加**、不归一化成 pressure；
// tokenUsage = 会话累计 provider 桶；timing = 整份会话累计（非每轮）。
//
// 解析 fail-open：字段缺失/类型不符就省略该块；绝不返回 0 冒充“没有”。

import 'fmt.dart';
import 'l10n.dart';

class ContextPressureStats {
  final int? pressureTokens;
  final int? projectedTokens;
  final int? contextWindow;
  final int? percent;

  const ContextPressureStats({
    this.pressureTokens,
    this.projectedTokens,
    this.contextWindow,
    this.percent,
  });

  bool get isEmpty =>
      pressureTokens == null &&
      projectedTokens == null &&
      contextWindow == null;

  /// 占用锚点：projected 优先，其次 pressure（与宿主口径一致）。
  int? get usedTokens => projectedTokens ?? pressureTokens;

  /// 百分比：优先宿主下发；否则按占用锚点/窗口计算；无数据返回 null。
  int? get effectivePercent {
    if (percent != null) return percent!.clamp(0, 100);
    final used = usedTokens;
    final window = contextWindow;
    if (used == null || window == null || window <= 0 || used <= 0) return null;
    return ((used / window) * 100).round().clamp(0, 100);
  }

  static ContextPressureStats? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final pressure = _intOrNull(map['pressureTokens']);
    final projected = _intOrNull(map['projectedTokens']);
    final window = _intOrNull(map['contextWindow']);
    final percent = _intOrNull(map['percent']);
    if (pressure == null && projected == null && window == null) return null;
    return ContextPressureStats(
      pressureTokens: pressure,
      projectedTokens: projected,
      contextWindow: window,
      percent: percent,
    );
  }
}

class ContextBreakdownStats {
  final int systemTokens;
  final int toolsTokens;
  final int messageTokens;
  final bool estimated;

  const ContextBreakdownStats({
    required this.systemTokens,
    required this.toolsTokens,
    required this.messageTokens,
    this.estimated = true,
  });

  static ContextBreakdownStats? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final system = _intOrNull(map['systemTokens']);
    final tools = _intOrNull(map['toolsTokens']);
    final message = _intOrNull(map['messageTokens']);
    if (system == null || tools == null || message == null) return null;
    return ContextBreakdownStats(
      systemTokens: system,
      toolsTokens: tools,
      messageTokens: message,
      estimated: map['estimated'] != false,
    );
  }
}

class ContextTokenUsageStats {
  final int uncachedInput;
  final int output;
  final int cacheRead;
  final int cacheWrite;
  final double? cacheHitRate;

  const ContextTokenUsageStats({
    required this.uncachedInput,
    required this.output,
    required this.cacheRead,
    required this.cacheWrite,
    this.cacheHitRate,
  });

  int get total => uncachedInput + output + cacheRead + cacheWrite;

  double? get effectiveCacheHitRate {
    if (cacheHitRate != null) return cacheHitRate!.clamp(0.0, 1.0);
    final billed = uncachedInput + cacheRead + cacheWrite;
    if (billed <= 0) return null;
    return (cacheRead / billed).clamp(0.0, 1.0);
  }

  static ContextTokenUsageStats? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final uncached = _intOrNull(map['uncachedInput']);
    final output = _intOrNull(map['output']);
    final cacheRead = _intOrNull(map['cacheRead']);
    final cacheWrite = _intOrNull(map['cacheWrite']);
    if (uncached == null ||
        output == null ||
        cacheRead == null ||
        cacheWrite == null) {
      return null;
    }
    final rate = map['cacheHitRate'];
    return ContextTokenUsageStats(
      uncachedInput: uncached,
      output: output,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite,
      cacheHitRate: rate is num && rate.isFinite ? rate.toDouble() : null,
    );
  }
}

class ContextTimingStats {
  final int turns;
  final int steps;
  final int llmMs;
  final int toolMs;
  final int ttftMs;
  final int decodeMs;
  final double? avgTtftMs;
  final double? tps;

  const ContextTimingStats({
    required this.turns,
    required this.steps,
    required this.llmMs,
    required this.toolMs,
    required this.ttftMs,
    required this.decodeMs,
    this.avgTtftMs,
    this.tps,
  });

  double? get effectiveAvgTtftMs {
    if (avgTtftMs != null) return avgTtftMs;
    return null;
  }

  static ContextTimingStats? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final turns = _intOrNull(map['turns']);
    final steps = _intOrNull(map['steps']);
    final llmMs = _intOrNull(map['llmMs']);
    final toolMs = _intOrNull(map['toolMs']);
    final ttftMs = _intOrNull(map['ttftMs']);
    final decodeMs = _intOrNull(map['decodeMs']);
    if (turns == null ||
        steps == null ||
        llmMs == null ||
        toolMs == null ||
        ttftMs == null ||
        decodeMs == null) {
      return null;
    }
    final avg = map['avgTtftMs'];
    final tps = map['tps'];
    return ContextTimingStats(
      turns: turns,
      steps: steps,
      llmMs: llmMs,
      toolMs: toolMs,
      ttftMs: ttftMs,
      decodeMs: decodeMs,
      avgTtftMs: avg is num && avg.isFinite ? avg.toDouble() : null,
      tps: tps is num && tps.isFinite ? tps.toDouble() : null,
    );
  }
}

class ContextStatsSnapshot {
  final ContextPressureStats? pressure;
  final ContextBreakdownStats? breakdown;
  final ContextTokenUsageStats? tokenUsage;
  final ContextTimingStats? timing;
  final Map<String, String> sources;
  final int? asOfSeq;

  /// 服务端逐块读取时的 cut；某块失败/各块不一致时全局 asOfSeq 省略。
  final Map<String, int> asOfSeqByBlock;

  /// 逐块标记来自旧版 /usage fallback 的块；新宿主真实块不受全局 legacy 影响。
  final Set<String> legacyBlocks;
  final bool legacyFallback;

  const ContextStatsSnapshot({
    this.pressure,
    this.breakdown,
    this.tokenUsage,
    this.timing,
    this.sources = const <String, String>{},
    this.asOfSeq,
    this.asOfSeqByBlock = const <String, int>{},
    this.legacyBlocks = const <String>{},
    this.legacyFallback = false,
  });

  /// 某块的 watermark：块 cut 优先，其次全局 cut。
  int? cutOf(String block) => asOfSeqByBlock[block] ?? asOfSeq;

  /// 失败块合并：健康块按各自 watermark 单调更新；失败块保留旧值并标记 stale。
  ContextStatsMerge mergeRefresh(ContextStatsSnapshot incoming) {
    final stale = <String>{};
    var changed = false;
    final current = this;
    final currentFallbackAll =
        current.legacyFallback && current.legacyBlocks.isEmpty;
    final incomingFallbackAll =
        incoming.legacyFallback && incoming.legacyBlocks.isEmpty;
    final currentLegacy = currentFallbackAll
        ? <String>{'pressure', 'breakdown', 'tokenUsage', 'timing'}
        : current.legacyBlocks;
    final incomingLegacy = incomingFallbackAll
        ? <String>{'pressure', 'breakdown', 'tokenUsage', 'timing'}
        : incoming.legacyBlocks;
    final acceptedCuts = <String, int?>{};
    final acceptedSources = <String, String>{};
    final legacyBlocks = <String>{...currentLegacy};
    // incoming 是否含任何新宿主真实块/水位；纯旧宿主响应缺块是能力边界，不标 stale。
    final incomingHasTrusted =
        incoming.asOfSeq != null ||
        incoming.asOfSeqByBlock.isNotEmpty ||
        (incoming.pressure != null && !incomingLegacy.contains('pressure')) ||
        (incoming.breakdown != null && !incomingLegacy.contains('breakdown')) ||
        (incoming.tokenUsage != null &&
            !incomingLegacy.contains('tokenUsage')) ||
        (incoming.timing != null && !incomingLegacy.contains('timing'));

    T? pick<T>({
      required String block,
      required T? currentValue,
      required T? incomingValue,
    }) {
      final incomingIsLegacy = incomingLegacy.contains(block);
      final currentIsLegacy = currentLegacy.contains(block);
      if (incomingValue == null) {
        // 新宿主（或其部分真实块）响应缺块 = 该块失败；纯旧宿主回退缺块是能力边界。
        if ((!incoming.legacyFallback || incomingHasTrusted) &&
            currentValue != null) {
          stale.add(block);
          changed = true;
        }
        return currentValue;
      }
      // 旧源的新值不得覆盖当前来自新宿主的真实块。
      if (incomingIsLegacy && currentValue != null && !currentIsLegacy) {
        return currentValue;
      }
      // 新宿主的当前块只能被可比较 watermark 的新块更新；无 cut 的 incoming 不可信。
      final currentCut = current.cutOf(block);
      final incomingCut = incoming.cutOf(block);
      if (!incomingIsLegacy) {
        if (currentCut != null && incomingCut == null) {
          stale.add(block);
          changed = true;
          return currentValue;
        }
        if (currentCut != null &&
            incomingCut != null &&
            incomingCut < currentCut) {
          // 迟到的旧块：保留当前值，不把它标成失败。
          return currentValue;
        }
      }
      changed = true;
      acceptedCuts[block] = incomingCut;
      if (incomingIsLegacy) {
        legacyBlocks.add(block);
      } else {
        legacyBlocks.remove(block);
      }
      final source = incoming.sources[block];
      if (source != null) acceptedSources[block] = source;
      return incomingValue;
    }

    final pressure = pick<ContextPressureStats>(
      block: 'pressure',
      currentValue: current.pressure,
      incomingValue: incoming.pressure,
    );
    final breakdown = pick<ContextBreakdownStats>(
      block: 'breakdown',
      currentValue: current.breakdown,
      incomingValue: incoming.breakdown,
    );
    final tokenUsage = pick<ContextTokenUsageStats>(
      block: 'tokenUsage',
      currentValue: current.tokenUsage,
      incomingValue: incoming.tokenUsage,
    );
    final timing = pick<ContextTimingStats>(
      block: 'timing',
      currentValue: current.timing,
      incomingValue: incoming.timing,
    );

    // 逐块 watermark 与实际接受值绑定：只有接受新值的块才更新 cut。
    final cuts = <String, int>{...current.asOfSeqByBlock};
    for (final entry in acceptedCuts.entries) {
      final cut = entry.value;
      if (cut != null) {
        cuts[entry.key] = cut;
      } else {
        cuts.remove(entry.key);
      }
    }
    final sources = <String, String>{...current.sources};
    sources.addAll(acceptedSources);
    final currentGlobal = current.asOfSeq;
    final incomingGlobal = incoming.asOfSeq;
    final mergedGlobal =
        incomingGlobal != null &&
            (currentGlobal == null || incomingGlobal >= currentGlobal)
        ? incomingGlobal
        : currentGlobal;
    final merged = ContextStatsSnapshot(
      pressure: pressure,
      breakdown: breakdown,
      tokenUsage: tokenUsage,
      timing: timing,
      sources: sources,
      asOfSeq: mergedGlobal,
      asOfSeqByBlock: cuts,
      legacyBlocks: legacyBlocks,
      legacyFallback: legacyBlocks.isNotEmpty,
    );
    return ContextStatsMerge(
      snapshot: merged,
      staleBlocks: stale,
      changed: changed,
    );
  }

  bool get isEmpty =>
      pressure == null &&
      breakdown == null &&
      tokenUsage == null &&
      timing == null;

  static ContextStatsSnapshot fromJson(Map<String, dynamic> json) {
    final rawCuts = json['asOfSeqByBlock'];
    final cuts = <String, int>{};
    if (rawCuts is Map) {
      for (final entry in rawCuts.entries) {
        final value = _intOrNull(entry.value);
        if (value != null) cuts['${entry.key}'] = value;
      }
    }
    final rawSources = json['sources'];
    final sources = <String, String>{};
    if (rawSources is Map) {
      for (final entry in rawSources.entries) {
        if (entry.value is String) {
          sources['${entry.key}'] = entry.value as String;
        }
      }
    }
    return ContextStatsSnapshot(
      pressure: ContextPressureStats.fromJson(json['pressure']),
      breakdown: ContextBreakdownStats.fromJson(json['breakdown']),
      tokenUsage: ContextTokenUsageStats.fromJson(json['tokenUsage']),
      timing: ContextTimingStats.fromJson(json['timing']),
      sources: sources,
      asOfSeq: _intOrNull(json['asOfSeq']),
      asOfSeqByBlock: cuts,
    );
  }

  /// 缺块回退：用现有 `/usage` 补齐 pressure/tokenUsage，其余块保持宿主投影。
  ///
  /// 只补缺块，不用旧数据覆盖新投影；补齐后 legacyFallback=true 供 UI 标注来源。
  ContextStatsSnapshot mergedWithLegacyUsage(Map<String, dynamic> usage) {
    final legacy = ContextStatsSnapshot.fromLegacyUsage(usage);
    final mergedPressure = pressure ?? legacy.pressure;
    final mergedTokens = tokenUsage ?? legacy.tokenUsage;
    if (mergedPressure == pressure && mergedTokens == tokenUsage) return this;
    return ContextStatsSnapshot(
      pressure: mergedPressure,
      breakdown: breakdown,
      tokenUsage: mergedTokens,
      timing: timing,
      sources: sources,
      asOfSeq: asOfSeq,
      asOfSeqByBlock: asOfSeqByBlock,
      legacyBlocks: {
        ...legacyBlocks,
        if (pressure == null && legacy.pressure != null) 'pressure',
        if (tokenUsage == null && legacy.tokenUsage != null) 'tokenUsage',
      },
      legacyFallback: true,
    );
  }

  /// 旧宿主回退：现有 `/usage` + `contextWindow`（与圆环同源）。
  /// breakdown/timing 明确不可用，不伪造。
  factory ContextStatsSnapshot.fromLegacyUsage(Map<String, dynamic> usage) {
    final window = _intOrNull(usage['contextWindow']);
    final pressureTokens = _intOrNull(usage['pressureTokens']);
    final input = _intOrNull(usage['inputTokens']) ?? 0;
    final output = _intOrNull(usage['outputTokens']) ?? 0;
    final cacheRead = _intOrNull(usage['cacheReadTokens']) ?? 0;
    final cacheWrite = _intOrNull(usage['cacheWriteTokens']) ?? 0;
    final billed = input + cacheRead + cacheWrite;
    final pressure = (pressureTokens != null || window != null)
        ? ContextPressureStats(
            pressureTokens: pressureTokens,
            contextWindow: window,
          )
        : null;
    final tokens =
        (input != 0 || output != 0 || cacheRead != 0 || cacheWrite != 0)
        ? ContextTokenUsageStats(
            uncachedInput: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            cacheHitRate: billed > 0 ? cacheRead / billed : null,
          )
        : null;
    return ContextStatsSnapshot(
      pressure: pressure,
      tokenUsage: tokens,
      legacyBlocks: {
        if (pressure != null) 'pressure',
        if (tokens != null) 'tokenUsage',
      },
      legacyFallback: true,
    );
  }
}

/// 一次 refresh 的合并结果：健康块更新 + 失败块 stale 集合。
class ContextStatsMerge {
  final ContextStatsSnapshot snapshot;
  final Set<String> staleBlocks;
  final bool changed;

  const ContextStatsMerge({
    required this.snapshot,
    required this.staleBlocks,
    required this.changed,
  });
}

int? _intOrNull(Object? value) {
  if (value is num && value.isFinite) {
    final rounded = value.round();
    return rounded < 0 ? null : rounded;
  }
  return null;
}

/// 百分比文案（四舍五入；null 返回 null，由调用方决定“不可用”）。
String? formatStatsPercent(int? percent) =>
    percent == null ? null : '${percent.clamp(0, 100)}%';

/// 时长文案：<1s / 1.2s / 1m 05s。
String formatStatsDuration(num? ms) {
  if (ms == null || !ms.isFinite || ms < 0) return '--';
  final value = ms.toDouble();
  if (value < 1000) return '${value.round()}ms';
  if (value < 60000) return '${(value / 1000).toStringAsFixed(1)}s';
  final minutes = value ~/ 60000;
  final seconds = ((value % 60000) / 1000).round();
  return '${minutes}m ${seconds.toString().padLeft(2, '0')}s';
}

/// 首 token / 速度文案。
String formatAvgTtft(num? ms) =>
    ms == null || !ms.isFinite ? '--' : formatStatsDuration(ms);
String formatTps(num? tps) =>
    tps == null || !tps.isFinite ? '--' : '${tps.toStringAsFixed(1)} tok/s';

/// 窗口占用文案：~33.2k / 128k；数据缺失时返回 null，不显示假 0。
String? formatContextWindowUsed(ContextPressureStats? pressure) {
  if (pressure == null) return null;
  final used = pressure.usedTokens;
  final window = pressure.contextWindow;
  if (used == null && window == null) return null;
  final usedText = used == null ? '--' : '~${fmtTokens(used)}';
  final windowText = window == null ? '--' : fmtTokens(window);
  return '$usedText / $windowText';
}

/// 分项占窗口比例（仅用于该分项的独立条；不是总和占比）。
double? breakdownShareOfWindow(int tokens, int? window) {
  if (window == null || window <= 0) return null;
  return (tokens / window).clamp(0.0, 1.0);
}

/// 分项估算说明（UI 与 Semantics 共用）。
String breakdownDisclaimer() => L10n.t(
  '系统提示、工具定义、会话消息是相互独立的启发式估算，不保证相加等于上下文占用；占用以 pressure 为准。',
  'System, tools and messages are independent heuristic estimates; they need not add up to context pressure.',
);

String privacyNote() => L10n.t(
  '仅统计与估算；不显示对话正文、系统提示或工具定义。',
  'Statistics and estimates only; no conversation text, system prompts, or tool definitions are shown.',
);
