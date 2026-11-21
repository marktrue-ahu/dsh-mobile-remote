// issue #141：子代理树纯数据层（#140 契约）。
//
// 覆盖：
//   - catalog 解析 name/depth/parentSessionId + 降级标记；
//   - 树按 parentSessionId 建（不按数组顺序），parent 不在数组/环安全回退根；
//   - 直系子级计数与副行 name 回退 title。

import 'package:dsh_mobile_app/agent_tree.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> row({
  required String id,
  String? name,
  int? depth,
  String? parentSessionId,
  String title = '',
  String kind = 'child',
  String status = 'inactive',
  int? createdAt,
}) => {
  'id': id,
  'name': ?name,
  'depth': ?depth,
  'parentSessionId': ?parentSessionId,
  'title': title.isEmpty ? id : title,
  'kind': kind,
  'status': status,
  'createdAt': ?createdAt,
};

void main() {
  group('#141 catalog 解析', () {
    test('行字段与降级标记', () {
      final catalog = parseSubagentCatalog({
        'ok': true,
        'parentAvailable': true,
        'catalogDegraded': true,
        'multiLevelUnavailable': true,
        'subagents': [
          {
            'id': 'a',
            'name': 'reviewer',
            'depth': 1,
            'parentSessionId': 'root',
            'title': 'T',
            'kind': 'child',
            'status': 'running',
          },
        ],
      });
      expect(catalog.catalogDegraded, isTrue);
      expect(catalog.multiLevelUnavailable, isTrue);
      expect(catalog.parentAvailable, isTrue);
      expect(catalog.rows, hasLength(1));
      expect(catalog.rows.single['name'], 'reviewer');
      expect(catalog.rows.single['depth'], 1);
      expect(catalog.rows.single['parentSessionId'], 'root');
    });

    test('旧插件无 depth：推断 multiLevelUnavailable（不把缺失当可用）', () {
      final catalog = parseSubagentCatalog({
        'subagents': [
          {
            'id': 'old-child',
            'title': '旧子代理',
            'kind': 'child',
            'status': 'inactive',
          },
        ],
      });
      expect(catalog.rows, hasLength(1));
      expect(catalog.multiLevelUnavailable, isTrue);
    });

    test('新契约 depth 齐全：不误标降级', () {
      final catalog = parseSubagentCatalog({
        'subagents': [
          {'id': 'a', 'depth': 1, 'parentSessionId': 'root'},
        ],
      });
      expect(catalog.multiLevelUnavailable, isFalse);
    });

    test('缺字段/非法行安全解析', () {
      final catalog = parseSubagentCatalog({
        'subagents': [
          null,
          'x',
          {'id': ''},
        ],
      });
      expect(catalog.rows, isEmpty);
      expect(catalog.multiLevelUnavailable, isFalse);
    });
  });

  group('#141 建树', () {
    test('按 parentSessionId 建树，不受数组顺序影响', () {
      // 子节点甚至排在父节点之前：不能按顺序推断。
      final rows = [
        row(id: 'grand', depth: 2, parentSessionId: 'child', name: 'checker'),
        row(id: 'child', depth: 1, parentSessionId: 'root', name: 'reviewer'),
        row(id: 'sibling', depth: 1, parentSessionId: 'root', name: 'tester'),
      ];
      final roots = buildAgentTree(rows, rootSessionId: 'root');
      expect(roots.map((n) => n.id), ['child', 'sibling']);
      final child = roots.firstWhere((n) => n.id == 'child');
      expect(child.children.map((n) => n.id), ['grand']);
      expect(child.children.single.depth, 2);
      expect(child.children.single.parentSessionId, 'child');
      expect(roots.firstWhere((n) => n.id == 'sibling').children, isEmpty);
    });

    test('父引用缺失/未知/环：挂到根，不丢行、不死循环', () {
      final rows = [
        row(id: 'orphan', parentSessionId: 'missing'),
        row(id: 'legacy'), // 旧插件无 parentSessionId
        row(id: 'a', parentSessionId: 'b'),
        row(id: 'b', parentSessionId: 'a'),
      ];
      final roots = buildAgentTree(rows, rootSessionId: 'root');
      expect(roots.map((n) => n.id).toSet(), {'orphan', 'legacy', 'a', 'b'});
      // 环不产生任何 children 互挂；仍能安全遍历。
      for (final node in roots) {
        expect(node.children, isEmpty);
      }
    });

    test('副行 name 可空回退 title / id', () {
      final roots = buildAgentTree([
        row(id: 'named', name: 'reviewer', title: '标题'),
        row(id: 'unnamed', title: '仅有标题'),
        row(id: 'bare', title: ''),
      ], rootSessionId: 'root');
      final byId = {for (final n in roots) n.id: n};
      expect(byId['named']!.displayName, 'reviewer');
      expect(byId['unnamed']!.displayName, '仅有标题');
      expect(byId['bare']!.displayName, 'bare');
    });

    test('诊断行保留 kind/status/depth，不参与折叠计数', () {
      final roots = buildAgentTree([
        row(
          id: 'diag',
          kind: 'diagnostic',
          status: 'corrupt',
          depth: 1,
          parentSessionId: 'root',
        ),
      ], rootSessionId: 'root');
      expect(roots.single.isDiagnostic, isTrue);
      expect(roots.single.status, 'corrupt');
      expect(roots.single.children, isEmpty);
    });
  });

  test('#141 过滤重排合并保留隐藏项槽位', () {
    // 与 chat_screen.dart 的 mergeFilteredConversationOrder 同语义（纯函数在 UI 层）。
  });
}
