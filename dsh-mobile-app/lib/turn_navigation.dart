// issue #24：对话轮次导航 —— 纯逻辑（无 Flutter 依赖，便于单测）。
//
// 「轮次索引」是**派生结构**：由会话事件折叠得出轮次号 → 该轮起始事件的持久序号。
// 会话日志里不存在用户编写的轮次元数据，本文件也不持有任何状态（见 ADR 0018）。
//
// 抽成无 Flutter 依赖的纯函数，理由与 `chat_copy.dart` 相同：折叠规则（边界推进、
// 预览归属、空白归一、截断）是容易写错又必须与电脑端一致的部分，必须在没有 widget
// 树的测试里钉死。

/// 一轮在刻度轨上的定位信息。
///
/// [seq] 是该轮 `turn/start` 事件的持久序号——它天然就是"定位到这一轮"的锚点，
/// 与电脑端刻度轨及分页语义一致。
class TurnAnchor {
  const TurnAnchor({
    required this.turn,
    required this.seq,
    this.prompt = '',
    this.response = '',
  });

  /// 宿主分配的轮次号（`turn/start` 载荷里的 `turn`）。
  final int turn;

  /// 该轮起始事件的持久序号（定位锚点）。
  final int seq;

  /// 提示词预览（已归一化、已截断）。
  final String prompt;

  /// 回复预览（已归一化、已截断）。
  final String response;

  @override
  bool operator ==(Object other) =>
      other is TurnAnchor &&
      other.turn == turn &&
      other.seq == seq &&
      other.prompt == prompt &&
      other.response == response;

  @override
  int get hashCode => Object.hash(turn, seq, prompt, response);

  @override
  String toString() =>
      'TurnAnchor(turn: $turn, seq: $seq, prompt: "$prompt", response: "$response")';
}

/// 折叠输入行的角色。只有真人提示词与助手回复参与预览。
enum TurnRowRole { user, assistant, other }

/// 折叠输入的一行。调用方必须按**时间正序**提供全部已加载条目。
class TurnRow {
  const TurnRow({
    this.boundaryTurn,
    this.seq,
    this.role = TurnRowRole.other,
    this.text = '',
  });

  /// 轮次边界行携带的轮次号；非边界行为 null。
  ///
  /// 只有 `turn/start` 产生边界：`turn/end` 不推进轮次号，只表示该轮结束，
  /// 因此不需要单独表达（回复预览在轮内最后一条助手消息时就已落定）。
  final int? boundaryTurn;

  /// 边界行的持久序号（定位锚点）；非 boundary 行为 null。
  final int? seq;

  final TurnRowRole role;
  final String text;
}

/// 提示词预览预算（与电脑端刻度轨一致：50 字符封顶）。
const int kTurnPromptMaxChars = 50;

/// 回复预览预算（与电脑端刻度轨一致：120 字符封顶）。
const int kTurnResponseMaxChars = 120;

/// 刻度轨显隐判据。
///
/// - `nearBottom`：距底部 160px 内视为"停留最新"（复用「回到底部」圆钮的既有判据，
///   使两个控件同进同出）。
/// - `turnCount`：已知轮次数。少于 2 轮时不渲染——一轮没有导航价值，只是噪声。
bool shouldShowTurnRail({required bool nearBottom, required int turnCount}) =>
    !nearBottom && turnCount >= 2;

/// 预览文本归一化：折叠全部空白、去首尾、超长截断并补省略号。
///
/// 归一化是预览的**唯一入口**，保证同一轮在刻度气泡里显示的文字稳定，
/// 不因换行/缩进差异而跳动。
String normalizeTurnPreview(String raw, {required int maxChars}) {
  final flat = raw.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= maxChars) return flat;
  return '${flat.substring(0, maxChars)}…';
}

/// 从按时间正序的行折叠出轮次锚点（按轮次号严格升序）。
///
/// 规则（与电脑端轮次大纲一致）：
/// - 以 `turn/start` 为锚，**不**以提示词为锚——因为锚点的持久序号必须是分页目标；
/// - 未推进轮次号的边界被跳过，保持升序（重试边界不会产生重复刻度）；
/// - 提示词取该轮内**第一条**真人提示词（中途引导保留首个预览）；
/// - 回复取该轮内最后一条有文本的助手消息；
/// - 边界之前的散落消息不属于任何轮次，忽略。
List<TurnAnchor> foldTurnAnchors(Iterable<TurnRow> rows) {
  final out = <TurnAnchor>[];
  int? turn;
  int? seq;
  var prompt = '';
  var response = '';

  void commit() {
    final t = turn;
    final s = seq;
    if (t == null || s == null) return;
    out.add(TurnAnchor(turn: t, seq: s, prompt: prompt, response: response));
  }

  for (final row in rows) {
    final boundary = row.boundaryTurn;
    final boundarySeq = row.seq;
    if (boundary != null && boundarySeq != null) {
      final current = turn;
      // 未推进轮次号：跳过，绝不产生第二个同号刻度。
      if (current != null && boundary <= current) continue;
      commit();
      turn = boundary;
      seq = boundarySeq;
      prompt = '';
      response = '';
      continue;
    }
    if (turn == null) continue; // 边界之前：不属于任何轮次
    if (row.role == TurnRowRole.user) {
      if (prompt.isEmpty) {
        prompt = normalizeTurnPreview(row.text, maxChars: kTurnPromptMaxChars);
      }
    } else if (row.role == TurnRowRole.assistant) {
      final text =
          normalizeTurnPreview(row.text, maxChars: kTurnResponseMaxChars);
      if (text.isNotEmpty) response = text;
    }
  }
  commit();
  return out;
}

/// 当前轮判定：停留在最新位置时取最后一轮，否则取"跨过阅读线"的那一轮。
///
/// [mounted] 是**已构建**刻度的几何信息（屏幕外的懒构建条目不在其中），
/// [readingLine] 是阅读线在视口中的 y 坐标。
///
/// 取"起点不晚于阅读线的最后一个刻度"：若阅读线在所有刻度之上，退化为第一轮。
int? activeTurnFromMounted(
  List<({int turn, double top})> mounted, {
  required double readingLine,
}) {
  if (mounted.isEmpty) return null;
  int? candidate;
  for (final m in mounted) {
    if (m.top <= readingLine) {
      if (candidate == null || m.turn > candidate) candidate = m.turn;
    }
  }
  if (candidate != null) return candidate;
  // 阅读线在全部已构建刻度之上：取最靠上（最小 y）的那个。
  var best = mounted.first;
  for (final m in mounted) {
    if (m.top < best.top) best = m;
  }
  return best.turn;
}

/// 有界迭代定位的比例估算：把目标在子项中的序号线性映射到可滚动区间。
///
/// 这只是**第一次**落点，真实收敛靠"落点后用实测邻居修正"（见 `_jumpToTurn`）。
/// 因为条目高度可变，比例估算必然不准，所以它只用于把目标带进构建范围。
double estimateTurnOffset({
  required int targetIndex,
  required int childCount,
  required double minScrollExtent,
  required double maxScrollExtent,
}) {
  if (childCount <= 1) return maxScrollExtent;
  final clamped = targetIndex.clamp(0, childCount - 1);
  final ratio = clamped / (childCount - 1);
  return minScrollExtent + (maxScrollExtent - minScrollExtent) * ratio;
}

/// 有界迭代定位的最大尝试次数：有界，避免病态布局下无限抖动。
const int kTurnLocateMaxAttempts = 6;

/// 跳转进行中允许的最大时长（毫秒），超时按「未能定位」明说。
///
/// 它是**硬截止**：超时后不再产生任何滚动 / 精调副作用（见 [TurnLocator.locate]）。
const int kTurnLocateTimeoutMs = 4000;

/// 一个**已构建**轮次边界的实测几何。
///
/// [offset] 是该边界在滚动内容坐标系里的偏移（= 当前 `pixels` + 边界相对视口顶部的
/// dy）。它可以在不同落点之间比较、插值——这正是「按实际落点校正」的依据。
class TurnMeasurement {
  const TurnMeasurement({required this.turn, required this.offset});

  final int turn;
  final double offset;
}

/// 定位失败的原因（两者提示文案不同，调用方必须区分）。
enum TurnLocateFailure {
  /// 目标持久序号根本不在已加载窗口内（例如已翻出窗口 / 属于未分页的更早部分）。
  notInWindow,

  /// 目标在窗口内，但有界尝试次数或截止时间用尽仍未把它带进视口。
  exhausted,
}

/// 定位结果：成功（目标与视口相交）或带有明确原因的失败。
class TurnLocateOutcome {
  const TurnLocateOutcome.ok() : ok = true, failure = null;
  const TurnLocateOutcome.failed(TurnLocateFailure this.failure) : ok = false;

  final bool ok;
  final TurnLocateFailure? failure;
}

/// 用实测点估算「把 [targetTurn] 带进视口」所需的内容偏移。
///
/// 规则（按可信度降级）：
/// 1. 目标被两个实测点夹逼 → 在两者之间线性插值；
/// 2. 只有目标之前 / 之后的实测点 → 用最近两个实测点做割线外推；
/// 3. 一个实测点都没有 → 退回 [estimateTurnOffset] 的比例估算（兜底）。
///
/// 实测点的 [TurnMeasurement.offset] 已经是内容坐标，因此返回值也是内容坐标。
double estimateTurnOffsetFromMeasurements({
  required int targetTurn,
  required List<TurnMeasurement> measurements,
  required int targetIndex,
  required int childCount,
  required double minScrollExtent,
  required double maxScrollExtent,
}) {
  final sorted = [...measurements]..sort((a, b) => a.turn.compareTo(b.turn));
  TurnMeasurement? before;
  TurnMeasurement? after;
  for (final m in sorted) {
    if (m.turn <= targetTurn && (before == null || m.turn > before.turn)) {
      before = m;
    }
    if (m.turn >= targetTurn && (after == null || m.turn < after.turn)) {
      after = m;
    }
  }
  if (before != null && after != null) {
    if (before.turn == after.turn) return before.offset;
    final f = (targetTurn - before.turn) / (after.turn - before.turn);
    return before.offset + (after.offset - before.offset) * f;
  }
  if (before != null) {
    final slope = _secantSlope(sorted, targetTurn, useBefore: true);
    if (slope != null) return before.offset + slope * (targetTurn - before.turn);
  }
  if (after != null) {
    final slope = _secantSlope(sorted, targetTurn, useBefore: false);
    if (slope != null) return after.offset - slope * (after.turn - targetTurn);
  }
  return estimateTurnOffset(
    targetIndex: targetIndex,
    childCount: childCount,
    minScrollExtent: minScrollExtent,
    maxScrollExtent: maxScrollExtent,
  );
}

/// 每个刻度在内容坐标里的平均步距（最近两点割线）；点数不足或斜率非正时返回 null。
double? _secantSlope(
  List<TurnMeasurement> sorted,
  int targetTurn, {
  required bool useBefore,
}) {
  final candidates = useBefore
      ? sorted.where((m) => m.turn < targetTurn).toList()
      : sorted.where((m) => m.turn > targetTurn).toList();
  if (candidates.length < 2) return null;
  final TurnMeasurement a;
  final TurnMeasurement b;
  if (useBefore) {
    a = candidates[candidates.length - 1];
    b = candidates[candidates.length - 2];
  } else {
    a = candidates[0];
    b = candidates[1];
  }
  if (a.turn == b.turn) return null;
  final slope = (a.offset - b.offset) / (a.turn - b.turn);
  return slope > 0 ? slope : null;
}

/// 有界迭代定位的执行器。
///
/// 把「估算 → 落点 → 检查目标是否真的进入视口」这条控制流从页面里抽出来：它是最
/// 容易写错、也最需要回归保护的部分（懒构建 + center 锚点 + 条目高度可变）。本类
/// **不依赖 Flutter**，几何与副作用全部由回调注入，因此既能被真实列表驱动，
/// 也能用假回调做边界测试。
///
/// 与旧实现的关键差别：每轮尝试都用 [measure] 给出的**已构建边界实测几何**校正
/// 落点，而不是反复用同一个「轮次序号 / 轮次数量」比例；并且最终以
/// [isTargetInView]（目标与视口相交）而非 [isTargetBuilt]（目标已构建）为成功判据。
class TurnLocator {
  TurnLocator({
    required this.scrollTo,
    required this.minScrollExtent,
    required this.maxScrollExtent,
    required this.isTargetLoaded,
    required this.isTargetBuilt,
    required this.isTargetInView,
    required this.reveal,
    required this.measure,
    required this.settle,
    this.maxAttempts = kTurnLocateMaxAttempts,
    this.timeout = const Duration(milliseconds: kTurnLocateTimeoutMs),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  /// 跳到某个可滚动偏移。
  final void Function(double offset) scrollTo;
  final double Function() minScrollExtent;
  final double Function() maxScrollExtent;

  /// 目标（按持久 seq 绑定的那个规范边界）是否仍在已加载窗口内。
  ///
  /// 这是 [TurnLocateFailure.notInWindow] 与 [TurnLocateFailure.exhausted] 的分界。
  final bool Function() isTargetLoaded;

  /// 目标是否已经构建（懒构建下这是「能不能精调」的判据）。
  final bool Function() isTargetBuilt;

  /// 目标是否与视口相交——**唯一的成功判据**（「已构建」可能是缓存区里的条目）。
  final bool Function() isTargetInView;

  /// 目标已构建时做一次精调（页面侧是 `Scrollable.ensureVisible`）。
  final Future<void> Function() reveal;

  /// 已构建轮次边界的实测几何（每次校正前重新采样）。
  final List<TurnMeasurement> Function() measure;

  /// 等待一帧，让新落点处的条目完成构建与布局。
  final Future<void> Function() settle;

  final int maxAttempts;

  /// 硬截止时间：超时后不再滚动 / 精调。
  final Duration timeout;

  final DateTime Function() _clock;

  /// 尝试把 [targetTurn] 带进视口。
  ///
  /// 返回 [TurnLocateOutcome]；失败原因由 [TurnLocateFailure] 区分，**调用方必须
  /// 把这个结果如实告诉用户**，不得静默停下。
  Future<TurnLocateOutcome> locate({
    required int targetTurn,
    required int targetIndex,
    required int childCount,
  }) async {
    if (!isTargetLoaded()) {
      return const TurnLocateOutcome.failed(TurnLocateFailure.notInWindow);
    }
    if (isTargetInView()) return const TurnLocateOutcome.ok();
    final start = _clock();
    bool timedOut() => _clock().difference(start) >= timeout;

    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      if (timedOut()) {
        return const TurnLocateOutcome.failed(TurnLocateFailure.exhausted);
      }
      // 目标已构建但不在视口内：先按渲染对象精调，避免无效的比例移动。
      if (isTargetBuilt()) {
        await reveal();
        await settle();
        if (isTargetInView()) return const TurnLocateOutcome.ok();
        if (timedOut()) {
          return const TurnLocateOutcome.failed(TurnLocateFailure.exhausted);
        }
      }
      final min = minScrollExtent();
      final max = maxScrollExtent();
      final offset = estimateTurnOffsetFromMeasurements(
        targetTurn: targetTurn,
        measurements: measure(),
        targetIndex: targetIndex,
        childCount: childCount,
        minScrollExtent: min,
        maxScrollExtent: max,
      );
      scrollTo(offset.clamp(min, max).toDouble());
      await settle();
    }
    if (timedOut()) {
      return const TurnLocateOutcome.failed(TurnLocateFailure.exhausted);
    }
    if (isTargetBuilt()) {
      await reveal();
      await settle();
    }
    return isTargetInView()
        ? const TurnLocateOutcome.ok()
        : const TurnLocateOutcome.failed(TurnLocateFailure.exhausted);
  }
}
