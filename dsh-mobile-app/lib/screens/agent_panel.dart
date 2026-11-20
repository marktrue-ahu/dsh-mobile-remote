// issue #141：「代理」面板（四页签：子代理 / 团队 / 任务板 / 消息）。
//
// 设计依据：ADR 0032 + issue #115 规格（v2 更新：全屏页、四页签、树默认折叠）。
// 本次范围：#141 四页签壳 + 递归子代理树 + 入口/双重 gating + 降级；
// 团队/任务板/消息为说明性占位（#142/#143/#144 接续）。
//
// 数据契约来自 #140：
// - 每行 `name?` / `depth?` / `parentSessionId`；
// - `multiLevelUnavailable` 为真时不得渲染展开胶囊（拿不到真实层级就不假称有下级）；
// - `catalogDegraded` 表示目录不完整（提示但不假装完整）。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../agent_tree.dart';
import '../api.dart';
import '../fmt.dart';
import '../l10n.dart';
import '../message_index.dart';
import '../store.dart';
import '../theme.dart';
import '../toast.dart';
import '../widgets/message_index_tab.dart';
import 'chat_screen.dart';

/// 打开「代理」面板。仅主会话可调用；调用方需先在渲染层/分发层做 gating。
Future<void> showAgentPanel(
  BuildContext context, {
  required AppStore store,
  required String sessionId,
  required String title,
  Api? apiClient,
  MessageIndexLoader? messageIndexLoader,
  MessageOpenHandler? onOpenMessage,
}) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => AgentPanelScreen(
        store: store,
        sessionId: sessionId,
        title: title,
        apiClient: apiClient,
        messageIndexLoader: messageIndexLoader,
        onOpenMessage: onOpenMessage,
      ),
    ),
  );
}

/// issue #141：只有主会话可打开代理面板（子代理不治理子代理）。
bool canOpenAgentPanel(AppStore store, String? sessionId) =>
    !store.isSubagentSession(sessionId);

class AgentPanelScreen extends StatefulWidget {
  final AppStore store;
  final String sessionId;
  final String title;
  final Api? apiClient;

  /// issue #144：当前会话消息索引（由 ChatScreen 从已加载时间线派生）。
  final MessageIndexLoader? messageIndexLoader;
  final MessageOpenHandler? onOpenMessage;

  const AgentPanelScreen({
    super.key,
    required this.store,
    required this.sessionId,
    required this.title,
    this.apiClient,
    this.messageIndexLoader,
    this.onOpenMessage,
  });

  @override
  State<AgentPanelScreen> createState() => _AgentPanelScreenState();
}

class _AgentPanelScreenState extends State<AgentPanelScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 4, vsync: this);
  SubagentCatalog? _catalog;
  String? _error;
  bool _loading = false;
  final Set<String> _expanded = <String>{};
  final Set<String> _interruptBusy = <String>{};

  Api get _api => widget.apiClient ?? api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final catalog = await _api.subagentCatalog(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _catalog = catalog;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _interrupt(AgentNode node) async {
    if (_interruptBusy.contains(node.id)) return;
    setState(() => _interruptBusy.add(node.id));
    try {
      await _api.subagentInterrupt(widget.sessionId, node.id);
      if (mounted) {
        showToast(context, L10n.t('已请求中断子代理', 'Interrupt requested'));
      }
    } catch (e) {
      if (mounted) {
        showToast(context, '${L10n.t('中断失败：', 'Interrupt failed: ')}$e');
      }
    } finally {
      if (mounted) setState(() => _interruptBusy.remove(node.id));
    }
  }

  void _toggle(AgentNode node) {
    if (_catalog?.multiLevelUnavailable == true) return;
    setState(() {
      if (!_expanded.remove(node.id)) _expanded.add(node.id);
    });
  }

  Future<void> _openChild(AgentNode node) async {
    if (node.isDiagnostic) return;
    await openChat(
      context,
      widget.store,
      node.id,
      apiClient: widget.apiClient,
      onReturn: () async {
        await widget.store.setSession(widget.sessionId);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final factor = MediaQuery.textScalerOf(context).scale(1.0);
    final width = MediaQuery.sizeOf(context).width;
    // v2 设计：320pt × 2.0× 用 13.0，其余 13.5；≥2.3× 退化为可滚动页签。
    final compactTabs = width <= 340 && factor >= 1.9;
    final scrollableTabs = factor >= 2.25;
    final tabFontSize = compactTabs ? 13.0 : 13.5;
    final ink3 = DshColors.ink3(context);
    final brand = DshColors.brand(context);
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, size: 20),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        toolbarHeight: 56 + 18 * (factor - 1).clamp(0, 1),
        titleSpacing: 0,
        title: Row(
          children: [
            Icon(Icons.groups_outlined, size: 20, color: brand),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    L10n.t('代理', 'Agents'),
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    widget.title,
                    key: const ValueKey<String>('agent-panel-session-title'),
                    style: TextStyle(fontSize: 11.5, color: ink3),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: L10n.t('刷新', 'Refresh'),
            onPressed: _load,
          ),
        ],
        bottom: TabBar(
          controller: _tabs,
          isScrollable: scrollableTabs,
          tabAlignment: scrollableTabs ? TabAlignment.center : null,
          labelPadding: scrollableTabs ? null : EdgeInsets.zero,
          labelStyle: TextStyle(
            fontSize: tabFontSize,
            fontWeight: FontWeight.w600,
            letterSpacing: 0,
          ),
          unselectedLabelStyle: TextStyle(
            fontSize: tabFontSize,
            letterSpacing: 0,
            color: ink3,
          ),
          labelColor: brand,
          unselectedLabelColor: ink3,
          indicatorColor: brand,
          tabs: [
            Tab(
              text: L10n.t('子代理', 'Subagents'),
              key: const ValueKey('agent-tab-subagents'),
            ),
            Tab(
              text: L10n.t('团队', 'Team'),
              key: const ValueKey('agent-tab-team'),
            ),
            Tab(
              text: L10n.t('任务板', 'Tasks'),
              key: const ValueKey('agent-tab-tasks'),
            ),
            Tab(
              text: L10n.t('消息', 'Messages'),
              key: const ValueKey('agent-tab-messages'),
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _buildSubagentsTab(),
          const _AgentPlaceholderTab(icon: Icons.people_outline),
          const _AgentPlaceholderTab(icon: Icons.checklist_outlined),
          MessageIndexTab(
            loader: widget.messageIndexLoader,
            onOpenMessage: widget.onOpenMessage,
          ),
        ],
      ),
    );
  }

  Widget _buildSubagentsTab() {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final danger = DshColors.danger(context);
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${L10n.t('加载失败：', 'Failed to load: ')}$_error',
                key: const ValueKey('agent-panel-error'),
                style: TextStyle(fontSize: 13, color: ink2),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              TextButton(onPressed: _load, child: Text(L10n.t('重试', 'Retry'))),
            ],
          ),
        ),
      );
    }
    final catalog = _catalog ?? SubagentCatalog.empty;
    final rows = catalog.rows;
    final roots = buildAgentTree(rows, rootSessionId: widget.sessionId);
    final flatAll = _flattenAll(roots);
    final degraded = catalog.multiLevelUnavailable;
    final visible = degraded ? flatAll : _flattenVisible(roots, _expanded);
    return Column(
      children: [
        if (degraded)
          _AgentNotice(
            key: const ValueKey('agent-panel-degraded'),
            icon: Icons.account_tree_outlined,
            text: L10n.t(
              '当前宿主仅提供直接子代理（无法展示多层树）',
              'This host only lists direct subagents (no multi-level tree)',
            ),
          )
        else if (catalog.catalogDegraded)
          _AgentNotice(
            key: const ValueKey('agent-panel-catalog-degraded'),
            icon: Icons.info_outline,
            text: L10n.t(
              '目录不完整，列表可能缺少已释放的子代理',
              'Catalog is incomplete; released subagents may be missing',
            ),
          ),
        Expanded(
          child: visible.isEmpty
              ? Center(
                  child: Text(
                    L10n.t('暂无子代理', 'No subagents'),
                    key: const ValueKey('agent-panel-empty'),
                    style: TextStyle(fontSize: 13, color: ink3),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  itemCount: visible.length,
                  itemBuilder: (context, index) {
                    final entry = visible[index];
                    final node = entry.node;
                    return _AgentTreeRow(
                      key: ValueKey<String>('agent-row-${node.id}'),
                      node: node,
                      level: degraded ? 1 : entry.level,
                      expanded: _expanded.contains(node.id),
                      degraded: degraded,
                      interrupting: _interruptBusy.contains(node.id),
                      onToggle: () => _toggle(node),
                      onOpen: () => _openChild(node),
                      onInterrupt: () => _interrupt(node),
                      danger: danger,
                    );
                  },
                ),
        ),
      ],
    );
  }

  List<_VisibleAgent> _flattenVisible(
    List<AgentNode> roots,
    Set<String> expanded,
  ) {
    final out = <_VisibleAgent>[];
    void walk(List<AgentNode> nodes, int level) {
      for (final node in nodes) {
        out.add(_VisibleAgent(node, level));
        if (expanded.contains(node.id) && node.children.isNotEmpty) {
          walk(node.children, level + 1);
        }
      }
    }

    walk(roots, 1);
    return out;
  }

  List<_VisibleAgent> _flattenAll(List<AgentNode> roots) {
    final out = <_VisibleAgent>[];
    void walk(List<AgentNode> nodes, int level) {
      for (final node in nodes) {
        out.add(_VisibleAgent(node, level));
        if (node.children.isNotEmpty) walk(node.children, level + 1);
      }
    }

    walk(roots, 1);
    return out;
  }
}

class _VisibleAgent {
  final AgentNode node;
  final int level;
  const _VisibleAgent(this.node, this.level);
}

class _AgentNotice extends StatelessWidget {
  final IconData icon;
  final String text;
  const _AgentNotice({super.key, required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final surface = DshColors.surface(context);
    final line = DshColors.line(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: surface,
        border: Border.all(color: line),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        children: [
          Icon(icon, size: 15, color: ink2),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 11.5, color: ink2)),
          ),
        ],
      ),
    );
  }
}

class _AgentTreeRow extends StatelessWidget {
  final AgentNode node;
  final int level;
  final bool expanded;
  final bool degraded;
  final bool interrupting;
  final VoidCallback onToggle;
  final VoidCallback onOpen;
  final VoidCallback onInterrupt;
  final Color danger;

  const _AgentTreeRow({
    super.key,
    required this.node,
    required this.level,
    required this.expanded,
    required this.degraded,
    required this.interrupting,
    required this.onToggle,
    required this.onOpen,
    required this.onInterrupt,
    required this.danger,
  });

  @override
  Widget build(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final brand = DshColors.brand(context);
    final rail = DshColors.ink2(context).withValues(alpha: 0.78);
    final cappedLevel = math.min(level, 3);
    final indent = (cappedLevel - 1) * 14.0;
    final released = !node.isRunning && !node.isDiagnostic;
    // 行高随字号自适应：1.5x/2.0x 下两行副文本不溢出（设计：不回归行高）。
    final factor = MediaQuery.textScalerOf(context).scale(1.0);
    final rowHeight = 54 + 20 * (factor - 1).clamp(0.0, 1.2);
    return Semantics(
      button: !node.isDiagnostic,
      label: node.isDiagnostic
          ? _diagnosticText(node.status)
          : '${node.title}，${_rowAgentName(node)}',
      child: InkWell(
        onTap: node.isDiagnostic ? null : onOpen,
        child: SizedBox(
          height: rowHeight,
          child: Row(
            children: [
              SizedBox(
                width: indent + 4,
                height: double.infinity,
                child: CustomPaint(
                  painter: _TreeRailPainter(
                    levels: cappedLevel - 1,
                    color: rail,
                  ),
                ),
              ),
              if (!degraded && node.children.isNotEmpty)
                Semantics(
                  button: true,
                  label: expanded
                      ? L10n.t(
                          '收起 ${node.children.length} 个子代理',
                          'Collapse ${node.children.length} subagents',
                        )
                      : L10n.t(
                          '展开 ${node.children.length} 个子代理',
                          'Expand ${node.children.length} subagents',
                        ),
                  child: InkWell(
                    onTap: onToggle,
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 2),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          CustomPaint(
                            size: const Size(12, 12),
                            painter: _AgentTrianglePainter(
                              expanded: expanded,
                              color: ink2,
                            ),
                          ),
                          Container(
                            key: ValueKey<String>('agent-count-${node.id}'),
                            margin: const EdgeInsets.only(left: 4),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color: DshColors.brandSoft(context),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              '${node.children.length}',
                              style: TextStyle(
                                fontSize: 10.5,
                                fontWeight: FontWeight.w600,
                                color: brand,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                )
              else
                const SizedBox(width: 20),
              const SizedBox(width: 4),
              Icon(
                Icons.polyline_outlined,
                size: 17,
                color: released ? ink3 : brand,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      node.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: node.isDiagnostic ? ink3 : null,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        node.isDiagnostic
                            ? _diagnosticText(node.status)
                            : _subtitleAgentName(node),
                        if (node.createdAt != null) relTime(node.createdAt!),
                      ].join(' · '),
                      key: ValueKey<String>('agent-subtitle-${node.id}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: ink3),
                    ),
                  ],
                ),
              ),
              if (node.isRunning)
                IconButton(
                  onPressed: interrupting ? null : onInterrupt,
                  tooltip: L10n.t('中断子代理', 'Interrupt subagent'),
                  icon: Icon(
                    Icons.stop_circle_outlined,
                    size: 19,
                    color: interrupting ? ink3 : danger,
                  ),
                ),
              const SizedBox(width: 4),
            ],
          ),
        ),
      ),
    );
  }

  /// 副行代理名：有 name 用 name；旧插件无 name 回退 id（标题已在主行，不重复）。
  String _subtitleAgentName(AgentNode node) {
    final name = node.name?.trim();
    return name != null && name.isNotEmpty ? name : node.id;
  }

  String _rowAgentName(AgentNode node) => _subtitleAgentName(node);

  String _diagnosticText(String status) => switch (status) {
    'corrupt' => L10n.t('目录数据损坏', 'Corrupt catalog'),
    'unavailable' => L10n.t('目录不可用', 'Catalog unavailable'),
    _ => L10n.t('不受支持的子代理', 'Unsupported subagent'),
  };
}

class _TreeRailPainter extends CustomPainter {
  final int levels;
  final Color color;
  const _TreeRailPainter({required this.levels, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (var i = 0; i < levels; i++) {
      final x = 7.0 + i * 14.0;
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _TreeRailPainter old) =>
      old.levels != levels || old.color != color;
}

class _AgentTrianglePainter extends CustomPainter {
  final bool expanded;
  final Color color;
  const _AgentTrianglePainter({required this.expanded, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final path = Path();
    if (expanded) {
      path
        ..moveTo(2, 3.5)
        ..lineTo(size.width - 2, 3.5)
        ..lineTo(size.width / 2, size.height - 3)
        ..close();
    } else {
      path
        ..moveTo(3.5, 2)
        ..lineTo(3.5, size.height - 2)
        ..lineTo(size.width - 3, size.height / 2)
        ..close();
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _AgentTrianglePainter old) =>
      old.expanded != expanded || old.color != color;
}

/// 团队/任务板/消息的说明性占位（#142/#143/#144 接续）。
class _AgentPlaceholderTab extends StatelessWidget {
  final IconData icon;
  const _AgentPlaceholderTab({required this.icon});

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 30, color: ink3),
            const SizedBox(height: 10),
            Text(
              L10n.t('将在后续版本并入本面板', 'Coming to this panel in a later version'),
              style: TextStyle(fontSize: 13, color: ink3),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
