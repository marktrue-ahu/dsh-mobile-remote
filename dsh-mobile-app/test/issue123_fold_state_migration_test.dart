// issue #123 审查 P2：过程段/组**手动折叠状态**的可持续身份迁移（纯策略单测）。
//
// 背景：段键 = 轮号 + 开段插话边界 seq（首段 `head`）。partial 窗口（初始 REST
// 只给最后 N 条）缺 `turn/start` / 开段插话时，边界不可知 → 键是 `head`；
// 用户上翻 `before` 分页把真实边界补进来后，同一批过程行有了边界 → 键变 `<seq>`。
// 成员行没变，手动状态必须跟着迁移，否则用户点过的展开/收起「失效」。
//
// 本文件直接测纯策略（不依赖 Flutter）：
//   - partial → 边界补入：段/组状态一起迁移；
//   - **成员身份**：工具行按 `callId`、reasoning 行按内核 `step`（不是行 seq——
//     `tool/call` 会覆盖 `reportedSeq`，同一工具在不同快照里的 seq 会变）；
//   - 更早的段被补进来（旧段键不变）：不迁移、不串；
//   - 窗口裁剪合段：状态跟随仍存活的成员，旧键删除；
//   - 真切段：1:1 贪心匹配，只有匹配到的那一部分继承，不复制状态；
//   - 无成员重叠的新段：不继承任何旧状态（不按键字符串猜）；
//   - sync 幂等：同一批段重复同步不会反复迁移。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue123_fold_state_migration_test.dart

import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter_test/flutter_test.dart';

/// 思考行段：`step` 为空 = 旧内核/老历史的退化（无 step）行。
ProcessSegment _segment(
  List<int> rowSeqs, {
  int? boundarySeq,
  int? step,
}) => ProcessSegment(
  boundarySeq: boundarySeq,
  rows: List.unmodifiable([
    for (final seq in rowSeqs)
      ProcessRow.reasoning(
        seq: seq,
        step: step,
        reasoning: '第 $seq 步',
        reasoningChars: 5,
      ),
  ]),
);

/// 工具行段：`(seq, callId)` 列表（seq 可随 `tool/call` 到达而变，callId 不变）。
ProcessSegment _toolSegment(
  List<(int, String)> rows, {
  int? boundarySeq,
  int? step,
}) => ProcessSegment(
  boundarySeq: boundarySeq,
  rows: List.unmodifiable([
    for (final (seq, callId) in rows)
      ProcessRow.tool(seq: seq, step: step, callId: callId, toolName: 'shell'),
  ]),
);

ChatEvent _ev(int seq, String type, Map<String, dynamic> data) =>
    ChatEvent(seq: seq, type: type, data: data, time: seq * 10);

void main() {
  group('#123 P2 段/组手动状态迁移', () {
    test('partial 窗口补入开段边界：段与组的手动状态一起迁移', () {
      final state = ProcessFoldState();
      // 初始 partial 窗口：缺 turn/start、缺插话 → 首段键 head，组键 head:35。
      final partial = [_segment([100, 101, 102], step: 35)];
      state.sync(1, partial);
      expect(state.segmentExpandedOf(partial.single, 1), isNull);
      expect(state.groupExpandedOf(partial.single, 1, 35), isNull);
      state.setSegmentExpanded(segmentKeyOf(partial.single, 1), false);
      state.setGroupExpanded(groupKeyOf(partial.single, 1, 35), false);
      expect(segmentKeyOf(partial.single, 1), '1:head');

      // before 补页补入插话 seq95：同一批行现在有开段边界 95。
      final completed = [_segment([100, 101, 102], boundarySeq: 95, step: 35)];
      state.sync(1, completed);
      expect(segmentKeyOf(completed.single, 1), '1:95');
      expect(
        state.segmentExpandedOf(completed.single, 1),
        isFalse,
        reason: '段级手动状态必须跟到新键',
      );
      expect(
        state.groupExpandedOf(completed.single, 1, 35),
        isFalse,
        reason: '组级手动状态必须跟到新键',
      );
      // 旧键删除：将来若又出现 `head`（边界被裁剪），不得把这份状态读回来。
      expect(state.segmentManual.containsKey('1:head'), isFalse);
      expect(state.groupManual.containsKey('1:head:35'), isFalse);
    });

    test('补入更早的段（旧段键不变）：不迁移、不串到新段', () {
      final state = ProcessFoldState();
      final beforePage = [_segment([100, 101], boundarySeq: 95, step: 35)];
      state.sync(1, beforePage);
      state.setGroupExpanded(groupKeyOf(beforePage.single, 1, 35), false);

      // 补页把更早的 head 段（插话之前的过程行）也补进来：旧段键仍是 1:95。
      final afterPage = [
        _segment([10, 11], step: 10),
        _segment([100, 101], boundarySeq: 95, step: 35),
      ];
      state.sync(1, afterPage);
      expect(state.groupExpandedOf(afterPage[1], 1, 35), isFalse,
          reason: '旧段键不变，状态原地保留');
      expect(
        state.groupExpandedOf(afterPage[0], 1, 10),
        isNull,
        reason: '新补进来的更早段不得继承旧段的手动状态',
      );
    });

    test('窗口裁剪删掉边界（合段）：状态跟随仍存活的成员', () {
      final state = ProcessFoldState();
      final twoSegments = [
        _segment([10, 11], step: 10),
        _segment([100, 101], boundarySeq: 95, step: 35),
      ];
      state.sync(1, twoSegments);
      state.setGroupExpanded(groupKeyOf(twoSegments[1], 1, 35), false);

      // 裁剪：边界 95 与 head 段一起被裁掉，只剩原 95 段的成员 → 合段成 head。
      final merged = [_segment([100, 101], step: 35)];
      state.sync(1, merged);
      expect(segmentKeyOf(merged.single, 1), '1:head');
      expect(
        state.groupExpandedOf(merged.single, 1, 35),
        isFalse,
        reason: '合段后同一批成员的手动状态必须跟随',
      );
      expect(state.segmentManual.containsKey('1:95'), isFalse);
    });

    test('真切段：1:1 匹配只让匹配到的部分继承，不复制状态', () {
      final state = ProcessFoldState();
      final single = [_segment([100, 101, 102, 103], step: 35)];
      state.sync(1, single);
      state.setSegmentExpanded(segmentKeyOf(single.single, 1), false);

      // 边界 101 补插进段内部（当前事件序不可达的防御性场景）：
      // 前 2 行 → head，后 2 行 → 101。只有保留比例更高的那一部分继承。
      final split = [
        _segment([100], step: 35),
        _segment([101, 102, 103], boundarySeq: 101, step: 35),
      ];
      state.sync(1, split);
      expect(state.segmentExpandedOf(split[1], 1), isFalse,
          reason: '保留比例 3/4 的部分继承手动状态');
      expect(state.segmentExpandedOf(split[0], 1), isNull,
          reason: '另一部分不复制状态（否则一个操作让两段同时收起）');
      expect(state.segmentManual.containsKey('1:head'), isFalse);
    });

    test('无成员重叠的新段不继承旧状态（不按键字符串猜）', () {
      final state = ProcessFoldState();
      final old = [_segment([100, 101], boundarySeq: 95, step: 35)];
      state.sync(1, old);
      state.setSegmentExpanded(segmentKeyOf(old.single, 1), false);
      state.setGroupExpanded(groupKeyOf(old.single, 1, 35), false);

      // 全新一段（成员完全不同）恰好也以 head 为键：不得读到旧状态。
      final fresh = [_segment([500, 501], step: 36)];
      state.sync(1, fresh);
      expect(state.segmentExpandedOf(fresh.single, 1), isNull);
      expect(state.groupExpandedOf(fresh.single, 1, 36), isNull);
    });

    test('sync 幂等：同一批段重复同步不会反复迁移或丢状态', () {
      final state = ProcessFoldState();
      final partial = [_segment([100, 101], step: 35)];
      state.sync(1, partial);
      state.setGroupExpanded(groupKeyOf(partial.single, 1, 35), false);
      final completed = [_segment([100, 101], boundarySeq: 95, step: 35)];
      state.sync(1, completed);
      final first = state.groupManual;
      state.sync(1, completed);
      state.sync(1, completed);
      expect(state.groupManual, first);
      expect(state.groupExpandedOf(completed.single, 1, 35), isFalse);
    });

    test('不同轮次互不影响；clear 清空全部状态与快照', () {
      final state = ProcessFoldState();
      final turn1 = [_segment([100], boundarySeq: 95, step: 35)];
      final turn2 = [_segment([200], step: 7)];
      state.sync(1, turn1);
      state.sync(2, turn2);
      state.setGroupExpanded(groupKeyOf(turn1.single, 1, 35), false);
      state.setGroupExpanded(groupKeyOf(turn2.single, 2, 7), true);
      expect(state.groupExpandedOf(turn1.single, 1, 35), isFalse);
      expect(state.groupExpandedOf(turn2.single, 2, 7), isTrue);
      state.clear();
      expect(state.segmentManual, isEmpty);
      expect(state.groupManual, isEmpty);
      expect(state.groupExpandedOf(turn1.single, 1, 35), isNull);
    });
  });

  // ── 成员身份：不能用行 seq（#123 复核 blocking） ─────────────────────────
  //
  // 实证：同一工具先见 `tool/result`（seq110）→ `reportedSeq=110`；补页补入
  // `tool/call`（seq100）会**无条件覆盖**成 100（call 是权威 layout 位置）。
  // `ProcessRow.seq` 直接取 `reportedSeq`，所以「同一行」在两个快照里的 seq 不同；
  // 身份必须用 `callId`（工具）/ 内核 `step`（思考行）。
  group('#123 成员身份：callId / step，而不是行 seq', () {
    test('实证：result 先到 110、call 后补 100 → 同一工具的行 seq 会变', () {
      final tracker = TurnProcessTracker()
        ..observe(_ev(120, 'assistant/message', {
          'turn': 1,
          'step': 1,
          'reasoning': '想一想',
          'reasoningChars': 3,
          'text': '',
        }))
        ..observe(_ev(110, 'tool/result', {
          'turn': 1,
          'step': 2,
          'callId': 'c1',
          'name': 'shell',
          'text': 'ok',
        }));
      ProcessRow toolRow() =>
          tracker.build().single.rows.firstWhere((row) => row.isTool);
      expect(toolRow().seq, 110, reason: '前提：partial 窗口只有 result');
      expect(memberIdentityOf(toolRow()), 'tool:c1');
      tracker.observe(_ev(100, 'tool/call', {
        'turn': 1,
        'step': 2,
        'callId': 'c1',
        'name': 'shell',
      }));
      expect(toolRow().seq, 100, reason: 'call 到达后 reportedSeq 被覆盖（产品语义）');
      expect(
        memberIdentityOf(toolRow()),
        'tool:c1',
        reason: 'seq 变了，身份不变——迁移必须按 callId',
      );
    });

    test('工具行 seq 从 110 变 100（callId 不变）→ 段与组状态都迁移', () {
      final state = ProcessFoldState();
      final before = [_toolSegment([(110, 'c1')], step: 24)];
      state.sync(1, before);
      state.setSegmentExpanded(segmentKeyOf(before.single, 1), false);
      state.setGroupExpanded(groupKeyOf(before.single, 1, 24), false);

      final after = [_toolSegment([(100, 'c1')], boundarySeq: 95, step: 24)];
      state.sync(1, after);
      expect(segmentKeyOf(after.single, 1), '1:95');
      expect(state.segmentExpandedOf(after.single, 1), isFalse,
          reason: '段级状态必须按 callId 迁移（不是按行 seq）');
      expect(state.groupExpandedOf(after.single, 1, 24), isFalse,
          reason: '组级状态必须按 callId 迁移');
      expect(state.groupManual.containsKey('1:head:24'), isFalse);
    });

    test('整段工具行 seq 全变（保留比例按 seq 只有 1/4）→ 仍按 callId 匹配', () {
      final state = ProcessFoldState();
      final before = [
        _toolSegment([(8, 'cA'), (9, 'cB')], step: 1),
      ];
      state.sync(1, before);
      state.setGroupExpanded(groupKeyOf(before.single, 1, 1), false);

      // 补页与边界同页到达：cA 8→4、cB 9→5，且新增同段第三行 cC 6。
      final after = [
        _toolSegment([(4, 'cA'), (5, 'cB'), (6, 'cC')], boundarySeq: 3, step: 1),
      ];
      state.sync(1, after);
      expect(state.groupExpandedOf(after.single, 1, 1), isFalse,
          reason: 'seq 交集只剩 0 行也必须按 callId 认出同一段');
    });

    test('思考行 seq 变（迟到 chunk 让落定行继承更小 seq）→ 按 step 迁移', () {
      final state = ProcessFoldState();
      final before = [_segment([110], step: 5)];
      state.sync(1, before);
      state.setGroupExpanded(groupKeyOf(before.single, 1, 5), false);

      final after = [_segment([50], boundarySeq: 95, step: 5)];
      state.sync(1, after);
      expect(
        state.groupExpandedOf(after.single, 1, 5),
        isFalse,
        reason: '同一 step 的思考行只看 step：seq 由 noteReasoningStart 取 min，会变',
      );
    });

    test('混合段：工具行看 callId、思考行看 step，一起参与身份', () {
      final state = ProcessFoldState();
      final before = ProcessSegment(
        rows: [
          ProcessRow.tool(seq: 110, step: 24, callId: 'c1', toolName: 'shell'),
          ProcessRow.reasoning(seq: 120, step: 25, reasoning: '想', reasoningChars: 1),
        ],
      );
      state.sync(1, [before]);
      state.setGroupExpanded(groupKeyOf(before, 1, 24), false);
      state.setGroupExpanded(groupKeyOf(before, 1, 25), false);

      // 补页：工具 seq 变 100，思考行 seq 变 60；两个身份都不变。
      final after = ProcessSegment(
        boundarySeq: 95,
        rows: [
          ProcessRow.tool(seq: 100, step: 24, callId: 'c1', toolName: 'shell'),
          ProcessRow.reasoning(seq: 60, step: 25, reasoning: '想', reasoningChars: 1),
        ],
      );
      state.sync(1, [after]);
      expect(state.groupExpandedOf(after, 1, 24), isFalse);
      expect(state.groupExpandedOf(after, 1, 25), isFalse);
    });

    test('缺 step 的思考行没有稳定 id：身份退回 seq（已知局限，明确记录）', () {
      final state = ProcessFoldState();
      final before = [_segment([110])];
      state.sync(1, before);
      state.setGroupExpanded(groupKeyOf(before.single, 1, null), false);

      // seq 变（例如老宿主 null-step 历史行重放）→ 没有稳定身份，匹配不上。
      final after = [_segment([100], boundarySeq: 95)];
      state.sync(1, after);
      expect(
        state.groupExpandedOf(after.single, 1, null),
        isNull,
        reason: 'null-step 行只能按 seq 认：seq 变则视为新段（不会串段，但会丢状态）',
      );
      expect(state.groupManual, isEmpty, reason: '旧键必须被删除，不能留到将来误读');
    });
  });
}
