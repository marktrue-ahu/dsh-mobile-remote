// issue #123（方案 D）：数据层只剩**段级**折叠状态；组级折叠状态移到 widget 层。
//
// 本文件覆盖：
// 1. 段级身份迁移（partial → 边界补入；成员身份用 callId/step，不用行 seq）；
// 2. `retainTurns` 剪枝；
// 3. 组身份 `groupIdentityOf` 的**唯一性**（含 `1,2,1` / `null,2,null` 两种
//    同段内同 step 重复的形态——reviewer-12 的阻断项）：方案 D 不要求组身份稳定，
//    但要求唯一（重复 ValueKey 会让同 Column 兄弟在 debug 构建直接断言）。
//
// 精确重跑：
//   cd dsh-mobile-app && flutter test --no-pub test/issue123_fold_state_migration_test.dart

import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter_test/flutter_test.dart';

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

ProcessSegment _toolRowsSegment(
  List<(int, String, int?)> rows, {
  int? boundarySeq,
}) => ProcessSegment(
  boundarySeq: boundarySeq,
  rows: List.unmodifiable([
    for (final (seq, callId, step) in rows)
      ProcessRow.tool(seq: seq, step: step, callId: callId, toolName: 'shell'),
  ]),
);

ChatEvent _ev(int seq, String type, Map<String, dynamic> data) =>
    ChatEvent(seq: seq, type: type, data: data, time: seq * 10);

void main() {
  group('#123 段级身份迁移（数据层保留）', () {
    test('partial 窗口补入开段边界：段级手动状态迁移', () {
      final state = SegmentFoldState();
      final partial = [_segment([100, 101], step: 35)];
      state.sync(1, partial);
      expect(state.segmentExpandedOf(partial.single, 1), isNull);
      state.setSegmentExpanded(segmentKeyOf(partial.single, 1), false);
      expect(segmentKeyOf(partial.single, 1), '1:head');

      final completed = [_segment([100, 101], step: 35, boundarySeq: 95)];
      state.sync(1, completed);
      expect(segmentKeyOf(completed.single, 1), '1:95');
      expect(state.segmentExpandedOf(completed.single, 1), isFalse,
          reason: '段级手动状态必须跟到新键');
      expect(state.segmentManual.containsKey('1:head'), isFalse);
    });

    test('补入更早的段（旧段键不变）：不迁移、不串', () {
      final state = SegmentFoldState();
      final beforePage = [_segment([100, 101], step: 35, boundarySeq: 95)];
      state.sync(1, beforePage);
      state.setSegmentExpanded(segmentKeyOf(beforePage.single, 1), false);

      final afterPage = [
        _segment([10, 11], step: 10),
        _segment([100, 101], step: 35, boundarySeq: 95),
      ];
      state.sync(1, afterPage);
      expect(state.segmentExpandedOf(afterPage[1], 1), isFalse,
          reason: '旧段键不变，状态原地保留');
      expect(state.segmentExpandedOf(afterPage[0], 1), isNull,
          reason: '新补进来的更早段不得继承旧段状态');
    });

    test('工具行 seq 被 call 覆盖（result 先到）也按 callId 迁移', () {
      final state = SegmentFoldState();
      final before = [_toolRowsSegment([(110, 'c1', 35)])];
      state.sync(1, before);
      state.setSegmentExpanded(segmentKeyOf(before.single, 1), false);

      final after = [_toolRowsSegment([(100, 'c1', 35)], boundarySeq: 95)];
      state.sync(1, after);
      expect(state.segmentExpandedOf(after.single, 1), isFalse,
          reason: '身份令牌按 callId，不看会变的 reportedSeq');
    });

    test('合段：状态跟随仍存活的成员，旧键删除', () {
      final state = SegmentFoldState();
      final twoSegments = [
        _segment([10, 11], step: 10),
        _segment([100, 101], step: 35, boundarySeq: 95),
      ];
      state.sync(1, twoSegments);
      state.setSegmentExpanded(segmentKeyOf(twoSegments[1], 1), false);

      final merged = [_segment([100, 101], step: 35)];
      state.sync(1, merged);
      expect(segmentKeyOf(merged.single, 1), '1:head');
      expect(state.segmentExpandedOf(merged.single, 1), isFalse);
      expect(state.segmentManual.containsKey('1:95'), isFalse);
    });

    test('retainTurns：只剪不再渲染的轮次快照，不动手动状态', () {
      final state = SegmentFoldState();
      final turn1 = _segment([100], step: 35, boundarySeq: 95);
      final turn2 = _segment([200], step: 7, boundarySeq: 96);
      state.sync(1, [turn1]);
      state.sync(2, [turn2]);
      state.setSegmentExpanded('1:95', false);
      expect(state.snapshotTurns, {1, 2});
      state.retainTurns({2});
      expect(state.snapshotTurns, {2});
      expect(state.segmentExpandedOf(turn1, 1), isFalse,
          reason: '剪枝只剪快照，手动状态必须保留');
    });
  });

  // ── 组身份（方案 D）：只要求唯一，不要求稳定 ─────────────────────────
  group('#123 组身份唯一性（ValueKey 地基）', () {
    test('实证：result→call 只改行 seq，不改 callId（身份因此稳定）', () {
      final tracker = TurnProcessTracker()
        ..observe(_ev(1, 'turn/start', {'turn': 1}))
        ..observe(_ev(2, 'assistant/message', {
          'turn': 1, 'step': 1, 'messageId': 'r1', 'text': '',
          'reasoning': '想', 'reasoningChars': 1,
        }))
        ..observe(_ev(110, 'tool/result', {
          'turn': 1, 'step': 2, 'callId': 'c1', 'name': 'shell', 'text': 'ok',
        }));
      final turn = tracker.build().single;
      final group = segmentsOf(turn)
          .expand((s) => s.groups)
          .firstWhere((g) => g.rows.any((r) => r.isTool));
      expect(group.rows.firstWhere((r) => r.isTool).seq, 110);
      final identity = groupIdentityOf(group, 1);
      expect(identity, '1#tool:c1');
      tracker.observe(_ev(100, 'tool/call', {
        'turn': 1, 'step': 2, 'callId': 'c1', 'name': 'shell',
      }));
      final after = tracker.build().single;
      final groupAfter = segmentsOf(after)
          .expand((s) => s.groups)
          .firstWhere((g) => g.rows.any((r) => r.isTool));
      expect(groupAfter.rows.firstWhere((r) => r.isTool).seq, 100,
          reason: 'call 覆盖 reportedSeq（产品语义不变）');
      expect(groupIdentityOf(groupAfter, 1), identity,
          reason: '组身份按 callId：seq 变化不影响 identity');
    });

    test('同段内 step 重复 `1,2,1`：组身份仍然唯一', () {
      // result 先到（call 不在窗口）→ step1 的行被排到 step2 之后。
      final tracker = TurnProcessTracker()
        ..observe(_ev(1, 'turn/start', {'turn': 1}))
        ..observe(_ev(5, 'assistant/message', {
          'turn': 1, 'step': 1, 'messageId': 'r1', 'text': '',
          'reasoning': '第一步思考', 'reasoningChars': 2,
        }))
        ..observe(_ev(10, 'tool/call', {
          'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'shell',
        }))
        ..observe(_ev(11, 'tool/result', {
          'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'shell', 'text': 'ok',
        }))
        ..observe(_ev(30, 'tool/result', {
          'turn': 1, 'step': 1, 'callId': 'cLate', 'name': 'shell', 'text': 'ok',
        }));
      final turn = tracker.build().single;
      final segment = segmentsOf(turn).single;
      expect([for (final g in segment.groups) g.step], [1, 2, 1],
          reason: '同段内 step 真的会重复（reviewer-12 的阻断项）');
      final identities = [
        for (final g in segment.groups) groupIdentityOf(g, 1),
      ];
      expect(identities.toSet().length, identities.length,
          reason: 'identity 唯一 → ValueKey 不会重复（否则 debug 断言崩）');
      expect(identities, ['1#think-step:1', '1#tool:c2', '1#tool:cLate']);
    });

    test('同段内无 step 行交错 `null,2,null`：组身份仍然唯一', () {
      final tracker = TurnProcessTracker()
        ..observe(_ev(1, 'turn/start', {'turn': 1}))
        ..observe(_ev(10, 'assistant/message', {
          'turn': 1, 'messageId': 'r1', 'text': '',
          'reasoning': '第一段', 'reasoningChars': 2,
        }))
        ..observe(_ev(20, 'tool/call', {
          'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'shell',
        }))
        ..observe(_ev(21, 'tool/result', {
          'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'shell', 'text': 'ok',
        }))
        ..observe(_ev(30, 'assistant/message', {
          'turn': 1, 'messageId': 'r2', 'text': '',
          'reasoning': '第二段', 'reasoningChars': 2,
        }));
      final turn = tracker.build().single;
      final segment = segmentsOf(turn).single;
      expect([for (final g in segment.groups) g.step], [null, 2, null]);
      final identities = [
        for (final g in segment.groups) groupIdentityOf(g, 1),
      ];
      expect(identities.toSet().length, identities.length);
      expect(identities, ['1#think-seq:10', '1#tool:c2', '1#think-seq:30']);
    });

    test('step 迟到（null→35）不改变含工具组的 identity', () {
      final before = _toolRowsSegment([(110, 'c1', null)]);
      final after = _toolRowsSegment([(100, 'c1', 35)]);
      expect(
        groupIdentityOf(before.groups.single, 1),
        groupIdentityOf(after.groups.single, 1),
        reason: 'identity 按 callId，不看 step：补入 step 不重置组状态',
      );
    });

    test('补页把更早工具插到组首 → identity 变化（方案 D 的可接受失败模式）', () {
      final before = _toolRowsSegment([(110, 'c2', 2)]);
      final after = _toolRowsSegment([(100, 'c1', 2), (110, 'c2', 2)]);
      expect(
        groupIdentityOf(after.groups.single, 1),
        isNot(groupIdentityOf(before.groups.single, 1)),
        reason: 'identity 变 → Flutter 销毁旧 State、回落默认（不串状态）',
      );
    });
  });
}
