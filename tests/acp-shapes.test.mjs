// 真实会话里出现过的两种回执形态，必须解析出来，否则界面会把成功当“未恢复”。
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyState } from "../lib/activity.js";

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const ev = (type, time, data) => ({ type, time, data });

function call(callId, name, args, t = T0) {
  return ev("tool/call", t, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) });
}

function result(callId, text, isError = false, t = T0 + 10) {
  return ev("tool/result", t, {
    turn: 1,
    step: 1,
    message: { role: "tool", toolCallId: callId, isError, content: [{ type: "text", text }] },
  });
}

const fold = (events) => events.reduce((state, event) => applyEvent(state, event), emptyState());

test("decompress 回执用破折号时也算恢复成功", () => {
  const state = fold([
    call("c1", "compress", { content: "m00001–m00030 摘要" }),
    result("c1", "[Compressed m00001–m00030 → 1 block(s), ~12000 tokens saved.]"),
    call("c2", "decompress", { blockId: "b3" }, T0 + 20),
    result("c2", "[Block b3 content — 9 item(s)]", false, T0 + 30),
  ]);

  const restore = state.acp.ops.filter((op) => op.acp === "decompress").at(-1);
  assert.equal(restore.block, "b3");
  assert.equal(restore.status, "ok");
  assert.ok(state.acp.blocks.b3.restoredAt > 0, "块上要留下恢复时间");
  assert.equal(state.counts.errors, 0, "成功恢复不能计成错误");
});

test("compress 参数只有 content 时，区间从回执里补", () => {
  const state = fold([
    call("c1", "compress", { content: "m00004–m00057 B站任务章程" }),
    result("c1", "[Compressed m00004–m00057 → 1 block(s), ~55172 tokens saved. Excluded 8 protected message(s).]"),
  ]);

  const op = state.acp.ops.at(-1);
  assert.equal(op.range, "m00004–m00057");
  assert.equal(op.saved, 55172);
  assert.equal(op.status, "ok");
  assert.match(op.detail, /Compressed/, "溯源：原始回执留在 op 上");
  assert.match(op.args, /m00004/, "溯源：调用参数留在 op 上");
  assert.ok(op.at > 0, "溯源：记录解析时间");
});
