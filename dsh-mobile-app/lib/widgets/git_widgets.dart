import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api.dart';
import '../git_models.dart';
import '../git_graph_logic.dart' as graph_logic;
import '../store.dart';
import '../theme.dart';
import 'git_write_widgets.dart';

void _showGitSheet(BuildContext context, WidgetBuilder builder) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: DshColors.surface(context),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(DshTheme.radiusLg),
      ),
    ),
    builder: builder,
  );
}

class _GitSheetHeader extends StatelessWidget {
  final String title;

  const _GitSheetHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 8),
      child: Column(
        children: [
          Center(
            child: Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: DshColors.line(context),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}

class GitQuickbar extends StatelessWidget {
  final AppStore store;

  const GitQuickbar({super.key, required this.store});

  @override
  Widget build(BuildContext context) {
    if (!store.gitCapability.available ||
        !store.gitCapability.read ||
        store.gitContext == null) {
      return const SizedBox.shrink();
    }
    return SizedBox(
      height: 44,
      child: Row(
        children: [
          for (final slot in store.gitQuickbar)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 3),
                child: OutlinedButton.icon(
                  onPressed: () => _open(context, slot),
                  icon: Icon(_icon(slot), size: 16),
                  label: Text(_label(slot), overflow: TextOverflow.ellipsis),
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _label(String slot) {
    if (slot == 'current-branch') return store.gitStatus?.branch ?? '分支';
    if (slot == 'sync-status') {
      final s = store.gitStatus;
      if (s == null) return '同步';
      final parts = <String>[];
      if (s.ahead > 0) parts.add('↑${s.ahead}');
      if (s.behind > 0) parts.add('↓${s.behind}');
      if ((s.counts['total'] as num? ?? 0) > 0) parts.add('有改动');
      return parts.isEmpty ? '已同步' : parts.join(' ');
    }
    return gitSlotTitle(slot);
  }

  IconData _icon(String slot) =>
      const {
        'current-branch': Icons.account_tree,
        'graph': Icons.hub,
        'sync-status': Icons.sync,
        'status': Icons.description,
        'diff': Icons.compare,
      }[slot] ??
      Icons.code;

  void _open(BuildContext context, String slot) {
    if (slot == 'current-branch') {
      _showGitSheet(context, (_) => GitBranchWriteSheet(store: store));
    } else if (slot == 'graph') {
      _showGitSheet(context, (_) => _GraphSheet(store: store));
    } else if (slot == 'sync-status' && store.gitCapability.writes) {
      _showGitSheet(context, (_) => GitSyncSheet(store: store));
    } else if ((slot == 'diff' || slot == 'status') &&
        store.gitCapability.writes) {
      _showGitSheet(
        context,
        (_) => GitStatusWriteSheet(store: store, showDiff: slot == 'diff'),
      );
    } else if (slot == 'diff' || slot == 'status' || slot == 'sync-status') {
      _showGitSheet(
        context,
        (_) => _StatusSheet(store: store, showDiff: slot == 'diff'),
      );
    }
  }
}

class _StatusSheet extends StatefulWidget {
  final AppStore store;
  final bool showDiff;

  const _StatusSheet({required this.store, required this.showDiff});

  @override
  State<_StatusSheet> createState() => _StatusSheetState();
}

class _StatusSheetState extends State<_StatusSheet> {
  GitDiff? diff;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!widget.showDiff || widget.store.gitContext == null) return;
    try {
      final value = await api.gitDiff(widget.store.gitContext!.repositoryId);
      if (mounted) setState(() => diff = value);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.showDiff ? '差异' : '工作区状态';
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.56,
        child: Column(
          children: [
            _GitSheetHeader(title: title),
            Expanded(
              child: widget.showDiff
                  ? _diffBody(context)
                  : _statusBody(context),
            ),
          ],
        ),
      ),
    );
  }

  Widget _diffBody(BuildContext context) {
    final text = diff?.text;
    if (text == null) return const Center(child: CircularProgressIndicator());
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
      child: SelectableText(
        text.isEmpty ? '没有差异' : text,
        style: const TextStyle(
          fontFamily: 'monospace',
          fontSize: 12,
          height: 1.45,
        ),
      ),
    );
  }

  Widget _statusBody(BuildContext context) {
    final ink2 = DshColors.ink2(context);
    final ink3 = DshColors.ink3(context);
    final status = widget.store.gitStatus;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 4, 18, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '当前分支：${status?.branch ?? '—'}',
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            '共 ${status?.counts['total'] ?? 0} 项 · 暂存 ${status?.counts['staged'] ?? 0} · 未暂存 ${status?.counts['unstaged'] ?? 0} · 未跟踪 ${status?.counts['untracked'] ?? 0}',
            style: TextStyle(fontSize: 12.5, height: 1.4, color: ink2),
          ),
          const SizedBox(height: 8),
          Divider(color: DshColors.line(context)),
          Expanded(
            child: ListView.separated(
              itemCount: status?.entries.length ?? 0,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (_, i) {
                final entry = status!.entries[i];
                return ListTile(
                  dense: true,
                  minVerticalPadding: 6,
                  contentPadding: EdgeInsets.zero,
                  leading: Text(
                    '${entry['index'] ?? ' '}${entry['worktree'] ?? ' '}',
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11.5,
                      color: ink3,
                    ),
                  ),
                  title: Text(
                    entry['path']?.toString() ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _GraphSheet extends StatefulWidget {
  final AppStore store;

  const _GraphSheet({required this.store});

  @override
  State<_GraphSheet> createState() => _GraphSheetState();
}

class _GraphSheetState extends State<_GraphSheet> {
  static const _maxVisibleBranches = 3;
  static const _maxNodeColorSegments = graph_logic.maxNodeColorSegments;
  List<GitBranch> selected = [];
  List<GitCommit> commits = [];
  String? snapshotId;
  String? nextCursor;
  String? errorMessage;
  bool loading = true;
  bool loadingMore = false;
  int _request = 0;

  @override
  void initState() {
    super.initState();
    selected = _defaultSelection();
    _load();
  }

  List<GitBranch> _branches() =>
      AppStore.sortGitBranches(widget.store.gitBranches);

  List<GitBranch> _defaultSelection() {
    final branches = _branches();
    final current = widget.store.gitStatus?.branch;
    final local = branches.where((branch) => !branch.remote).toList();
    GitBranch? currentBranch;
    for (final branch in local) {
      if (branch.displayName == current) {
        currentBranch = branch;
        break;
      }
    }
    if (currentBranch != null) return [currentBranch];
    if (local.isNotEmpty) return [local.first];
    return branches.isEmpty ? [] : [branches.first];
  }

  Future<void> _load({bool reset = true}) async {
    final id = widget.store.gitContext?.repositoryId;
    if (id == null) return;
    final request = ++_request;
    if (reset) {
      setState(() {
        loading = true;
        loadingMore = false;
        errorMessage = null;
      });
    } else {
      setState(() => loadingMore = true);
    }
    try {
      final page = await api.gitGraph(
        id,
        refs: selected,
        cursor: reset ? null : nextCursor,
      );
      if (!mounted || request != _request) return;
      setState(() {
        if (reset) {
          commits = page.commits;
          snapshotId = page.snapshotId;
        } else {
          final seen = commits.map((commit) => commit.oid).toSet();
          commits = [
            ...commits,
            ...page.commits.where((commit) => seen.add(commit.oid)),
          ];
        }
        nextCursor = page.nextCursor;
        loading = false;
        loadingMore = false;
        errorMessage = null;
      });
    } catch (e) {
      if (!mounted || request != _request) return;
      setState(() {
        loading = false;
        loadingMore = false;
        // A failed page must not remain retryable through scroll notifications.
        // The already rendered snapshot stays visible until the user refreshes.
        nextCursor = null;
        errorMessage = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  void _toggle(GitBranch branch, bool value) {
    if (!value && selected.length == 1) return;
    if (value && selected.length >= _maxVisibleBranches) return;
    final next = selected.where((item) => item.name != branch.name).toList();
    if (value) next.add(branch);
    setState(() => selected = next);
    _load();
  }

  List<Color> _graphPalette(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return dark
        ? const [
            Color(0xff4f8cff),
            Color(0xffff7a1a),
            Color(0xffff3fac),
            Color(0xff21d164),
            Color(0xffa970ff),
            Color(0xff20c8f6),
            Color(0xffff4d4d),
            Color(0xffffd000),
          ]
        : const [
            Color(0xff0057ff),
            Color(0xffff5a00),
            Color(0xffd5008f),
            Color(0xff00a83b),
            Color(0xff7a00ff),
            Color(0xff0096c7),
            Color(0xffe00000),
            Color(0xffc58a00),
          ];
  }

  int _stableColorIndex(String name, int length) {
    var hash = 0;
    for (final unit in name.codeUnits) {
      hash = ((hash * 31) + unit) & 0x7fffffff;
    }
    return hash % length;
  }

  Map<String, Color> _selectionColors(BuildContext context) {
    final palette = _graphPalette(context);
    final result = <String, Color>{};
    final used = <int>{};
    final ordered = [...selected]..sort((a, b) => a.name.compareTo(b.name));
    for (final branch in ordered) {
      var index = _stableColorIndex(branch.name, palette.length);
      while (used.contains(index)) {
        index = (index + 1) % palette.length;
      }
      used.add(index);
      result[branch.name] = palette[index];
    }
    return result;
  }

  List<Color> _laneColors(BuildContext context) {
    final palette = _graphPalette(context);
    final selectionColors = _selectionColors(context);
    final result = <Color>[
      for (final branch in selected) selectionColors[branch.name]!,
    ];
    for (final color in palette) {
      if (!result.contains(color)) result.add(color);
    }
    return result;
  }

  String _refLabel(String value) => value
      .replaceFirst('HEAD -> ', '')
      .replaceFirst('refs/heads/', '')
      .replaceFirst('refs/remotes/', '')
      .replaceFirst('refs/tags/', 'tag: ');

  String? _tagLabel(String value) {
    final normalized = value.startsWith('tag: ') ? value.substring(5) : value;
    if (!normalized.startsWith('refs/tags/')) return null;
    return normalized.substring('refs/tags/'.length);
  }

  Widget _filterRow(
    BuildContext context,
    String title,
    List<GitBranch> branches,
  ) {
    final selectedNames = selected.map((branch) => branch.name).toSet();
    final selectionColors = _selectionColors(context);
    final atLimit = selected.length >= _maxVisibleBranches;
    return SizedBox(
      height: 42,
      child: Row(
        children: [
          SizedBox(
            width: 54,
            child: Text(
              title,
              style: TextStyle(fontSize: 11.5, color: DshColors.ink3(context)),
            ),
          ),
          Expanded(
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                for (final branch in branches)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: FilterChip(
                      selected: selectedNames.contains(branch.name),
                      onSelected:
                          atLimit && !selectedNames.contains(branch.name)
                          ? null
                          : (value) => _toggle(branch, value),
                      label: Text(
                        branch.displayName,
                        overflow: TextOverflow.ellipsis,
                      ),
                      visualDensity: VisualDensity.compact,
                      avatar: CircleAvatar(
                        radius: 5,
                        backgroundColor:
                            selected.any((item) => item.name == branch.name)
                            ? selectionColors[branch.name]!
                            : DshColors.ink3(context),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final branches = _branches();
    final local = branches.where((branch) => !branch.remote).toList();
    final remote = branches.where((branch) => branch.remote).toList();
    final topology = graph_logic.layoutGraph(commits, selected);
    final colors = _laneColors(context);
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.72,
        child: Column(
          children: [
            const _GitSheetHeader(title: '分支图'),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
              child: Column(
                children: [
                  _filterRow(context, '本地', local),
                  _filterRow(context, '远程', remote),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      '已选择 ${selected.length}/$_maxVisibleBranches',
                      style: TextStyle(
                        fontSize: 11,
                        color: DshColors.ink3(context),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (errorMessage != null && commits.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 4,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '加载后续提交失败：$errorMessage',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          color: DshColors.danger(context),
                        ),
                      ),
                    ),
                    TextButton(onPressed: _load, child: const Text('刷新')),
                  ],
                ),
              ),
            Expanded(child: _graphBody(context, topology, colors)),
          ],
        ),
      ),
    );
  }

  Widget _graphBody(
    BuildContext context,
    graph_logic.GraphLayout topology,
    List<Color> colors,
  ) {
    if (loading && commits.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (errorMessage != null && commits.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              errorMessage!,
              textAlign: TextAlign.center,
              style: TextStyle(color: DshColors.ink3(context)),
            ),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _load, child: const Text('刷新')),
          ],
        ),
      );
    }
    if (commits.isEmpty) {
      return Center(
        child: Text('暂无提交', style: TextStyle(color: DshColors.ink3(context))),
      );
    }
    final calculatedWidth = topology.laneCount * 22.0 + 20;
    final graphWidth = calculatedWidth < 84 ? 84.0 : calculatedWidth;
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification.metrics.extentAfter < 180 &&
            nextCursor != null &&
            !loadingMore) {
          _load(reset: false);
        }
        return false;
      },
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        itemCount: commits.length + (loadingMore ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= commits.length) {
            return const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          final commit = commits[i];
          final row = topology.rows[i];
          final currentBranchName = widget.store.gitStatus?.branch;
          final tipBranches = selected
              .where((branch) => branch.oid == commit.oid)
              .toList();
          final headBranches = tipBranches
              .where((branch) => branch.displayName == currentBranchName)
              .toList();
          final tagNames = commit.refs
              .map(_tagLabel)
              .whereType<String>()
              .toList();
          final selectionColors = _selectionColors(context);
          final short = commit.oid.length > 8
              ? commit.oid.substring(0, 8)
              : commit.oid;
          final isHead =
              headBranches.isNotEmpty ||
              commit.refs.any(
                (ref) => ref == 'HEAD' || ref.startsWith('HEAD -> '),
              );
          final tipColors = row.tipColorSlots
              .map((slot) => selectionColors[selected[slot].name]!)
              .take(_maxNodeColorSegments)
              .toList();
          final labels = graph_logic.compactGraphLabels(
            tipBranches,
            tagNames,
            current: currentBranchName,
          );
          return SizedBox(
            height: 58,
            child: Row(
              children: [
                SizedBox(
                  width: 84,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: CustomPaint(
                      size: Size(graphWidth, 58),
                      painter: _GraphRowPainter(
                        row: row,
                        colors: colors,
                        tipColors: tipColors,
                        isHead: isHead,
                        lineColor: DshColors.line(context),
                        headColor: DshColors.brand(context),
                      ),
                    ),
                  ),
                ),
                Expanded(
                  child: ListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.only(left: 4, right: 6),
                    title: Row(
                      children: [
                        Expanded(
                          child: Text(
                            commit.subject,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        for (final label in labels)
                          Flexible(
                            child: Padding(
                              padding: const EdgeInsets.only(left: 4),
                              child: label.kind == 'branch'
                                  ? _GitHeadTag(
                                      label: label.text,
                                      color: selectionColors[label.branchName]!,
                                    )
                                  : _GitTag(label: label.text),
                            ),
                          ),
                      ],
                    ),
                    subtitle: Text(
                      '$short · ${commit.author}${commit.refs.isEmpty ? '' : ' · ${commit.refs.take(2).map(_refLabel).join(', ')}${commit.refs.length > 2 ? ' +${commit.refs.length - 2}' : ''}'}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.35,
                        color: DshColors.ink3(context),
                      ),
                    ),
                    trailing: isHead && headBranches.isEmpty
                        ? const Text(
                            '当前',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w700,
                            ),
                          )
                        : null,
                    onTap: () => _showGitSheet(
                      context,
                      (_) => _CommitSheet(store: widget.store, commit: commit),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _GitHeadTag extends StatelessWidget {
  final String label;
  final Color color;

  const _GitHeadTag({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 72),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 10,
          fontWeight: FontWeight.w800,
          height: 1.1,
        ),
      ),
    );
  }
}

class _GitTag extends StatelessWidget {
  final String label;

  const _GitTag({required this.label});

  @override
  Widget build(BuildContext context) {
    final color = DshColors.warn(context);
    return Container(
      constraints: const BoxConstraints(maxWidth: 72),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        border: Border.all(color: color, width: 1),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w800,
          height: 1.1,
        ),
      ),
    );
  }
}

class _GraphRowPainter extends CustomPainter {
  final graph_logic.GraphRow row;
  final List<Color> colors;
  final List<Color> tipColors;
  final bool isHead;
  final Color lineColor;
  final Color headColor;
  const _GraphRowPainter({
    required this.row,
    required this.colors,
    required this.tipColors,
    required this.isHead,
    required this.lineColor,
    required this.headColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const spacing = 22.0;
    double x(int lane) => 10 + lane * spacing;
    final stroke = Paint()
      ..strokeWidth = 2.5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..isAntiAlias = true;
    Color colorFor(int slot) =>
        colors.isEmpty ? lineColor : colors[slot % colors.length];
    Path smoothPath(Offset from, Offset to) {
      final middle = (from.dy + to.dy) / 2;
      return Path()
        ..moveTo(from.dx, from.dy)
        ..cubicTo(from.dx, middle, to.dx, middle, to.dx, to.dy);
    }

    for (final continuation in row.continuations) {
      stroke.color = colorFor(continuation.colorSlot);
      canvas.drawPath(
        smoothPath(
          Offset(x(continuation.from), 0),
          Offset(x(continuation.to), size.height),
        ),
        stroke,
      );
    }
    final current = Offset(x(row.lane), 20);
    stroke.color = colorFor(row.incomingColorSlot);
    canvas.drawLine(Offset(current.dx, 0), current, stroke);
    for (var i = 0; i < row.parentLanes.length; i++) {
      final parentLane = row.parentLanes[i];
      final parent = Offset(x(parentLane), 58);
      stroke.color = colorFor(row.parentColorSlots[i]);
      canvas.drawPath(smoothPath(current, parent), stroke);
    }
    final fill = Paint()
      ..style = PaintingStyle.fill
      ..isAntiAlias = true
      ..color = colorFor(row.colorSlot);
    const radius = 5.5;
    // Shared tips use one neutral node and a fixed-size segmented ring. This
    // keeps the node geometry stable and avoids misleading concentric rings.
    canvas.drawCircle(
      current,
      radius,
      tipColors.length > 1 ? (fill..color = lineColor) : fill,
    );
    if (tipColors.length > 1) {
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5;
      final rect = Rect.fromCircle(center: current, radius: 9);
      final count = tipColors.length;
      for (var i = 0; i < count; i++) {
        ring.color = tipColors[i];
        canvas.drawArc(
          rect,
          -math.pi / 2 + i * 2 * math.pi / count,
          2 * math.pi / count - .04,
          false,
          ring,
        );
      }
    }
    if ((row.merge || isHead) && tipColors.length <= 1) {
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = isHead ? headColor : fill.color;
      canvas.drawCircle(current, 9, ring);
    }
  }

  @override
  bool shouldRepaint(covariant _GraphRowPainter oldDelegate) =>
      oldDelegate.row != row ||
      oldDelegate.colors != colors ||
      oldDelegate.tipColors != tipColors ||
      oldDelegate.isHead != isHead ||
      oldDelegate.lineColor != lineColor ||
      oldDelegate.headColor != headColor;
}

class _CommitSheet extends StatelessWidget {
  final AppStore store;
  final GitCommit commit;

  const _CommitSheet({required this.store, required this.commit});

  @override
  Widget build(BuildContext context) {
    final ink3 = DshColors.ink3(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _GitSheetHeader(title: '提交详情'),
            Text(
              commit.subject,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 4),
            Text(
              '${commit.author} · ${commit.oid}',
              style: TextStyle(fontSize: 11.5, height: 1.35, color: ink3),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                final id = store.gitContext?.repositoryId;
                if (id == null) return;
                final diff = await api.gitDiff(
                  id,
                  kind: 'commit',
                  oid: commit.oid,
                );
                if (!context.mounted) return;
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => Scaffold(
                      appBar: AppBar(title: const Text('提交差异')),
                      body: SingleChildScrollView(
                        padding: const EdgeInsets.all(18),
                        child: SelectableText(
                          diff.text,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12,
                            height: 1.45,
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              },
              child: const Text('查看差异'),
            ),
          ],
        ),
      ),
    );
  }
}
