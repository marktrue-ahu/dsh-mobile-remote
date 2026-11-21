// issue #140/#141：子代理树契约的纯数据层（无 Flutter 依赖，可单测）。
//
// 服务端 `/subagents` 行字段：
//   id, name?, depth?, parentSessionId, kind(child|diagnostic), status,
//   title, createdAt?, diagnosticReason?（后端另含 catalogDegraded /
//   multiLevelUnavailable 响应级标记）。
//
// 本文件只做**解析与建树**：
// - 树结构必须按 `parentSessionId` 建，不能按数组顺序推断（ADR 0032 §4.5）；
// - `depth` 只用于展示缩进（UI 侧封顶），不参与父子关系；
// - 旧宿主缺 `parentSessionId`/`depth` 时退化为“全部直接子级”，由
//   `multiLevelUnavailable` 门控 UI 不渲染展开胶囊。

class SubagentCatalog {
  final List<Map<String, dynamic>> rows;
  final bool catalogDegraded;
  final bool multiLevelUnavailable;
  final bool parentAvailable;

  const SubagentCatalog({
    required this.rows,
    this.catalogDegraded = false,
    this.multiLevelUnavailable = false,
    this.parentAvailable = false,
  });

  static const empty = SubagentCatalog(rows: []);
}

SubagentCatalog parseSubagentCatalog(Map<String, dynamic> json) {
  final list = json['subagents'];
  final rows = <Map<String, dynamic>>[];
  if (list is List) {
    for (final row in list) {
      if (row is! Map) continue;
      final parsed = Map<String, dynamic>.from(row);
      final id = parsed['id'];
      if (id is! String || id.trim().isEmpty) continue;
      rows.add(parsed);
    }
  }
  // 旧宿主/旧插件不返回 depth：即使没带 multiLevelUnavailable 标记，也必须按
  // “无多层树”降级（#141：降级时不渲染胶囊 + 页签级说明），不能把缺失当可用。
  final inferredMultiLevelUnavailable =
      rows.isNotEmpty && !rows.any((row) => row['depth'] is num);
  return SubagentCatalog(
    rows: rows,
    catalogDegraded: json['catalogDegraded'] == true,
    multiLevelUnavailable:
        json['multiLevelUnavailable'] == true || inferredMultiLevelUnavailable,
    parentAvailable: json['parentAvailable'] == true,
  );
}

/// 一个子代理树节点。
class AgentNode {
  final String id;
  final String? name;
  final String title;
  final int? depth;
  final String? parentSessionId;
  final String kind;
  final String status;
  final int? createdAt;
  final List<AgentNode> children;

  AgentNode({
    required this.id,
    required this.name,
    required this.title,
    required this.depth,
    required this.parentSessionId,
    required this.kind,
    required this.status,
    required this.createdAt,
    List<AgentNode>? children,
  }) : children = children ?? <AgentNode>[];

  bool get isDiagnostic => kind == 'diagnostic';
  bool get isRunning => status == 'running';

  /// 副行代理名：优先 name；旧宿主/诊断行没有 name 时回退 title（#140 契约可空）。
  String get displayName {
    final n = name?.trim();
    if (n != null && n.isNotEmpty) return n;
    final t = title.trim();
    return t.isNotEmpty ? t : id;
  }
}

/// 按 `parentSessionId` 建树；返回根会话的直接子节点（siblings 保持服务端顺序）。
///
/// 防御：
/// - 父引用缺失/指向未知 id（旧插件、截断目录）的节点挂到根，避免整行消失；
/// - 环（A→B→A）会被打断并挂到根，绝不死循环。
List<AgentNode> buildAgentTree(
  List<Map<String, dynamic>> rows, {
  required String rootSessionId,
}) {
  final nodes = <String, AgentNode>{};
  for (final row in rows) {
    final id = _stringOf(row['id']);
    if (id.isEmpty || nodes.containsKey(id)) continue;
    nodes[id] = AgentNode(
      id: id,
      name: _nullableStringOf(row['name']),
      title: _titleOf(row),
      depth: _intOf(row['depth']),
      parentSessionId: _nullableStringOf(row['parentSessionId']),
      kind: _stringOf(row['kind']).isEmpty ? 'child' : _stringOf(row['kind']),
      status: _stringOf(row['status']),
      createdAt: _intOf(row['createdAt']),
    );
  }
  final roots = <AgentNode>[];
  for (final node in nodes.values) {
    final parentId = node.parentSessionId;
    final parent =
        parentId == null || parentId.isEmpty || parentId == rootSessionId
        ? null
        : nodes[parentId];
    if (parent == null ||
        parent.id == node.id ||
        _wouldCycle(nodes, node, parent)) {
      roots.add(node);
    } else {
      parent.children.add(node);
    }
  }
  return roots;
}

/// 环检测：沿 parent 链上溯，若回到自身则拒绝挂载。
bool _wouldCycle(
  Map<String, AgentNode> nodes,
  AgentNode node,
  AgentNode parent,
) {
  var cursor = parent;
  final seen = <String>{node.id};
  while (true) {
    if (!seen.add(cursor.id)) return true;
    final pid = cursor.parentSessionId;
    if (pid == null || pid.isEmpty) return false;
    final next = nodes[pid];
    if (next == null) return false;
    cursor = next;
  }
}

String _stringOf(Object? value) => value is String ? value.trim() : '';

String? _nullableStringOf(Object? value) {
  final text = _stringOf(value);
  return text.isEmpty ? null : text;
}

int? _intOf(Object? value) => value is num ? value.toInt() : null;

String _titleOf(Map<String, dynamic> row) {
  final title = _stringOf(row['title']);
  return title.isEmpty ? _stringOf(row['id']) : title;
}
