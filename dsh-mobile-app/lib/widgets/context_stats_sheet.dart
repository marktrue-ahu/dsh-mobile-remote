// issue #158 / ADR 0038：输入区上下文统计抽屉（三 Tab）。
//
// 只读展示：pressure 是唯一占用锚点；breakdown 三项独立估算、不相加成总条；
// tokenUsage 是会话累计；timing 是整份会话累计。只显示统计/估算，不显示 prompt、
// 正文、工具定义或文件路径。旧宿主回退 /usage，breakdown/timing 明确降级。
import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../context_stats.dart';
import '../fmt.dart';
import '../l10n.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';

Future<void> showContextStatsSheet(
  BuildContext context, {
  required Api api,
  required AppStore store,
  required String sessionId,
  required String model,
  required Map<String, dynamic> fallbackUsage,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: DshColors.surface(context),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(DshTheme.radiusLg),
      ),
    ),
    builder: (ctx) {
      final size = MediaQuery.sizeOf(ctx);
      final scale = MediaQuery.textScalerOf(ctx).scale(1.0);
      final heightFactor = size.width <= 340 && scale >= 1.4 ? 0.92 : 0.82;
      return FractionallySizedBox(
        heightFactor: heightFactor,
        child: ContextStatsSheet(
          api: api,
          store: store,
          sessionId: sessionId,
          model: model,
          fallbackUsage: fallbackUsage,
        ),
      );
    },
  );
}

class ContextStatsSheet extends StatefulWidget {
  final Api api;
  final AppStore store;
  final String sessionId;
  final String model;
  final Map<String, dynamic> fallbackUsage;

  const ContextStatsSheet({
    super.key,
    required this.api,
    required this.store,
    required this.sessionId,
    required this.model,
    required this.fallbackUsage,
  });

  @override
  State<ContextStatsSheet> createState() => _ContextStatsSheetState();
}

class _ContextStatsSheetState extends State<ContextStatsSheet>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 3, vsync: this);
  ContextStatsSnapshot? _snapshot;
  bool _loading = false;
  String? _error;
  Timer? _refreshDebounce;
  int _request = 0;

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_onStoreChanged);
    widget.store.addChatListener(_onChatEvent);
    _load();
  }

  @override
  void dispose() {
    _refreshDebounce?.cancel();
    widget.store.removeListener(_onStoreChanged);
    widget.store.removeChatListener(_onChatEvent);
    _tabs.dispose();
    super.dispose();
  }

  void _onStoreChanged() {
    if (!mounted) return;
    if (widget.store.sessionId != widget.sessionId) {
      Navigator.of(context).maybePop();
    }
  }

  void _onChatEvent(ChatEvent event) {
    if (!mounted || event.sessionId != widget.sessionId) return;
    if (event.type != 'turn/end' &&
        event.type != 'assistant/message' &&
        event.type != 'session/context') {
      return;
    }
    // 数据变化只刷新当前 sheet；合并短时间内的多帧，避免每步都打端点。
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 700), () {
      if (mounted && !_loading) _load();
    });
  }

  Future<void> _load() async {
    final request = ++_request;
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      var snapshot = await widget.api.contextStats(widget.sessionId);
      // 端点存在但缺 pressure/tokenUsage（宿主投影被裁剪）：用现有 /usage 只补缺块，
      // breakdown/timing 仍按宿主实际投影显示，不伪造。
      if (snapshot.pressure == null || snapshot.tokenUsage == null) {
        try {
          final usage = await widget.api.usage(widget.sessionId);
          snapshot = snapshot.mergedWithLegacyUsage(usage);
        } catch (_) {
          // /usage 也失败时保留宿主投影，缺失 Tab 各自降级。
        }
      }
      if (!mounted || request != _request) return;
      setState(() {
        _snapshot = snapshot;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || request != _request) return;
      // 旧宿主（404/not-found）回退现有 /usage；其他失败保留已有快照并提示。
      if (_isUnsupported(e)) {
        await _loadLegacy(request);
        return;
      }
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  bool _isUnsupported(Object error) =>
      error is ApiException &&
      (error.status == 404 || error.code == 'not-found');

  Future<void> _loadLegacy(int request) async {
    Map<String, dynamic> usage = widget.fallbackUsage;
    try {
      usage = await widget.api.usage(widget.sessionId);
    } catch (_) {
      // 旧宿主连 /usage 都失败时仍用页面已有 usage（页面圆环可能已有数据），不伪造。
    }
    if (!mounted || request != _request) return;
    setState(() {
      _snapshot = ContextStatsSnapshot.fromLegacyUsage(usage);
      _loading = false;
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    final snapshot = _snapshot;
    return SafeArea(
      top: false,
      child: Column(
        children: [
          const SizedBox(height: 8),
          _handle(context),
          _header(context),
          if (_loading && snapshot == null)
            const Expanded(
              child: Center(
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else if (_error != null && snapshot == null)
            Expanded(child: _errorView(context))
          else
            Expanded(
              child: _body(context, snapshot ?? const ContextStatsSnapshot()),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
            child: Text(
              privacyNote(),
              style: TextStyle(fontSize: 11, color: ink3),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }

  Widget _handle(BuildContext context) => Center(
    child: Container(
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: DshColors.line(context),
        borderRadius: BorderRadius.circular(2),
      ),
    ),
  );

  Widget _header(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  L10n.t('上下文', 'Context'),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.model.isEmpty
                      ? L10n.t('当前会话', 'Current session')
                      : widget.model,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: ink3),
                ),
              ],
            ),
          ),
          IconButton(
            key: const ValueKey<String>('context-stats-refresh'),
            tooltip: L10n.t('刷新', 'Refresh'),
            onPressed: _loading ? null : _load,
            icon: Icon(Icons.refresh, size: 20, color: ink2),
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            padding: EdgeInsets.zero,
          ),
          IconButton(
            key: const ValueKey<String>('context-stats-close'),
            tooltip: L10n.t('关闭', 'Close'),
            onPressed: () => Navigator.of(context).maybePop(),
            icon: Icon(Icons.close, size: 20, color: ink3),
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            padding: EdgeInsets.zero,
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context, ContextStatsSnapshot snapshot) {
    final scale = MediaQuery.textScalerOf(context).scale(1.0);
    final scrollableTabs = scale >= 2.0;
    final ink3 = DshColors.ink3(context);
    return Column(
      children: [
        if (snapshot.legacyFallback || _error != null)
          _NoticeBar(
            text: snapshot.legacyFallback
                ? L10n.t(
                    '部分数据来自旧版 /usage 近似值；不可用的构成/统计会明确标注。',
                    'Some data comes from legacy /usage approximations; unavailable tabs are marked.',
                  )
                : L10n.t(
                    '刷新失败，显示的是上一次数据。',
                    'Refresh failed; showing the previous data.',
                  ),
          ),
        _SummaryCard(snapshot: snapshot),
        TabBar(
          controller: _tabs,
          isScrollable: scrollableTabs,
          tabAlignment: scrollableTabs ? TabAlignment.center : null,
          labelColor: DshColors.brand(context),
          unselectedLabelColor: ink3,
          indicatorColor: DshColors.brand(context),
          labelStyle: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
          unselectedLabelStyle: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
          ),
          tabs: [
            Tab(
              text: L10n.t('上下文构成', 'Composition'),
              key: const ValueKey<String>('context-stats-tab-composition'),
            ),
            Tab(
              text: L10n.t('Token 用量', 'Tokens'),
              key: const ValueKey<String>('context-stats-tab-tokens'),
            ),
            Tab(
              text: L10n.t('会话统计', 'Session'),
              key: const ValueKey<String>('context-stats-tab-stats'),
            ),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _CompositionTab(snapshot: snapshot),
              _TokenUsageTab(snapshot: snapshot),
              _SessionStatsTab(snapshot: snapshot),
            ],
          ),
        ),
      ],
    );
  }

  Widget _errorView(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
      children: [
        Icon(Icons.error_outline, size: 28, color: ink2),
        const SizedBox(height: 8),
        Text(
          L10n.t('上下文统计加载失败', 'Could not load context stats'),
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14, color: ink2),
        ),
        const SizedBox(height: 4),
        Text(
          _error ?? '',
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: ink3),
        ),
        const SizedBox(height: 8),
        Center(
          child: TextButton(
            key: const ValueKey<String>('context-stats-retry'),
            onPressed: _load,
            child: Text(L10n.t('重试', 'Retry')),
          ),
        ),
      ],
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final ContextStatsSnapshot snapshot;
  const _SummaryCard({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    final pressure = snapshot.pressure;
    final percent = pressure?.effectivePercent;
    final used = formatContextWindowUsed(pressure);
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final brand = DshColors.brand(context);
    final line = DshColors.line(context);
    final effective = percent ?? 0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                percent == null ? '--' : '$percent%',
                key: const ValueKey<String>('context-stats-percent'),
                style: TextStyle(
                  fontSize: 32,
                  height: 1.05,
                  fontWeight: FontWeight.w700,
                  color: ink2,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  percent == null
                      ? (used == null
                            ? L10n.t('等待首次用量', 'Waiting for first usage')
                            : L10n.t('占用锚点待首次请求', 'Waiting for first request'))
                      : L10n.t('上下文占用（估算）', 'Context usage (estimated)'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: ink3),
                ),
              ),
            ],
          ),
          if (used != null) ...[
            const SizedBox(height: 3),
            Text(used, style: TextStyle(fontSize: 11.5, color: ink3)),
          ],
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: percent == null ? 0 : effective.clamp(0, 100) / 100,
              minHeight: 7,
              backgroundColor: line,
              color: brand,
            ),
          ),
        ],
      ),
    );
  }
}

class _CompositionTab extends StatelessWidget {
  final ContextStatsSnapshot snapshot;
  const _CompositionTab({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    final pressure = snapshot.pressure;
    final breakdown = snapshot.breakdown;
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final window = pressure?.contextWindow;
    if (breakdown == null) {
      final unavailable = !snapshot.isEmpty;
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          _EmptyHint(
            icon: Icons.pie_chart_outline,
            title: unavailable
                ? L10n.t(
                    '当前电脑端未提供构成',
                    'Composition is not available on this host',
                  )
                : L10n.t(
                    '等待首次请求后生成构成估算',
                    'Composition appears after the first request',
                  ),
            note: unavailable
                ? (snapshot.legacyFallback
                      ? L10n.t(
                          '旧版宿主只提供上下文窗口与近似用量。',
                          'Older hosts only expose the window and approximate usage.',
                        )
                      : L10n.t(
                          '宿主未提供上下文构成投影。',
                          'The host provides no context composition projection.',
                        ))
                : L10n.t(
                    '完成第一次模型请求后才有启发式构成。',
                    'Heuristic composition appears after the first model request.',
                  ),
          ),
        ],
      );
    }
    final rows = <_BreakdownRowData>[
      _BreakdownRowData(
        L10n.t('系统提示', 'System'),
        breakdown.systemTokens,
        DshColors.brand(context),
      ),
      _BreakdownRowData(
        L10n.t('工具定义', 'Tools'),
        breakdown.toolsTokens,
        DshColors.warn(context),
      ),
      _BreakdownRowData(
        L10n.t('会话消息', 'Messages'),
        breakdown.messageTokens,
        DshColors.ok(context),
      ),
    ];
    return ListView(
      key: const ValueKey<String>('context-stats-composition-list'),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _BreakdownRow(data: row, window: window),
          ),
        Text(
          breakdownDisclaimer(),
          style: TextStyle(fontSize: 11.5, color: ink3, height: 1.4),
        ),
        if (pressure == null) ...[
          const SizedBox(height: 8),
          Text(
            L10n.t(
              '上下文占用锚点暂不可用，仅显示估算构成。',
              'Context pressure is unavailable; only estimates are shown.',
            ),
            style: TextStyle(fontSize: 11, color: ink2),
          ),
        ],
      ],
    );
  }
}

class _BreakdownRowData {
  final String label;
  final int tokens;
  final Color color;
  const _BreakdownRowData(this.label, this.tokens, this.color);
}

class _BreakdownRow extends StatelessWidget {
  final _BreakdownRowData data;
  final int? window;
  const _BreakdownRow({required this.data, this.window});

  @override
  Widget build(BuildContext context) {
    final ink = DshColors.ink(context);
    final ink3 = DshColors.ink3(context);
    final share = breakdownShareOfWindow(data.tokens, window);
    final percentText = share == null
        ? L10n.t('估算', 'estimate')
        : L10n.t(
            '占窗口 ${(share * 100).round()}%（分项估算）',
            '${(share * 100).round()}% of window (estimate)',
          );
    return Semantics(
      label:
          '${data.label}，约 ${fmtTokens(data.tokens)} tokens，$percentText，${L10n.t('分项估算，非总和', 'component estimate, not a total')}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: data.color,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  data.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: ink,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '~${fmtTokens(data.tokens)}',
                style: TextStyle(
                  fontSize: 12,
                  color: ink,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: share ?? 0,
              minHeight: 5,
              backgroundColor: DshColors.line(context),
              color: data.color,
            ),
          ),
          const SizedBox(height: 3),
          Text(percentText, style: TextStyle(fontSize: 10.5, color: ink3)),
        ],
      ),
    );
  }
}

class _TokenUsageTab extends StatelessWidget {
  final ContextStatsSnapshot snapshot;
  const _TokenUsageTab({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    final usage = snapshot.tokenUsage;
    final ink3 = DshColors.ink3(context);
    if (usage == null) {
      final unavailable = !snapshot.isEmpty;
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          _EmptyHint(
            icon: Icons.toll_outlined,
            title: unavailable
                ? L10n.t(
                    '当前电脑端未提供累计用量',
                    'Cumulative usage is not available on this host',
                  )
                : L10n.t('等待首次用量', 'Waiting for first usage'),
            note: unavailable
                ? L10n.t(
                    '宿主未提供 tokenUsage 投影。',
                    'The host provides no tokenUsage projection.',
                  )
                : L10n.t(
                    '本会话完成第一次模型请求后才有累计 Token。',
                    'Cumulative tokens appear after the first model request.',
                  ),
          ),
        ],
      );
    }
    final hit = usage.effectiveCacheHitRate;
    final rows = <({String label, int value})>[
      (label: L10n.t('未缓存输入', 'Uncached input'), value: usage.uncachedInput),
      (label: L10n.t('缓存读取', 'Cache read'), value: usage.cacheRead),
      (label: L10n.t('缓存写入', 'Cache write'), value: usage.cacheWrite),
      (
        label: L10n.t('输出（含 reasoning）', 'Output (incl. reasoning)'),
        value: usage.output,
      ),
    ];
    final total = usage.total;
    return ListView(
      key: const ValueKey<String>('context-stats-token-list'),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        Text(
          L10n.t(
            '本会话累计用量（不是当前上下文占用）',
            'Cumulative for this session (not current context usage)',
          ),
          style: TextStyle(fontSize: 11.5, color: ink3),
        ),
        const SizedBox(height: 10),
        for (final row in rows) ...[
          _MetricRow(
            label: row.label,
            value: fmtTokens(row.value),
            trailing: total > 0
                ? '${((row.value / total) * 100).round()}%'
                : null,
          ),
          if (total > 0) ...[
            const SizedBox(height: 3),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: (row.value / total).clamp(0.0, 1.0),
                minHeight: 4,
                backgroundColor: DshColors.line(context),
                color: DshColors.brand(context),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ],
        const Divider(height: 16),
        _MetricRow(
          label: L10n.t('缓存命中率', 'Cache hit rate'),
          value: hit == null ? '--' : '${(hit * 100).round()}%',
        ),
        _MetricRow(label: L10n.t('合计', 'Total'), value: fmtTokens(total)),
        if (snapshot.legacyFallback) ...[
          const SizedBox(height: 10),
          Text(
            L10n.t(
              '近似：来自旧版 /usage 的累计桶。',
              'Approximate: cumulative buckets from legacy /usage.',
            ),
            style: TextStyle(fontSize: 11, color: ink3),
          ),
        ],
      ],
    );
  }
}

class _SessionStatsTab extends StatelessWidget {
  final ContextStatsSnapshot snapshot;
  const _SessionStatsTab({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    final timing = snapshot.timing;
    final ink3 = DshColors.ink3(context);
    if (timing == null) {
      final unavailable = !snapshot.isEmpty;
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          _EmptyHint(
            icon: Icons.timer_outlined,
            title: unavailable
                ? L10n.t(
                    '当前电脑端未提供会话统计',
                    'Session stats are not available on this host',
                  )
                : L10n.t('等待首次用量', 'Waiting for first usage'),
            note: unavailable
                ? L10n.t(
                    '宿主未提供 turn/step/TTFT/TPS 投影。',
                    'The host provides no turn/step/TTFT/TPS projection.',
                  )
                : L10n.t(
                    '完成第一次请求后才有会话统计。',
                    'Session stats appear after the first request.',
                  ),
          ),
        ],
      );
    }
    return ListView(
      key: const ValueKey<String>('context-stats-session-list'),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        Text(
          L10n.t('整份会话累计，不是每轮数据', 'Whole-session totals, not per-turn figures'),
          style: TextStyle(fontSize: 11.5, color: ink3),
        ),
        const SizedBox(height: 10),
        _MetricRow(label: L10n.t('轮次', 'Turns'), value: '${timing.turns}'),
        _MetricRow(label: L10n.t('步数', 'Steps'), value: '${timing.steps}'),
        _MetricRow(
          label: L10n.t('模型用时', 'Model time'),
          value: formatStatsDuration(timing.llmMs),
        ),
        _MetricRow(
          label: L10n.t('工具用时', 'Tool time'),
          value: formatStatsDuration(timing.toolMs),
        ),
        _MetricRow(
          label: L10n.t('平均首 token', 'Avg TTFT'),
          value: formatAvgTtft(timing.avgTtftMs),
        ),
        _MetricRow(
          label: L10n.t('输出速度', 'Output speed'),
          value: formatTps(timing.tps),
        ),
      ],
    );
  }
}

class _MetricRow extends StatelessWidget {
  final String label;
  final String value;
  final String? trailing;
  const _MetricRow({required this.label, required this.value, this.trailing});

  @override
  Widget build(BuildContext context) {
    final ink = DshColors.ink(context);
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, color: ink),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: ink,
            ),
          ),
          if (trailing != null) ...[
            const SizedBox(width: 6),
            SizedBox(
              width: 42,
              child: Text(
                trailing!,
                textAlign: TextAlign.right,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 10.5, color: ink3),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? note;
  const _EmptyHint({required this.icon, required this.title, this.note});

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.only(top: 40),
      child: Column(
        children: [
          Icon(icon, size: 28, color: ink3),
          const SizedBox(height: 8),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
          if (note != null) ...[
            const SizedBox(height: 4),
            Text(
              note!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11.5, color: ink3, height: 1.4),
            ),
          ],
        ],
      ),
    );
  }
}

class _NoticeBar extends StatelessWidget {
  final String text;
  const _NoticeBar({required this.text});

  @override
  Widget build(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 2, 16, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: DshColors.brandSoft(context),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: DshColors.line(context)),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 11, color: ink2, height: 1.35),
      ),
    );
  }
}
