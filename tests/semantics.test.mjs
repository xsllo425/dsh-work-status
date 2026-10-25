/**
 * 语义层回归：阶段归组、上下文维护的识别与降级。
 *
 * 这些用例对应产品要求里的八个场景：同一目标连续读文件、重复测试一败、
 * 没有新文本的连续工具调用、billion-context 压缩/恢复/检索、未安装
 * billion-context、用户正文里出现 m00001、长会话高频事件与会话切换。
 * 只用确定性规则，不依赖模型，也不需要 billion-context 在场。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, emptyState } from "../lib/activity.js";

function ev(type, time, data) {
  return { type, seq: 1, time, data };
}

function replay(events) {
  return events.reduce((state, event) => applyEvent(state, event), emptyState());
}

function call(callId, name, args, step = 1) {
  return ev("tool/call", 0, { turn: 1, step, callId, name, arguments: JSON.stringify(args) });
}

function result(callId, time, failed = false, error = "") {
  return ev("tool/result", time, {
    turn: 1,
    step: 1,
    message: { toolCallId: callId, isError: failed },
    ...(failed && error ? { error: { message: error } } : {}),
  });
}

/** 一个带计划、正在做第一步的会话。 */
function start() {
  return [
    ev("turn/start", 1000, { turn: 1 }),
    ev("user/message", 1001, { source: { kind: "user" }, content: [{ type: "text", text: "把活动卡片重做成三层信息" }] }),
    ev("todo/write", 1002, { todos: [{ content: "重做卡片的信息层级", status: "in_progress" }] }),
    ev("step/start", 1010, { turn: 1, step: 1 }),
  ];
}

test("同一目标下连续读取、搜索多个文件：归到同一阶段，逐个留下证据", () => {
  const state = replay([
    ...start(),
    ev("assistant/message", 1020, {
      step: 1,
      message: {
        content: [
          { type: "text", text: "" },
          { type: "tool-call", id: "a", name: "read", arguments: '{"file_path":"E:/p/lib/client.js"}' },
          { type: "tool-call", id: "b", name: "grep", arguments: '{"pattern":"purposeOf","path":"E:/p/lib"}' },
          { type: "tool-call", id: "c", name: "read", arguments: '{"file_path":"E:/p/lib/activity.js"}' },
        ],
      },
    }),
    call("a", "read", { file_path: "E:/p/lib/client.js" }),
    result("a", 1100),
    call("b", "grep", { pattern: "purposeOf", path: "E:/p/lib" }),
    result("b", 1160),
    call("c", "read", { file_path: "E:/p/lib/activity.js" }),
    result("c", 1220),
  ]);

  assert.equal(state.stage.label, "重做卡片的信息层级");
  assert.equal(state.stage.kind, "todo");
  assert.equal(state.items.length, 3);
  for (const item of state.items) assert.equal(item.stage, "重做卡片的信息层级");
  assert.equal(new Set(state.items.map((item) => item.stageKey)).size, 1, "同一阶段应共享一个 key");
  assert.equal(state.counts.steps, 3);
  assert.equal(state.counts.ops, 3);
  assert.equal(state.counts.context, 0);
});

test("多次运行相同测试、其中一次失败：失败单独记账，后来成功仍算完成", () => {
  const state = replay([
    ...start(),
    call("t1", "run", { command: "node --test tests/" }),
    result("t1", 1500),
    call("t2", "run", { command: "node --test tests/" }),
    result("t2", 2200, true, "AssertionError: expected 26, got 25"),
  ]);

  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].status, "ok");
  assert.equal(state.items[1].status, "error");
  assert.equal(state.items[0].key, state.items[1].key, "同一条命令要能识别成同一件事");
  assert.equal(state.counts.steps, 1);
  assert.equal(state.counts.errors, 1);
  assert.match(state.items[1].err, /expected 26, got 25/);
});

test("模型连续调用工具、没有新解释文本：不拿上一段话冒充标题", () => {
  const state = replay([
    ...start(),
    ev("assistant/message", 1020, { step: 1, message: { content: [{ type: "text", text: "先看看插件怎么写的" }] } }),
    call("a", "read", { file_path: "E:/p/lib/client.js" }),
    result("a", 1100),
    ev("step/start", 1110, { turn: 1, step: 2 }),
    ev("assistant/message", 1120, { step: 2, message: { content: [{ type: "tool-call", id: "b", name: "bash", arguments: '{"command":"node --check lib/client.js"}' }] } }),
    call("b", "bash", { command: "node --check lib/client.js" }, 2),
    result("b", 1200),
  ]);

  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].why, "先看看插件怎么写的", "同一条消息里写的话可以用来说明这次操作");
  assert.equal(state.items[1].why, "", "没有新文本时必须是空，而不是复用旧段落");
  assert.equal(state.stage.label, "重做卡片的信息层级", "阶段仍跟着计划走");
});

test("billion-context 压缩 m00001–m00065：识别为上下文维护，不计入任务步数", () => {
  const state = replay([
    ...start(),
    ev("assistant/message", 1020, {
      step: 1,
      message: { content: [{ type: "tool-call", id: "z", name: "compress", arguments: '{"startId":"m00001","endId":"m00065"}' }] },
    }),
    call("z", "compress", { startId: "m00001", endId: "m00065" }),
    result("z", 9000),
  ]);

  assert.equal(state.items[0].kind, "context");
  assert.equal(state.items[0].acp, "compress");
  assert.equal(state.items[0].range, "m00001–m00065");
  assert.equal(state.counts.context, 1);
  assert.equal(state.counts.ops, 1);
  assert.equal(state.counts.steps, 0, "上下文维护不算完成的任务步");
  assert.equal(state.stage.label, "重做卡片的信息层级", "维护动作不改变任务阶段");
});

test("恢复上下文与检索历史：同样归入上下文维护，范围各自可读", () => {
  const state = replay([
    ...start(),
    call("d", "decompress", { startId: "m00001", endId: "m00065" }),
    result("d", 1100),
    call("s", "search_context", { query: "缓存命中率" }),
    result("s", 1200),
    call("k", "acp_status", {}),
    result("k", 1300),
  ]);

  assert.deepEqual(state.items.map((item) => item.kind), ["context", "context", "context"]);
  assert.deepEqual(state.items.map((item) => item.acp), ["decompress", "search_context", "acp_status"]);
  assert.equal(state.items[0].range, "m00001–m00065");
  assert.match(state.items[1].range, /缓存命中率/);
  assert.equal(state.counts.context, 3);
  assert.equal(state.counts.steps, 0);
});

test("不同安装形态：mcp 前缀的 ACP 工具同样识别，普通同名参数不误判", () => {
  const state = replay([
    ...start(),
    call("m", "mcp__billion-context__compress", { startId: "m00010", endId: "m00020" }),
    result("m", 1100),
    call("n", "billion_context.decompress", { startId: "m00010", endId: "m00020" }),
    result("n", 1200),
  ]);

  assert.equal(state.items[0].kind, "context");
  assert.equal(state.items[0].range, "m00010–m00020");
  assert.equal(state.items[1].kind, "context");
  assert.equal(state.counts.context, 2);
});

test("没有安装 billion-context：一切照旧，普通工具不受影响", () => {
  const state = replay([
    ...start(),
    call("a", "read", { file_path: "E:/p/README.md" }),
    result("a", 1100),
    call("b", "bash", { command: "node scripts/check-manifest.mjs" }),
    result("b", 1200),
  ]);

  assert.equal(state.items.length, 2);
  for (const item of state.items) {
    assert.equal(item.kind, "tool");
    assert.equal(item.acp, "");
    assert.equal(item.range, "");
  }
  assert.equal(state.counts.context, 0);
  assert.equal(state.counts.steps, 2);
});

test("用户正文里出现 m00001：只当文字，不触发任何上下文事件", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("user/message", 1001, {
      source: { kind: "user" },
      content: [{ type: "text", text: "m00001–m00065 这段被压缩了吗？" }],
    }),
  ]);

  assert.match(state.prompt, /m00001–m00065/);
  assert.equal(state.items.length, 0);
  assert.equal(state.counts.context, 0);
});

test("长会话高频事件与会话切换：条数有上限，换轮清空上一轮", () => {
  const events = [...start()];
  for (let index = 0; index < 100; index += 1) {
    events.push(call("c" + index, "read", { file_path: "E:/p/lib/f" + index + ".js" }));
    events.push(result("c" + index, 1100 + index));
  }
  const busy = replay(events);
  assert.equal(busy.items.length, 32, "卡片只留最近 32 条，全会话也不会把内存拖垮");
  assert.equal(busy.items[31].target, "E:/p/lib/f99.js");

  const switched = applyEvent(busy, ev("turn/start", 900000, { turn: 2 }));
  assert.equal(switched.turn, 2);
  assert.deepEqual(switched.items, []);
  assert.equal(switched.stage, null);
  assert.equal(switched.counts.steps, 0);
});
