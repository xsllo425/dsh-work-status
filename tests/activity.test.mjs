/**
 * Fold semantics of the `activity` projection unit.
 *
 * The fold is the whole Host half, so it is tested without Cordis: a small
 * synthetic log is replayed through `applyEvent` and the resulting record is
 * checked for the two things the card renders — what happened, and what is
 * queued next. Run with `node --test tests/`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVITY_KEY, activityProjection, applyEvent, describeCall, emptyState, turnOps } from "../lib/activity.js";

/** Build one log event with a plausible envelope. */
function ev(type, time, data) {
  return { type, seq: 1, time, data };
}

/** Replay a list of events over the empty record. */
function replay(events) {
  return events.reduce((state, event) => applyEvent(state, event), emptyState());
}

test("the projection registers the documented key and carries a wire view", () => {
  assert.equal(ACTIVITY_KEY, "workStatus");
  assert.equal(activityProjection.key, "workStatus");
  assert.equal(activityProjection.stateVersion, 15);
  assert.equal(typeof activityProjection.stateSchema.parse, "function");
  assert.equal(typeof activityProjection.wire.view, "function");
  const blank = emptyState();
  assert.equal(activityProjection.wire.view(blank), blank);
});

test("a turn start clears the previous turn and starts thinking", () => {
  const state = replay([ev("turn/start", 1000, { turn: 3 })]);
  assert.equal(state.turn, 3);
  assert.equal(state.phase, "thinking");
  assert.equal(state.startedAt, 1000);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.plan, []);
});

test("tool calls accumulate in order and finish with their outcome", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("step/start", 1010, { turn: 1, step: 1 }),
    ev("tool/call", 1020, { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"file_path":"C:/work/a/b/client.js"}' }),
    ev("tool/result", 1120, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }),
    ev("tool/call", 1130, { turn: 1, step: 1, callId: "c2", name: "bash", arguments: '{"command":"npm test"}' }),
    ev("tool/result", 1230, { turn: 1, step: 1, message: { toolCallId: "c2", isError: true } }),
  ]);
  assert.equal(state.phase, "thinking");
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].name, "read");
  assert.equal(state.items[0].target, "C:/work/a/b/client.js");
  assert.equal(state.items[0].status, "ok");
  assert.equal(state.items[0].t1, 1120);
  assert.equal(state.items[1].name, "bash");
  assert.equal(state.items[1].target, "npm test");
  assert.equal(state.items[1].status, "error");
  assert.equal(state.counts.tools, 2);
  assert.equal(state.counts.errors, 1);
});

test("the tool-call blocks of an assistant message are the upcoming plan", () => {
  const plan = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: "text", text: "I will read the file first.\n" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"lib/client.js"}' },
          { type: "tool-call", id: "c2", name: "grep", arguments: '{"pattern":"useProjection"}' },
        ],
      },
    }),
  ]);
  assert.equal(plan.phase, "thinking");
  assert.equal(plan.plan.length, 2);
  assert.equal(plan.plan[0].name, "read");
  assert.equal(plan.plan[0].target, "lib/client.js");
  assert.equal(plan.plan[0].kind, "path");
  assert.equal(plan.draft, "I will read the file first.");
  assert.equal(plan.counts.steps, 0, "步骤数只统计真正完成的工具调用");

  const promoted = applyEvent(plan, ev("tool/call", 1200, { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"lib/client.js"}' }));
  assert.equal(promoted.plan.length, 1);
  assert.equal(promoted.plan[0].id, "c2");
  assert.equal(promoted.items.length, 1);
  assert.equal(promoted.items[0].status, "running");
});

test("a text-only assistant message is the writing phase and keeps a preview", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "Here is the   answer\nthat matters." }] },
    }),
  ]);
  assert.equal(state.phase, "writing");
  assert.equal(state.draft, "Here is the answer\nthat matters.");
});

test("a point-by-point answer keeps its line breaks in the preview", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: {
        content: [{
          type: "text",
          text: "改了三处：\n\n1. 背景换成表面色\n2. 边框加粗\n3. 加了层级",
        }],
      },
    }),
  ]);
  assert.equal(state.phase, "writing");
  assert.equal(state.draft, "改了三处：\n1. 背景换成表面色\n2. 边框加粗\n3. 加了层级");
});

test("turn end closes the turn and maps a hard failure to the error phase", () => {
  const done = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("tool/call", 1010, { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "completed" } }),
  ]);
  assert.equal(done.phase, "done");
  assert.equal(done.endedAt, 2000);
  assert.deepEqual(done.plan, []);

  const failed = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "error" } }),
  ]);
  assert.equal(failed.phase, "error");

  const stopped = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("turn/end", 2000, { turn: 1, reason: { kind: "aborted" } }),
  ]);
  assert.equal(stopped.phase, "aborted");
});

test("the user's instruction is remembered so the card can frame the work", () => {
  const state = replay([
    ev("user/message", 900, {
      content: [{ type: "text", text: "  把卡片改成按我的指令显示\n再发一版  " }],
      role: "user",
      source: { kind: "user", rpcId: "r1" },
    }),
    ev("turn/start", 1000, { turn: 1 }),
    ev("tool/call", 1010, { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" }),
  ]);
  assert.equal(state.prompt, "把卡片改成按我的指令显示 再发一版");
  // A later turn keeps the instruction, so the card never loses the frame.
  const next = applyEvent(state, ev("turn/start", 5000, { turn: 2 }));
  assert.equal(next.prompt, "把卡片改成按我的指令显示 再发一版");
  // An event without a text block does not clear it.
  assert.equal(applyEvent(state, ev("user/message", 5100, { content: [], source: { kind: "user" } })), state);
  const long = replay([ev("user/message", 900, { content: [{ type: "text", text: "要".repeat(400) }], source: { kind: "user" } })]);
  assert.ok(long.prompt.length <= 120, String(long.prompt.length));
  assert.ok(long.prompt.endsWith("…"));
});

test("injected context never becomes the instruction shown on the card", () => {
  const injected = [
    { kind: "runtime-context", form: "snapshot" },
    { kind: "time-context", form: "snapshot" },
    { kind: "skill-catalog", form: "catalog" },
    { kind: "plugin:openviking-memory", plugin: "openviking-memory", form: "recall" },
  ];
  for (const source of injected) {
    const state = replay([
      ev("user/message", 900, {
        content: [{ type: "text", text: "Time sampled while preparing turn 13, step 1: 2026-10-25T18:42:37+08:00" }],
        role: "user",
        source,
      }),
    ]);
    assert.equal(state.prompt, "", source.kind);
  }
  // A message with no source at all is not provably the person either.
  const sourceless = replay([ev("user/message", 900, { content: [{ type: "text", text: "hello" }], role: "user" })]);
  assert.equal(sourceless.prompt, "");
});

test("ignored events return the same reference", () => {
  const state = replay([ev("turn/start", 1000, { turn: 1 }), ev("step/start", 1010, { turn: 1, step: 1 })]);
  assert.equal(applyEvent(state, ev("user/message", 1100, {})), state);
  assert.equal(applyEvent(state, ev("step/end", 1100, { turn: 1, step: 1 })), state);
  assert.equal(applyEvent(state, ev("request/header", 1100, {})), state);
});

test("describeCall reads the informative argument and labels its kind", () => {
  assert.deepEqual(describeCall('{"file_path":"C:/a/b/c.js"}'), { target: "C:/a/b/c.js", kind: "path" });
  assert.deepEqual(describeCall('{"command":"git status --short"}'), { target: "git status --short", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: 'cd "C:/work dir" && npm test' })), { target: "npm test", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: "Set-Location C:/x; pwsh -File a.ps1" })), { target: "pwsh -File a.ps1", kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: 'NODE="/x/node" && "$NODE" --test' })), { target: '"$NODE" --test', kind: "command" });
  assert.deepEqual(describeCall(JSON.stringify({ command: "python - <<'PY'\nimport io\nPY" })), { target: "python", kind: "command" });
  assert.deepEqual(describeCall('{"pattern":"useProjection","path":"lib"}'), { target: "useProjection", kind: "query" });
  assert.deepEqual(describeCall('{"url":"https://example.com/x"}'), { target: "https://example.com/x", kind: "url" });
  assert.deepEqual(describeCall('{"todos":[{"content":"a"}]}'), { target: '[{"content":"a"}]', kind: "list" });
  assert.deepEqual(describeCall("not json at all"), { target: "not json at all", kind: "other" });
  assert.deepEqual(describeCall(""), { target: "", kind: "other" });
  assert.deepEqual(describeCall(undefined), { target: "", kind: "other" });
  assert.deepEqual(describeCall('{"count":3}'), { target: "3", kind: "other" });
});

test("a path target keeps its tail and a long command keeps its head", () => {
  const longPath = "C:/Users/someone/Documents/projects/deepseek-harness/skill/work/lib/client.js".repeat(2);
  const pathCall = describeCall(JSON.stringify({ file_path: longPath }));
  assert.equal(pathCall.kind, "path");
  assert.ok(pathCall.target.startsWith("…"), pathCall.target);
  assert.ok(pathCall.target.endsWith("client.js"), pathCall.target);
  assert.ok(pathCall.target.length <= 120, pathCall.target);

  const longCommand = `node -e "console.log('a'.repeat(200))" && npm test -- --grep ${"x".repeat(80)}`;
  const commandCall = describeCall(JSON.stringify({ command: longCommand }));
  assert.equal(commandCall.kind, "command");
  assert.ok(commandCall.target.endsWith("…"), commandCall.target);
  assert.ok(commandCall.target.length <= 120, commandCall.target);
});

test("each tool call records why the agent did it", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("assistant/message", 1100, {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先确认卡片头部现在渲染的是什么，才好决定换哪一行。" },
          { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ file_path: "lib/client.js" }) },
        ],
      },
    }),
    ev("tool/call", 1200, { turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ file_path: "lib/client.js" }) }),
    ev("tool/result", 1400, { turn: 1, step: 1, message: { toolCallId: "c1", role: "tool", content: [] } }),
  ]);
  const item = state.items.at(-1);
  assert.equal(item.status, "ok");
  assert.match(item.why, /决定换哪一行/);
  assert.ok(item.why.length <= 80);
});

test("a call made without a stated reason leaves the reason empty", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("tool/call", 1200, { turn: 1, step: 1, callId: "c2", name: "grep", arguments: JSON.stringify({ pattern: "useProjection" }) }),
  ]);
  const item = state.items.at(-1);
  assert.equal(item.why, "");
});

test("each step says which todo it is serving", () => {
  const todos = [
    { content: "把卡片改成常驻一行", status: "in_progress" },
    { content: "发版并写说明", status: "pending" },
  ];
  const state = replay([
    ev("turn/start", 1000, { turn: 4 }),
    ev("todo/write", 1050, { todos }),
    ev("tool/call", 1100, { turn: 4, step: 1, callId: "c1", name: "edit", arguments: JSON.stringify({ file_path: "lib/client.js", old_string: "a", new_string: "b" }) }),
  ]);
  assert.equal(state.items[0].task, "把卡片改成常驻一行");
  assert.equal(state.todos.length, 2);
});

test("a step taken before any todo exists has no task", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ file_path: "lib/client.js" }) }),
  ]);
  assert.equal(state.items[0].task, "");
});

test("a new turn forgets the previous turn's todos", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("todo/write", 1050, { todos: [{ content: "甲", status: "in_progress" }] }),
    ev("turn/start", 2000, { turn: 2 }),
  ]);
  assert.deepEqual(state.todos, []);
});

test("步样本把模型与工具分开记，按类别归档，等待与上下文维护不进基线", () => {
  const events = [ev("turn/start", 0, { turn: 1 }), ev("step/start", 0, {})];
  for (let index = 0; index < 40; index += 1) {
    const at = 1000 * (index + 1);
    events.push(ev("step/start", at, {}));
    events.push(ev("tool/call", at + 200, { callId: String(index), name: "ops_bash", arguments: {} }));
    events.push(ev("tool/result", at + 800, { message: { toolCallId: String(index), isError: false, content: [] } }));
  }
  // 一次网络调用与一次等人回答：前者进 network 基线，后者完全不进。
  events.push(ev("step/start", 90000, {}));
  events.push(ev("tool/call", 90000, { callId: "net", name: "web_fetch", arguments: {} }));
  events.push(ev("tool/result", 93000, { message: { toolCallId: "net", isError: false, content: [] } }));
  events.push(ev("step/start", 94000, {}));
  events.push(ev("tool/call", 94000, { callId: "wait", name: "ask_user_question", arguments: {} }));
  events.push(ev("tool/result", 99000, { message: { toolCallId: "wait", isError: false, content: [] } }));
  // 一次压缩：系统维护，整步不进任何耗时基线。
  events.push(ev("step/start", 100000, {}));
  events.push(ev("tool/call", 100200, { callId: "ctx", name: "compress", arguments: {} }));
  events.push(ev("tool/result", 100900, { message: { toolCallId: "ctx", isError: false, content: [] } }));
  events.push(ev("turn/end", 102000, { turn: 1, reason: "completed" }));
  const state = replay(events);

  const model = state.stepStats["model|ops_bash"];
  const tool = state.stepStats["tool|local|ops_bash"];
  assert.ok(Array.isArray(model), "模型推理样本按签名存一份");
  assert.ok(Array.isArray(tool), "工具耗时按类别 + 签名单独存");
  assert.ok(model.length <= 30 && tool.length <= 30, "每类样本都有上限");
  assert.ok(model.every((ms) => ms === 200), "模型段 = 步开始到首个工具调用");
  assert.ok(tool.every((ms) => ms === 600), "工具段 = 调用到结果");

  assert.ok(Array.isArray(state.stepStats["tool|network|web_fetch"]), "网络调用单独归入 network");
  assert.equal(state.stepStats["model|ask_user_question"], undefined, "等人回答的步不进模型基线");
  assert.equal(state.stepStats["model|compress"], undefined, "上下文维护的步不进基线");
  assert.equal(state.stepStats["tool|system|compress"], undefined, "系统维护不产生工具基线");
});

test("model time is step start to the step's message; tool time is the union of calls", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("step/start", 1000, { step: 1 }),
    ev("assistant/message", 4000, { step: 1, message: { content: [{ type: "tool-call", id: "a", name: "read", arguments: "{}" }, { type: "tool-call", id: "b", name: "grep", arguments: "{}" }] } }),
    ev("tool/call", 4000, { callId: "a", name: "read", arguments: "{}" }),
    ev("tool/call", 4500, { callId: "b", name: "grep", arguments: "{}" }),
    ev("tool/result", 5000, { message: { toolCallId: "a" } }),
    ev("tool/result", 6000, { message: { toolCallId: "b" } }),
    ev("step/start", 6000, { step: 2 }),
    ev("assistant/message", 9000, { step: 2, message: { content: [{ type: "text", text: "完成" }] } }),
    ev("turn/end", 9000, { reason: { kind: "completed" } }),
  ]);
  // 3s + 3s of generation, the final text-only step included.
  assert.equal(state.modelMs, 6000);
  // two overlapping calls 4.0–5.0 and 4.5–6.0 occupy 2s, not 2.5s.
  assert.equal(state.toolMs, 2000);
  assert.equal(state.toolOpen, 0);
});

test("a new turn starts its timers at zero and folds the old turn, context ops included", () => {
  const state = replay([
    ev("turn/start", 1000, { turn: 1 }),
    ev("step/start", 1000, { step: 1 }),
    ev("assistant/message", 2000, { step: 1, message: { content: [{ type: "tool-call", id: "c", name: "compress", arguments: "{}" }] } }),
    ev("tool/call", 2000, { callId: "c", name: "compress", arguments: "{}" }),
    ev("tool/result", 2500, { message: { toolCallId: "c", content: [{ type: "text", text: "ok" }] } }),
    ev("turn/end", 3000, { reason: { kind: "completed" } }),
    ev("turn/start", 5000, { turn: 2 }),
  ]);
  assert.equal(state.modelMs, 0);
  assert.equal(state.toolMs, 0);
  assert.equal(state.prev.turn, 1);
  assert.equal(state.prev.modelMs, 1000);
  assert.equal(state.prev.toolMs, 500);
  assert.equal(state.prev.ctx.length, 1);
  // the session ledger keeps the op, but it belongs to turn 1 only.
  assert.equal(state.acp.ops.length, 1);
  assert.equal(turnOps(state).length, 0);
});

test("会话总账跨轮累计，逐轮记录带起止、目标、模型回合与推理/工具用时", () => {
  const turn = (n, t0) => [
    ev("turn/start", t0, { turn: n }),
    ev("step/start", t0, { step: 1 }),
    ev("user/message", t0 + 1, { content: [{ type: "text", text: "第" + n + "轮的问题" }], source: { kind: "user" }, role: "user" }),
    ev("assistant/message", t0 + 2000, { step: 1, message: { content: [{ type: "tool-call", id: "c" + n, name: "read", arguments: "{}" }] } }),
    ev("tool/call", t0 + 2000, { callId: "c" + n, name: "read", arguments: "{}" }),
    ev("tool/result", t0 + 2500, { message: { toolCallId: "c" + n } }),
    ev("step/start", t0 + 2500, { step: 2 }),
    ev("assistant/message", t0 + 4000, { step: 2, message: { content: [{ type: "text", text: "好" }] } }),
    ev("turn/end", t0 + 4000, { reason: { kind: "completed" } }),
  ];
  const state = replay([...turn(1, 1000), ...turn(2, 10000)]);
  assert.equal(state.totals.turns, 2);
  assert.equal(state.totals.rounds, 4);
  assert.equal(state.totals.ops, 2);
  assert.equal(state.totals.modelMs, 7000);
  assert.equal(state.totals.toolMs, 1000);
  assert.equal(state.totals.wallMs, 8000);
  const last = state.history.at(-1);
  assert.equal(last.turn, 2);
  assert.equal(last.startedAt, 10000);
  assert.equal(last.endedAt, 14000);
  assert.equal(last.rounds, 2);
  assert.equal(last.modelMs, 3500);
  assert.equal(last.toolMs, 500);
  assert.equal(last.phase, "done");
});
