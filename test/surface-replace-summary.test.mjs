// issue #99：compaction surface replay envelope（surfaceOp/sourceEventSeqs）必须随
// /history 与 SSE 共用的 summarizeEvent 摘要下发；旧客户端忽略新增顶层字段。
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEvent, surfaceWireFields } from "../lib/index.js";

const replay = {
  seq: 13283,
  type: "tool/result",
  time: 1794490887536,
  data: {
    turn: 148, step: 1,
    message: {
      role: "tool",
      source: { kind: "tool", callId: "call_00_mx03" },
      toolCallId: "call_00_mx03",
      content: [{ type: "text", text: "note 2312" }],
    },
  },
  sourceEventSeqs: [9142],
  surfaceOp: { op: "replace", startSeq: 9142, endSeq: 9142 },
};

test("issue #99: summarizeEvent 透传 replace surfaceOp/sourceEventSeqs", () => {
  const summary = summarizeEvent(replay);
  assert.equal(summary.seq, 13283);
  assert.equal(summary.type, "tool/result");
  assert.equal(summary.data.callId, "call_00_mx03");
  assert.deepEqual(summary.surfaceOp, { op: "replace", startSeq: 9142, endSeq: 9142 });
  assert.deepEqual(summary.sourceEventSeqs, [9142]);
});

test("issue #99: append/无 envelope 事件不凭空产生 surface 字段", () => {
  const append = summarizeEvent({ seq: 1, type: "tool/result", data: {}, surfaceOp: { op: "append", startSeq: 1, endSeq: 1 } });
  assert.deepEqual(append.surfaceOp, { op: "append", startSeq: 1, endSeq: 1 });
  const plain = summarizeEvent({ seq: 2, type: "assistant/message", data: { message: { content: [] } } });
  assert.equal("surfaceOp" in plain, false);
  assert.equal("sourceEventSeqs" in plain, false);
});

test("issue #99: surface 字段做只读校验（非法 op/seq 丢弃，source 去重截断）", () => {
  assert.deepEqual(
    surfaceWireFields({ surfaceOp: { op: "", startSeq: 1, endSeq: 1 }, sourceEventSeqs: [-1, 0, 2, 2, "x", 3.5] }),
    { sourceEventSeqs: [0, 2] },
  );
  assert.deepEqual(
    surfaceWireFields({ surfaceOp: { op: "replace", startSeq: "9142", endSeq: 9142 } }),
    { surfaceOp: { op: "replace", startSeq: 9142, endSeq: 9142 } },
  );
  const many = surfaceWireFields({ sourceEventSeqs: Array.from({ length: 100 }, (_, i) => i) });
  assert.equal(many.sourceEventSeqs.length, 64);
  assert.deepEqual(many.sourceEventSeqs.slice(0, 3), [0, 1, 2]);
});
