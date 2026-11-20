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
import '../store.dart';
import '../team_tasks.dart';
import '../theme.dart';
import '../toast.dart';
import 'chat_screen.dart';

/// 打开「代理」面板。仅主会话可调用；调用方需先在渲染层/分发层做 gating。
Future<void> showAgentPanel(
  BuildContext context, {
  required AppStore store,
  required String sessionId,
  required String title,
  Api? apiClient,
}) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => AgentPanelScreen(
        store: store,
        sessionId: sessionId,
        title: title,
        apiClient: apiClient,
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

  const AgentPanelScreen({
    super.key,
    required this.store,
    required this.sessionId,
    required this.title,
    this.apiClient,
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

  // #143：只读任务板（按页签懒加载；旧宿主 unsupported，团队未启用时显示引导）。
  TeamTaskBoard? _taskBoard;
  bool _tasksLoading = false;
  String? _tasksError;
  bool _tasksRequested = false;
  String? _expandedTaskId;

  Api get _api => widget.apiClient ?? api;

  @override
  void initState() {
    super.initState();
    _tabs.addListener(_onTabChanged);
    _load();
  }

  void _onTabChanged() {
    if (_tabs.index == 2) _loadTasks();
  }

  Future<void> _loadTasks({bool force = false}) async {
    if (_tasksLoading || (_tasksRequested && !force)) return;
    _tasksRequested = true;
    if (mounted) {
      setState(() {
        _tasksLoading = true;
        _tasksError = null;
      });
    }
    try {
      final board = await _api.teamTasks(widget.sessionId);
      if (!mounted) return;
      // 刷新失败但上一轮已有任务：保留旧任务并标“可能不是最新”，不让列表变空。
      final previous = _taskBoard;
      final next = board.failure != null &&
              board.tasks.isEmpty &&
              (previous?.tasks.isNotEmpty ?? false)
          ? TeamTaskBoard(
              supported: board.supported,
              enabled: board.enabled,
              tasks: previous!.tasks,
              failure: board.failure,
              unavailable: board.unavailable,
            )
          : board;
      setState(() {
        _taskBoard = next;
        _tasksLoading = false;
        if (board.tasks.every((task) => task.id != _expandedTaskId)) {
          _expandedTaskId = null;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _tasksError = '$e';
        _tasksLoading = false;
      });
    }
  }

  @override
  void dispose() {
    _tabs.removeListener(_onTabChanged);
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
            onPressed: () {
              _load();
              _loadTasks(force: true);
            },
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
          _buildTasksTab(),
          const _AgentPlaceholderTab(icon: Icons.forum_outlined),
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

/// #143 只读任务板页签。
Widget _buildTasksTab() {
  final board = _taskBoard;
  if (_tasksLoading && board == null) {
    return const Center(
      key: ValueKey('agent-tasks-loading'),
      child: SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    );
  }
  if (_tasksError != null && board == null) {
    return _TaskEmptyState(
      key: const ValueKey('agent-tasks-error'),
      icon: Icons.error_outline,
      title: L10n.t('任务板加载失败', 'Failed to load tasks'),
      detail: _tasksError!,
      action: TextButton(
        key: const ValueKey('agent-tasks-retry'),
        onPressed: () => _loadTasks(force: true),
        child: Text(L10n.t('重试', 'Retry')),
      ),
    );
  }
  if (board == null) {
    return const Center(
      key: ValueKey('agent-tasks-loading'),
      child: SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    );
  }
  if (!board.supported) {
    return _TaskEmptyState(
      key: const ValueKey('agent-tasks-unsupported'),
      icon: Icons.checklist_outlined,
      title: L10n.t('当前电脑端不支持共享任务板', 'Shared task board is not supported on this computer'),
      detail: L10n.t(
        '请把电脑端插件更新到包含任务板的版本。',
        'Update the computer-side plugin to a version with task boards.',
      ),
    );
  }
  if (!board.enabled) {
    return _TaskEmptyState(
      key: const ValueKey('agent-tasks-disabled'),
      icon: Icons.groups_outlined,
      title: L10n.t('任务板需要先启用团队协作', 'Enable agent teamwork first'),
      detail: L10n.t(
        '启用后，主代理在对话中创建的任务会在这里只读展示。',
        'After enabling, tasks created by the lead agent appear here read-only.',
      ),
      action: TextButton(
        key: const ValueKey('agent-tasks-goto-team'),
        onPressed: () => _tabs.animateTo(1),
        child: Text(L10n.t('前往团队', 'Go to Team')),
      ),
    );
  }

  final failure = board.failure;
  final tasks = board.tasks;
  final refreshError = _tasksError;
  final summary = _TaskSummary(tasks: tasks);
  if (tasks.isEmpty && failure == null && refreshError == null && !board.unavailable) {
    return _TaskEmptyState(
      key: const ValueKey('agent-tasks-empty'),
      icon: Icons.checklist_outlined,
      title: L10n.t('暂无共享任务', 'No shared tasks yet'),
      detail: L10n.t(
        '让主代理在对话中创建任务后会显示在这里。',
        'Tasks created by the lead agent in the conversation appear here.',
      ),
    );
  }
  if (tasks.isEmpty && board.unavailable) {
    return _TaskEmptyState(
      key: const ValueKey('agent-tasks-unavailable'),
      icon: Icons.hourglass_empty,
      title: L10n.t('任务板暂不可用', 'Task board is temporarily unavailable'),
      detail: L10n.t(
        '会话当前没有活动 agent；重新打开会话后再试。',
        'The session has no live agent right now. Reopen the session and retry.',
      ),
      action: TextButton(
        key: const ValueKey('agent-tasks-retry'),
        onPressed: () => _loadTasks(force: true),
        child: Text(L10n.t('重试', 'Retry')),
      ),
    );
  }
  return Column(
    key: const ValueKey('agent-tasks-board'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (refreshError != null)
        _TaskBoardNotice(
          key: const ValueKey('agent-tasks-stale'),
          message: L10n.t(
            '刷新失败，显示上次结果：$refreshError',
            'Refresh failed; showing the previous result: $refreshError',
          ),
        ),
      if (failure != null || board.unavailable)
        _TaskBoardNotice(
          key: const ValueKey('agent-tasks-degraded'),
          message: failure == null
              ? L10n.t('当前电脑端仅提供部分任务信息', 'Only partial task information is available')
              : L10n.t(
                  '任务记录无效：$failure',
                  'Invalid persisted task record: $failure',
                ),
        ),
      if (tasks.isNotEmpty) summary,
      Expanded(
        child: ListView.separated(
          padding: EdgeInsets.zero,
          itemCount: tasks.length,
          separatorBuilder: (_, _) => Divider(
            height: 1,
            thickness: 1,
            color: Theme.of(context).dividerColor.withValues(alpha: 0.5),
          ),
          itemBuilder: (_, index) {
            final task = tasks[index];
            return _TaskBoardRow(
              task: task,
              byId: {for (final item in tasks) item.id: item},
              expanded: _expandedTaskId == task.id,
              onTap: () => setState(
                () => _expandedTaskId = _expandedTaskId == task.id ? null : task.id,
              ),
            );
          },
        ),
      ),
    ],
  );
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

class _TaskSummary extends StatelessWidget {
  const _TaskSummary({required this.tasks});
  final List<TeamTask> tasks;

  @override
  Widget build(BuildContext context) {
    final completed = tasks.where((task) => task.status == TeamTaskStatus.completed).length;
    final active = tasks.where((task) => task.status == TeamTaskStatus.inProgress).length;
    final pending = tasks.where((task) => task.status == TeamTaskStatus.pending).length;
    final parts = <String>[
      if (completed > 0) L10n.t('$completed 已完成', '$completed completed'),
      if (active > 0) L10n.t('$active 进行中', '$active in progress'),
      if (pending > 0) L10n.t('$pending 待处理', '$pending pending'),
    ];
    if (parts.isEmpty) return const SizedBox.shrink();
    return Padding(
      key: const ValueKey('agent-tasks-summary'),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Text(
        parts.join(' · '),
        style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
      ),
    );
  }
}

class _TaskBoardNotice extends StatelessWidget {
  const _TaskBoardNotice({super.key, required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: DshColors.brandSoft(context),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(
        message,
        style: TextStyle(fontSize: 11.5, color: DshColors.ink2(context)),
      ),
    );
  }
}

class _TaskEmptyState extends StatelessWidget {
  const _TaskEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    final ink2 = DshColors.ink2(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 30, color: ink3),
            const SizedBox(height: 10),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: ink2),
            ),
            const SizedBox(height: 6),
            Text(
              detail,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, height: 1.5, color: ink3),
            ),
            if (action != null) ...[const SizedBox(height: 8), action!],
          ],
        ),
      ),
    );
  }
}

class _TaskBoardRow extends StatelessWidget {
  const _TaskBoardRow({
    required this.task,
    required this.byId,
    required this.expanded,
    required this.onTap,
  });

  final TeamTask task;
  final Map<String, TeamTask> byId;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final icon = switch (task.status) {
      TeamTaskStatus.pending => task.blocked ? Icons.block : Icons.radio_button_unchecked,
      TeamTaskStatus.inProgress => Icons.radio_button_checked,
      TeamTaskStatus.completed => Icons.check_circle,
    };
    final iconColor = task.blocked
        ? DshColors.warn(context)
        : switch (task.status) {
            TeamTaskStatus.pending => DshColors.ink3(context),
            TeamTaskStatus.inProgress => DshColors.brand(context),
            TeamTaskStatus.completed => DshColors.ok(context),
          };
    final statusLabel = switch (task.status) {
      TeamTaskStatus.pending => task.blocked
          ? L10n.t('被依赖阻塞', 'Blocked by dependencies')
          : L10n.t('待处理', 'Pending'),
      TeamTaskStatus.inProgress => L10n.t('进行中', 'In progress'),
      TeamTaskStatus.completed => L10n.t('已完成', 'Completed'),
    };
    final statusColor = task.blocked
        ? DshColors.ink2(context)
        : switch (task.status) {
            TeamTaskStatus.pending => DshColors.ink3(context),
            TeamTaskStatus.inProgress => DshColors.brand(context),
            TeamTaskStatus.completed => DshColors.ok(context),
          };
    final owner = task.ownerLabel.isEmpty
        ? L10n.t('未分配', 'Unowned')
        : task.ownerLabel;
    return Semantics(
      container: true,
      button: true,
      expanded: expanded,
      label: '${task.subject}，$statusLabel，${expanded ? L10n.t('已展开', 'Expanded') : L10n.t('已收起', 'Collapsed')}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: ValueKey('agent-task-${task.id}'),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 52),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                children: [
                  Icon(icon, size: 14, color: iconColor, semanticLabel: statusLabel),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      task.subject,
                      maxLines: expanded ? null : 2,
                      overflow: expanded ? null : TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, height: 1.3),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    statusLabel,
                    key: ValueKey('agent-task-status-${task.id}'),
                    maxLines: 1,
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: statusColor),
                  ),
                  const SizedBox(width: 2),
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: DshColors.ink3(context),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              key: ValueKey('agent-task-details-${task.id}'),
              padding: const EdgeInsets.fromLTRB(40, 0, 16, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _TaskDetailLine(
                    label: L10n.t('负责人：', 'Owner: '),
                    value: owner,
                    key: ValueKey('agent-task-owner-${task.id}'),
                  ),
                  const SizedBox(height: 4),
                  _TaskDetailLine(
                    label: L10n.t('依赖：', 'Dependencies: '),
                    value: _dependencyText(),
                    key: ValueKey('agent-task-deps-${task.id}'),
                  ),
                  const SizedBox(height: 4),
                  _TaskDetailLine(
                    label: L10n.t('状态：', 'Status: '),
                    value: statusLabel,
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _dependencyText() {
    if (task.blockedBy.isEmpty) return L10n.t('无', 'None');
    final shown = <String>[];
    for (final id in task.blockedBy.take(2)) {
      final blocker = byId[id];
      if (blocker != null) {
        shown.add(blocker.subject);
      } else {
        final short = id.length <= 8 ? id : id.substring(0, 8);
        shown.add(L10n.t('$short（已删除）', '$short (deleted)'));
      }
    }
    final rest = task.blockedBy.length - shown.length;
    if (rest > 0) shown.add(L10n.t('等 $rest 个', 'and $rest more'));
    return shown.join('、');
  }
}

class _TaskDetailLine extends StatelessWidget {
  const _TaskDetailLine({
    super.key,
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context))),
        Expanded(
          child: Text(
            value,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: DshColors.ink2(context)),
          ),
        ),
      ],
    );
  }
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
