import 'git_models.dart';

const maxNodeColorSegments = 3;

class GraphRow {
  final int lane;
  final int incomingColorSlot;
  final int colorSlot;
  final List<int> parentLanes;
  final List<int> parentColorSlots;
  final List<int> tipColorSlots;
  final List<GraphContinuation> continuations;
  final bool merge;
  const GraphRow({
    required this.lane,
    required this.incomingColorSlot,
    required this.colorSlot,
    required this.parentLanes,
    required this.parentColorSlots,
    required this.tipColorSlots,
    this.continuations = const [],
    this.merge = false,
  });
}

class GraphContinuation {
  final int from, to, colorSlot;
  const GraphContinuation(this.from, this.to, this.colorSlot);
}

class GraphLayout {
  final List<GraphRow> rows;
  final int laneCount;
  const GraphLayout(this.rows, this.laneCount);
}

List<int> selectedTipColorSlots(GitCommit commit, List<GitBranch> selected) => [
  for (var i = 0; i < selected.length; i++)
    if (selected[i].oid == commit.oid) i,
];

class GraphLabel {
  final String kind, text;
  final String? branchName;
  final bool current;
  final int hiddenCount;
  const GraphLabel(
    this.kind,
    this.text, {
    this.branchName,
    this.current = false,
    this.hiddenCount = 0,
  });
}

List<GraphLabel> compactGraphLabels(
  List<GitBranch> tips,
  Iterable<String> tags, {
  String? current,
}) {
  final ordered = <GraphLabel>[];
  for (final branch in tips.where((branch) => branch.displayName == current)) {
    ordered.add(
      GraphLabel(
        'branch',
        '${branch.displayName} · 当前',
        branchName: branch.name,
        current: true,
      ),
    );
  }
  for (final branch in tips) {
    if (branch.displayName == current) {
      continue;
    }
    ordered.add(
      GraphLabel('branch', branch.displayName, branchName: branch.name),
    );
  }
  ordered.addAll(tags.map((tag) => GraphLabel('tag', tag)));
  if (ordered.length <= 2) return ordered;
  return [
    ordered.first,
    GraphLabel(
      'overflow',
      '+${ordered.length - 1}',
      hiddenCount: ordered.length - 1,
    ),
  ];
}

GraphLayout layoutGraph(List<GitCommit> commits, List<GitBranch> selected) {
  final selectedSlots = <String, List<int>>{};
  for (var i = 0; i < selected.length; i++) {
    (selectedSlots[selected[i].oid] ??= []).add(i);
  }
  final lanes = <String>[];
  final colors = <int>[];
  final rows = <GraphRow>[];
  var nextColor = selected.length;
  final commitsByOid = {for (final commit in commits) commit.oid: commit};
  final commitOids = commitsByOid.keys.toSet();
  final selectedOids = selected.map((branch) => branch.oid).toSet();

  bool reaches(String start, String target) {
    final pending = <String>[start];
    final seen = <String>{};
    while (pending.isNotEmpty) {
      final oid = pending.removeLast();
      if (!seen.add(oid)) continue;
      if (oid == target) return true;
      pending.addAll(commitsByOid[oid]?.parents ?? const []);
    }
    return false;
  }

  // Anchor selected tips in the user's selection order when this page contains
  // them. A selected ancestor shares its descendant's lane until its own row;
  // reserving a second lane for it would create a false branch split and skip
  // the normal selected-color transition at that node.
  final anchoredSelectedOids = selectedOids.where((oid) {
    if (!commitOids.contains(oid)) return false;
    return !selectedOids.any((other) => other != oid && reaches(other, oid));
  }).toSet();
  for (final branch in selected) {
    if (!anchoredSelectedOids.contains(branch.oid) ||
        lanes.contains(branch.oid)) {
      continue;
    }
    lanes.add(branch.oid);
    colors.add(selectedSlots[branch.oid]?.first ?? nextColor++);
  }

  var laneCount = lanes.isEmpty ? 1 : lanes.length;
  for (final commit in commits) {
    var lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      // A newly encountered component belongs to a new lane. Appending keeps
      // already active/selected lanes stable instead of visually reconnecting
      // their parent line to the new component.
      lane = lanes.length;
      lanes.add(commit.oid);
      colors.add(selectedSlots[commit.oid]?.first ?? nextColor++);
    }
    final incoming = colors[lane];
    if (lanes.length > laneCount) {
      laneCount = lanes.length;
    }
    final outgoing = selectedSlots[commit.oid]?.first ?? incoming;
    colors[lane] = outgoing;
    final afterLanes = <String>[...lanes]..removeAt(lane);
    final afterColors = <int>[...colors]..removeAt(lane);
    final parentLanes = <int>[];
    final parentColors = <int>[];
    for (var i = 0; i < commit.parents.length; i++) {
      var p = afterLanes.indexOf(commit.parents[i]);
      if (p < 0) {
        p = (lane + i).clamp(0, afterLanes.length);
        afterLanes.insert(p, commit.parents[i]);
        afterColors.insert(p, i == 0 ? outgoing : nextColor++);
      }
      parentLanes.add(p);
      parentColors.add(afterColors[p]);
    }
    final continuations = <GraphContinuation>[];
    for (var i = 0; i < lanes.length; i++) {
      if (i == lane) {
        continue;
      }
      final target = afterLanes.indexOf(lanes[i]);
      if (target >= 0) {
        continuations.add(GraphContinuation(i, target, colors[i]));
      }
    }
    rows.add(
      GraphRow(
        lane: lane,
        incomingColorSlot: incoming,
        colorSlot: outgoing,
        parentLanes: parentLanes,
        parentColorSlots: parentColors,
        tipColorSlots: selectedTipColorSlots(commit, selected),
        continuations: continuations,
        merge: commit.parents.length > 1,
      ),
    );
    lanes
      ..clear()
      ..addAll(afterLanes);
    colors
      ..clear()
      ..addAll(afterColors);
    if (afterLanes.length > laneCount) laneCount = afterLanes.length;
  }
  return GraphLayout(rows, laneCount);
}
