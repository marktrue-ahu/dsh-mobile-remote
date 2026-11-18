// issue #122：过程段/工具组折叠状态的**稳定键契约**（直接断言键值，不依赖 UI 状态）。
//
// 为什么不用位置索引 / 段首行 seq（实测矩阵，见提交说明）：
// - `si`（段索引）在「补页先加载后段 / 补边切更早的段 / 窗口裁剪删边界」时会整体
//   移动 → 用户已收起的段失配或串到别的段上；这正是 #122 的缺陷方向。
// - `startSeq`（段首行 seq）在 reasoning 迟到时会变小：实时路径用
//   `noteReasoningStart` 的首个 delta seq，历史回放只能用 message seq，导致同一段
//   实时/历史得到不同键；partial 轮的 startSeq 还是随窗口变化的合成锚点。
// - 开段插话边界 `boundarySeq` 只来自 durable 的真人 `user/message` seq，与行内容
//   无关，上述场景都不变。轮首段用 `head` 哨兵（不随 partial 轮锚点变化）。
//
// 本文件对应验收第 7 条（单测直接断言键/身份稳定性）；UI 行为回归见
// `issue122_interjection_fold_widget_test.dart`。
//
// issue #123（方案 D）后：**组折叠状态已移到 widget 层**（`ValueKey(identity)` 复用
// State），组身份 = `groupIdentityOf`（工具行按首个 callId、思考行按 step/seq），
// 不再有「段键:step」的组键，也不再有组级迁移/迁移键契约。本文件保留段键契约，
// 并把原「组键」断言改为「组身份」断言（唯一性/跨补页稳定性）。
import 'package:dsh_mobile_app/models.dart';
import 'package:dsh_mobile_app/turn_process.dart';
import 'package:flutter_test/flutter_test.dart';

ChatEvent ev(int seq, String type, [Map<String, dynamic>? data]) =>
    ChatEvent(seq: seq, type: type, data: data);

TurnProcessTracker trackerOf(List<ChatEvent> events) {
  final tracker = TurnProcessTracker();
  for (final event in events) {
    tracker.observe(event);
  }
  return tracker;
}

TurnProcess buildOf(TurnProcessTracker tracker) => tracker.build().single;

ProcessSegment segAt(TurnProcess turn, int rowSeq) => segmentsOf(turn)
    .firstWhere((segment) => segment.rows.any((row) => row.seq == rowSeq));

List<int?> boundarySeqsOf(TurnProcess turn) =>
    [for (final segment in segmentsOf(turn)) segment.boundarySeq];

void main() {
  test('T7a head 哨兵：轮首段 boundarySeq=null，插话只在末尾新增段', () {
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(4, 'tool/result', {'turn': 1, 'step': 1, 'callId': 'c1', 'text': 'ok'}),
    ]);
    var segments = segmentsOf(buildOf(tracker));
    expect(segments, hasLength(1));
    expect(segments.single.boundarySeq, isNull);
    expect(segmentKeyOf(segments.single, 1), '1:head');

    // 插话 + 后续 step 的过程行。
    tracker.observe(
      ev(6, 'user/message', {'text': '插话', 'sourceKind': 'user'}),
    );
    tracker.observe(
      ev(7, 'tool/call', {'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'read'}),
    );
    tracker.observe(
      ev(8, 'tool/result', {'turn': 1, 'step': 2, 'callId': 'c2', 'text': 'ok'}),
    );
    segments = segmentsOf(buildOf(tracker));
    expect(segments, hasLength(2));
    expect(
      segments[0].boundarySeq,
      isNull,
      reason: '轮首段的 head 哨兵永远不变——插话只会在它之后新增段',
    );
    expect(segmentKeyOf(segments[0], 1), '1:head');
    expect(segments[1].boundarySeq, 6, reason: '新段由 seq=6 的插话开启');
    expect(segmentKeyOf(segments[1], 1), '1:6');
  });

  test('T7b 契约：段键=轮号+开段边界；组身份=轮号+首工具 callId / 思考 step/seq', () {
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      // 无 step 的工具行：组键退化为 `x` 哨兵（旧内核/旧历史形态）。
      ev(3, 'tool/call', {'turn': 1, 'callId': 'c1', 'name': 'shell'}),
    ]);
    final turn = buildOf(tracker);
    final segment = segAt(turn, 3);
    expect(segmentKeyOf(segment, 1), '1:head');
    expect(
      groupIdentityOf(segment.groups.single, 1),
      '1#tool:c1',
      reason: '组身份按首个工具 callId（缺 step 也一样：identity 不看 step）',
    );

    final explicit = ProcessSegment(
      rows: [
        ProcessRow.tool(seq: 9, step: 2, callId: 'c9', toolName: 'shell'),
      ],
      boundarySeq: 8,
    );
    expect(segmentKeyOf(explicit, 3), '3:8');
    expect(groupIdentityOf(explicit.groups.single, 3), '3#tool:c9');
    // 纯思考组（无工具）：有 step 用 step，缺 step 用 seq（旧内核退化行）。
    final thinkingStep = ProcessSegment(
      rows: [
        ProcessRow.reasoning(seq: 9, step: 2, reasoning: '想', reasoningChars: 1),
      ],
    );
    expect(groupIdentityOf(thinkingStep.groups.single, 3), '3#think-step:2');
    final thinkingNull = ProcessSegment(
      rows: [
        ProcessRow.reasoning(seq: 9, reasoning: '想', reasoningChars: 1),
      ],
    );
    expect(groupIdentityOf(thinkingNull.groups.single, 3), '3#think-seq:9');
  });

  test('T7c 补页先加载后段（E）：后段 si 移动，稳定键不变', () {
    // 先只观察到插话 6 之后的行（模拟 live 窗口起点较晚）。
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(6, 'user/message', {'text': '插话', 'sourceKind': 'user'}),
      ev(7, 'tool/call', {'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'read'}),
      ev(8, 'tool/result', {'turn': 1, 'step': 2, 'callId': 'c2', 'text': 'ok'}),
    ]);
    var turn = buildOf(tracker);
    expect(segmentsOf(turn), hasLength(1));
    expect(segmentKeyOf(segAt(turn, 7), 1), '1:6');

    // 补页加载更早的过程行（早于边界 6）→ 前方多出一段。
    tracker.observe(
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
    );
    tracker.observe(
      ev(4, 'tool/result', {'turn': 1, 'step': 1, 'callId': 'c1', 'text': 'ok'}),
    );
    turn = buildOf(tracker);
    final segments = segmentsOf(turn);
    expect(segments, hasLength(2));
    expect(boundarySeqsOf(turn), [null, 6]);
    expect(
      segments.indexWhere((s) => s.rows.any((r) => r.seq == 7)),
      1,
      reason: '前方补进一段后，后段的位置索引从 0 后移到 1——旧键会失配',
    );
    expect(
      segmentKeyOf(segAt(turn, 7), 1),
      '1:6',
      reason: '稳定键只由开段插话边界决定，不随位置索引移动',
    );
  });

  test('T7d 补边切更早的段（I）：后段内容不变但 si 移动，键不变', () {
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(5, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c2', 'name': 'shell'}),
      ev(6, 'user/message', {'text': '插话', 'sourceKind': 'user'}),
      ev(7, 'tool/call', {'turn': 1, 'step': 2, 'callId': 'c3', 'name': 'read'}),
    ]);
    var turn = buildOf(tracker);
    expect(boundarySeqsOf(turn), [null, 6]);
    final identityBefore = groupIdentityOf(
      segAt(turn, 7).groups.firstWhere((g) => g.rows.any((r) => r.seq == 7)),
      1,
    );
    expect(identityBefore, '1#tool:c3');
    expect(segmentsOf(turn).indexWhere((s) => s.rows.any((r) => r.seq == 7)),
        1);

    // 更早的段内部补进一条插话（乱序/补页），后段内容完全不变。
    tracker.observe(
      ev(4, 'user/message', {'text': '迟到插话', 'sourceKind': 'user'}),
    );
    turn = buildOf(tracker);
    expect(boundarySeqsOf(turn), [null, 4, 6]);
    expect(
      segmentsOf(turn).indexWhere((s) => s.rows.any((r) => r.seq == 7)),
      2,
      reason: '切更早的段会让后段 si 从 1 变 2（旧组键 1:2 会失配）',
    );
    expect(
      groupIdentityOf(
        segAt(turn, 7).groups.firstWhere((g) => g.rows.any((r) => r.seq == 7)),
        1,
      ),
      identityBefore,
      reason: '组身份由成员决定（不含段键）：更早段被切分不会改变它',
    );
  });

  test('T7e reasoning 迟到（C）：稳定键不变，startSeq 会变小', () {
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(10, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(11, 'tool/result', {'turn': 1, 'step': 1, 'callId': 'c1', 'text': 'ok'}),
    ]);
    var turn = buildOf(tracker);
    expect(segAt(turn, 10).startSeq, 10);
    expect(segmentKeyOf(segAt(turn, 10), 1), '1:head');

    // 实时路径：reasoning 首个 delta seq=5 小于已观察到的首行 seq=10。
    tracker.noteReasoningStart(1, 1, 5);
    tracker.observe(ev(12, 'assistant/message', {
      'turn': 1,
      'step': 1,
      'reasoning': '晚到的思考',
      'reasoningChars': 5,
      'text': '',
    }));
    turn = buildOf(tracker);
    expect(
      segAt(turn, 10).startSeq,
      5,
      reason: 'reasoning 迟到会让段首行 seq 从 10 变 5——startSeq 不适合做键',
    );
    expect(segmentKeyOf(segAt(turn, 10), 1), '1:head');
    expect(groupIdentityOf(segAt(turn, 10).groups.single, 1), '1#tool:c1');
  });

  test('T7f 历史↔实时（H）：键一致；startSeq 因 reasoning 迟到不一致', () {
    final durable = [
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(10, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(11, 'tool/result', {'turn': 1, 'step': 1, 'callId': 'c1', 'text': 'ok'}),
      ev(12, 'assistant/message', {
        'turn': 1,
        'step': 1,
        'reasoning': '晚到的思考',
        'reasoningChars': 5,
        'text': '',
      }),
    ];
    // 实时：assistant/message 落定前已记录首 delta seq=5。
    final live = TurnProcessTracker();
    for (final event in durable) {
      if (event.type == 'assistant/message') {
        live.noteReasoningStart(1, 1, 5);
      }
      live.observe(event);
    }
    // 历史：ChatScreen `_load` 真实顺序是倒序回放，且没有 delta 记录。
    final history = trackerOf(durable.reversed.toList());

    final liveTurn = buildOf(live);
    final historyTurn = buildOf(history);
    expect(segmentKeyOf(segAt(liveTurn, 10), 1), '1:head');
    expect(
      segmentKeyOf(segAt(historyTurn, 10), 1),
      '1:head',
      reason: '同一批 durable 事件，实时与历史回放必须得到同一个段键',
    );
    expect(segAt(liveTurn, 10).startSeq, 5);
    expect(
      segAt(historyTurn, 10).startSeq,
      10,
      reason: 'startSeq 在实时/历史不一致（所以 #122 不用它做键）',
    );
  });

  test('T7g partial 轮：head 哨兵不随合成锚点变化', () {
    // turn 1 完整、turn 2 缺 turn/start（模拟历史窗口从轮中段开始）。
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '问题', 'sourceKind': 'user'}),
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(4, 'turn/end', {'turn': 1, 'reason': {'kind': 'completed'}}),
      ev(20, 'tool/call', {'turn': 2, 'step': 1, 'callId': 'c9', 'name': 'shell'}),
    ]);
    var partial = tracker.build().firstWhere((turn) => turn.turn == 2);
    expect(partial.partial, isTrue);
    expect(partial.startSeq, 20, reason: 'partial 轮用最早可观察事件作合成锚点');
    expect(segmentKeyOf(segmentsOf(partial).single, 2), '2:head');

    // 补页加载更早的 partial 轮事件 → 合成锚点前移。
    tracker.observe(
      ev(15, 'tool/call', {'turn': 2, 'step': 1, 'callId': 'c8', 'name': 'shell'}),
    );
    partial = tracker.build().firstWhere((turn) => turn.turn == 2);
    expect(
      partial.startSeq,
      15,
      reason: '合成锚点随窗口变化——若用 startSeq 作键，partial 轮会失配',
    );
    expect(
      segmentKeyOf(segmentsOf(partial).single, 2),
      '2:head',
      reason: 'head 哨兵与合成锚点无关，partial 轮的段键也稳定',
    );
  });

  test('T7h 多条插话：每段 boundarySeq=开段插话 seq，历史倒序与实时一致', () {
    final events = [
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(4, 'tool/result', {'turn': 1, 'step': 1, 'callId': 'c1', 'text': 'ok'}),
      ev(5, 'user/message', {'text': '插话1', 'sourceKind': 'user'}),
      ev(6, 'tool/call', {'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'read'}),
      ev(7, 'tool/result', {'turn': 1, 'step': 2, 'callId': 'c2', 'text': 'ok'}),
      ev(9, 'user/message', {'text': '插话2', 'sourceKind': 'user'}),
      ev(10, 'tool/call', {'turn': 1, 'step': 3, 'callId': 'c3', 'name': 'read'}),
      ev(11, 'tool/result', {'turn': 1, 'step': 3, 'callId': 'c3', 'text': 'ok'}),
    ];
    final live = buildOf(trackerOf(events));
    final history = buildOf(trackerOf(events.reversed.toList()));
    for (final turn in [live, history]) {
      expect(boundarySeqsOf(turn), [null, 5, 9]);
      final segments = segmentsOf(turn);
      expect(
        [for (var i = 0; i < segments.length; i++) segmentKeyOf(segments[i], 1)],
        ['1:head', '1:5', '1:9'],
      );
      // 组身份跨段使用同一套规则（不含段键）：历史倒序/实时一致，且跨段唯一。
      expect(
        [
          for (var i = 0; i < segments.length; i++)
            groupIdentityOf(segments[i].groups.single, 1),
        ],
        ['1#tool:c1', '1#tool:c2', '1#tool:c3'],
      );
    }
  });

  test('已知局限 J：窗口裁剪删边界导致段合并时，旧段键无法保持', () {
    // 该用例保留为**边界记录**（skip）：存活的轮被 pruneBefore 删掉内部插话边界后，
    // 两个段会合并成一个，原段本身消失——si/startSeq/边界键都保不住。当前产品行为
    // 下这与手动折叠状态「离开会话即失」同属可接受损失，但 reviewer 应知道它没被解决。
    final tracker = trackerOf([
      ev(1, 'turn/start', {'turn': 1}),
      ev(2, 'user/message', {'text': '提示词', 'sourceKind': 'user'}),
      ev(3, 'tool/call', {'turn': 1, 'step': 1, 'callId': 'c1', 'name': 'shell'}),
      ev(5, 'user/message', {'text': '插话1', 'sourceKind': 'user'}),
      ev(7, 'tool/call', {'turn': 1, 'step': 2, 'callId': 'c2', 'name': 'read'}),
      ev(8, 'user/message', {'text': '插话2', 'sourceKind': 'user'}),
      ev(10, 'tool/call', {'turn': 1, 'step': 3, 'callId': 'c3', 'name': 'read'}),
    ]);
    expect(boundarySeqsOf(buildOf(tracker)), [null, 5, 8]);
    tracker.pruneBefore(7); // 只删 <7 的插话边界，保留轮/行
    final pruned = buildOf(tracker);
    expect(boundarySeqsOf(pruned), [null, 8]);
    expect(segmentKeyOf(segAt(pruned, 10), 1), '1:8');
  }, skip: '已知局限：窗口裁剪删边界后段会合并、原段消失，任何键都无法保持；'
      '等窗口裁剪策略调整后再解决。保留本用例记录该边界。');
}
