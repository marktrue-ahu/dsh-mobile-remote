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
import '../team.dart';
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
  final ValueNotifier<int> _refreshTick = ValueNotifier<int>(0);

  Api get _api => widget.apiClient ?? api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _refreshTick.dispose();
    _tabs.dispose();
    super.dispose();
  }

  void _refreshAll() {
    _load();
    _refreshTick.value++;
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
            onPressed: _refreshAll,
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
          _TeamTab(
            store: widget.store,
            sessionId: widget.sessionId,
            apiClient: widget.apiClient,
            refresh: _refreshTick,
          ),
          const _AgentPlaceholderTab(icon: Icons.checklist_outlined),
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

/// issue #142：「团队」页签——只读摘要 + 团队开关。
class _TeamTab extends StatefulWidget {
  final AppStore store;
  final String sessionId;
  final Api? apiClient;
  final ValueNotifier<int> refresh;

  const _TeamTab({
    required this.store,
    required this.sessionId,
    required this.apiClient,
    required this.refresh,
  });

  @override
  State<_TeamTab> createState() => _TeamTabState();
}

class _TeamTabState extends State<_TeamTab> {
  TeamStatus? _status;
  String? _error;
  bool _loading = false;
  bool _saving = false;
  String? _saveError;
  // #142 复审 P2：请求代次——旧 GET 不得覆盖 save 后的权威状态。
  int _requestGen = 0;

  Api get _api => widget.apiClient ?? api;

  @override
  void initState() {
    super.initState();
    widget.refresh.addListener(_onRefresh);
    _load();
  }

  @override
  void dispose() {
    widget.refresh.removeListener(_onRefresh);
    super.dispose();
  }

  void _onRefresh() {
    if (mounted) _load();
  }

  Future<void> _load() async {
    if (!mounted || _saving) return;
    final gen = ++_requestGen;
    setState(() {
      _loading = _status == null;
      _error = null;
    });
    try {
      final status = await _api.team(widget.sessionId);
      if (!mounted || gen != _requestGen) return;
      setState(() {
        _status = status;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || gen != _requestGen) return;
      // #142 复审 P2：旧插件没有路由时是 404 not-found，不等于加载失败；
      // 只有明确的 session-not-found 才是会话错误。
      if (e is ApiException && e.status == 404) {
        if (e.code == 'session-not-found') {
          setState(() {
            _error = L10n.t('会话不存在', 'Session not found');
            _loading = false;
          });
          return;
        }
        setState(() {
          _status = TeamStatus.unsupported(widget.sessionId);
          _loading = false;
        });
        return;
      }
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _onToggle(bool value) async {
    if (value == false) {
      final confirmed = await _confirmDisable();
      if (confirmed != true || !mounted) return;
    }
    await _save(value);
  }

  Future<void> _save(bool value) async {
    final gen = ++_requestGen; // 作废在途 GET，避免旧状态覆盖保存结果
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      await _api.setTeamMode(widget.sessionId, value);
      if (!mounted || gen != _requestGen) return;
      // 不信任 POST 响应的镜像：完成后发权威 GET 再更新 UI。
      final status = await _api.team(widget.sessionId);
      if (!mounted || gen != _requestGen) return;
      setState(() => _status = status);
    } catch (e) {
      if (!mounted || gen != _requestGen) return;
      setState(() => _saveError = '$e');
      showToast(
        context,
        L10n.t(
          '无法确认智能体团队协作设置已保存，请重试：$e',
          'Could not confirm the agent teamwork setting was saved. Try again: $e',
        ),
      );
    } finally {
      if (mounted && gen == _requestGen) {
        setState(() => _saving = false);
      }
    }
  }

  Future<bool?> _confirmDisable() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(L10n.t('确认停用智能体团队协作？', 'Disable agent teamwork?')),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                L10n.t(
                  '对话过程中停用智能体团队协作，将停止共享任务工具和团队协调指令。',
                  'Disabling agent teamwork during a conversation stops the use of shared task tools and team coordination instructions.',
                ),
              ),
              const SizedBox(height: 12),
              Text(
                L10n.t(
                  '停用后可能影响缓存复用、增加后续 token 用量与开销，并影响当前任务的协作效果。',
                  'Disabling it may affect cache reuse, increase subsequent token usage and costs, and affect collaboration on the current task.',
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: _saving ? null : () => Navigator.of(ctx).pop(false),
            child: Text(L10n.t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: _saving ? null : () => Navigator.of(ctx).pop(true),
            child: Text(L10n.t('确认停用', 'Disable')),
          ),
        ],
      ),
    );
  }

  String? _unavailableReason(TeamStatus status) {
    if (!status.root) {
      return L10n.t(
        '子代理会话继承根会话的团队设置，不能单独修改',
        'Subagent sessions inherit the root session team setting',
      );
    }
    if (!status.supported) {
      return L10n.t(
        '当前电脑端不支持团队协作，已隐藏相关操作',
        'This desktop does not support agent teamwork; related actions are hidden',
      );
    }
    if (!status.lockedKnown) {
      return L10n.t(
        '当前电脑端未提供团队锁状态',
        'This desktop does not provide the team lock state',
      );
    }
    if (status.locked) {
      return L10n.t(
        '当前会话已锁定，无法修改团队协作',
        'This session is locked; agent teamwork cannot be changed',
      );
    }
    if (!status.agentLive) {
      return L10n.t('未连接电脑端', 'Not connected to the desktop');
    }
    if (status.pending) {
      return L10n.t('正在应用团队设置，请稍候', 'Applying team settings, please wait');
    }
    if (!status.modelSelected) {
      return L10n.t(
        '请先在对话页选择模型和推理等级',
        'Choose a model and reasoning effort in the chat first',
      );
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final danger = DshColors.danger(context);
    if (_status == null) {
      if (_loading) {
        return const Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        );
      }
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${L10n.t('加载失败：', 'Failed to load: ')}$_error',
                key: const ValueKey('agent-team-error'),
                style: TextStyle(fontSize: 12.5, color: ink2),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              TextButton(onPressed: _load, child: Text(L10n.t('重试', 'Retry'))),
            ],
          ),
        ),
      );
    }
    final status = _status!;
    final reason = _unavailableReason(status);
    final canToggle = status.canToggle && !_saving;
    final normalMembers = status.normalMembers;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          _teamSwitchCard(
            context,
            status: status,
            reason: reason,
            canToggle: canToggle,
            ink2: ink2,
            ink3: ink3,
            danger: danger,
          ),
          if (status.supported && status.modeKnown && status.enabled) ...[
            const SizedBox(height: 14),
            _teamLeadRow(context, status, ink2, ink3),
            if (status.membersAvailable || status.tasksAvailable)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  _summaryText(status),
                  key: const ValueKey('agent-team-summary'),
                  style: TextStyle(fontSize: 11.5, color: ink3),
                ),
              ),
            const SizedBox(height: 14),
            Row(
              children: [
                Text(
                  L10n.t('团队成员', 'Team members'),
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: ink2,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  '${normalMembers.length}',
                  style: TextStyle(fontSize: 12, color: ink3),
                ),
              ],
            ),
            const SizedBox(height: 2),
            if (!status.membersAvailable)
              _teamEmptyNote(
                context,
                L10n.t(
                  '当前电脑端未提供成员目录',
                  'This desktop does not provide a member catalog',
                ),
              )
            else if (normalMembers.isEmpty)
              _teamEmptyNote(
                context,
                L10n.t(
                  '暂无团队成员；通过对话派生子代理后会显示在这里',
                  'No team members yet; subagents delegated in the chat will appear here',
                ),
              )
            else
              for (var i = 0; i < normalMembers.length; i++) ...[
                if (i > 0) Divider(height: 1, color: DshColors.line(context)),
                _teamMemberRow(context, normalMembers[i]),
              ],
          ] else if (status.supported && status.modeKnown && !status.enabled)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                L10n.t(
                  '团队协作未启用；启用后可在这里查看 Lead 与成员。',
                  'Agent teamwork is off; enable it to see the Lead and members here.',
                ),
                key: const ValueKey('agent-team-off-note'),
                style: TextStyle(fontSize: 12.5, color: ink3),
              ),
            )
          else if (status.supported && !status.modeKnown)
            _teamEmptyNote(
              context,
              L10n.t(
                '当前会话未激活，暂无法读取团队状态',
                'This session is not live; team status is unavailable',
              ),
            ),
        ],
      ),
    );
  }

  String _summaryText(TeamStatus status) {
    final parts = <String>[];
    if (status.membersAvailable) {
      parts.add(
        L10n.t(
          '${status.normalMembers.length} 名成员',
          '${status.normalMembers.length} member${status.normalMembers.length == 1 ? '' : 's'}',
        ),
      );
    }
    if (status.tasksAvailable) {
      parts.add(
        L10n.t(
          '${status.tasks.total} 个共享任务',
          '${status.tasks.total} shared task${status.tasks.total == 1 ? '' : 's'}',
        ),
      );
    }
    return parts.join(' · ');
  }

  Widget _teamSwitchCard(
    BuildContext context, {
    required TeamStatus status,
    required String? reason,
    required bool canToggle,
    required Color ink2,
    required Color ink3,
    required Color danger,
  }) {
    final surface = DshColors.surface(context);
    final line = DshColors.line(context);
    return Container(
      key: const ValueKey('agent-team-switch-card'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: surface,
        border: Border.all(color: line),
        borderRadius: BorderRadius.circular(DshTheme.radiusMd),
        boxShadow: Theme.of(context).brightness == Brightness.dark
            ? DshTheme.shadowDark
            : DshTheme.shadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    L10n.t('智能体团队协作', 'Agent teamwork'),
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (_saving)
                  const Padding(
                    padding: EdgeInsets.only(right: 10),
                    child: SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                // 旧宿主/非根会话：写操作不适用 → 不渲染开关（只显示原因）；
                // locked/pending/模型未定/断线仍显示开关但置灰，原因可见。
                if (status.supported && status.root)
                  Semantics(
                    label: L10n.t('智能体团队协作', 'Agent teamwork'),
                    toggled: status.enabled,
                    enabled: canToggle,
                    child: ExcludeSemantics(
                      child: IgnorePointer(
                        ignoring: !canToggle,
                        child: Opacity(
                          opacity: canToggle ? 1 : 0.55,
                          child: DshSwitch(
                            value: status.enabled,
                            onChanged: canToggle ? _onToggle : (_) {},
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          Text(
            L10n.t(
              '启用后可通过共享任务板协调多个智能体，token 开销相应更高',
              'Coordinate multiple agents through a shared task board; token costs are higher',
            ),
            style: TextStyle(fontSize: 11.5, color: ink3),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          if (_saving)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                L10n.t('正在保存…', 'Saving…'),
                key: const ValueKey('agent-team-saving'),
                style: TextStyle(fontSize: 12, color: ink2),
              ),
            ),
          if (reason != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, size: 12, color: ink2),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      reason,
                      key: const ValueKey('agent-team-reason'),
                      style: TextStyle(fontSize: 12, color: ink2),
                    ),
                  ),
                ],
              ),
            ),
          if (_saveError != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                L10n.t(
                  '无法确认智能体团队协作设置已保存，请重试：$_saveError',
                  'Could not confirm the agent teamwork setting was saved. Try again: $_saveError',
                ),
                key: const ValueKey('agent-team-save-error'),
                style: TextStyle(fontSize: 12, color: danger),
              ),
            ),
        ],
      ),
    );
  }

  Widget _teamLeadRow(
    BuildContext context,
    TeamStatus status,
    Color ink2,
    Color ink3,
  ) {
    final ok = DshColors.ok(context);
    final running = status.leadStatus == 'running';
    return Row(
      children: [
        Icon(
          running ? Icons.bolt_outlined : Icons.person_outline,
          size: 18,
          color: running ? ok : ink2,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'Lead · ${status.leadTitle}',
            key: const ValueKey('agent-team-lead'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
        ),
        Text(
          running ? L10n.t('运行中', 'Running') : L10n.t('空闲', 'Idle'),
          key: const ValueKey('agent-team-lead-status'),
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: running ? ok : ink3,
          ),
        ),
      ],
    );
  }

  Widget _teamMemberRow(BuildContext context, TeamMember member) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final ok = DshColors.ok(context);
    final running = member.isRunning;
    final unavailable = member.isDiagnostic;
    final statusText = unavailable
        ? L10n.t('不可用', 'Unavailable')
        : (running ? L10n.t('运行中', 'Running') : L10n.t('空闲', 'Idle'));
    final subtitle = member.name != null && member.name!.isNotEmpty
        ? member.name!
        : (member.title != null && member.title!.isNotEmpty
              ? member.title!
              : member.id);
    final factor = MediaQuery.textScalerOf(context).scale(1.0);
    return SizedBox(
      key: ValueKey('agent-team-member-${member.id}'),
      height: 52 + 16 * (factor - 1).clamp(0.0, 1.0),
      child: Row(
        children: [
          Icon(
            unavailable ? Icons.error_outline : Icons.polyline_outlined,
            size: 20,
            color: running ? ok : ink3,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  member.title ?? member.name ?? member.id,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: unavailable ? ink3 : ink2,
                  ),
                ),
                Text(
                  subtitle == member.id
                      ? member.id
                      : '$subtitle · ${member.id}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: ink3),
                ),
              ],
            ),
          ),
          Text(
            statusText,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
              color: running ? ok : ink3,
            ),
          ),
        ],
      ),
    );
  }

  Widget _teamEmptyNote(BuildContext context, String text) {
    final ink3 = DshColors.ink3(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(text, style: TextStyle(fontSize: 12.5, color: ink3)),
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
