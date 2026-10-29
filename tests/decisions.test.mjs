// 决策回合：只认事件里能证实的东西。七个场景对应验收清单。
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyState } from "../lib/activity.js";

const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);
const ev = (type, offset, data) => ({ type, time: T0 + offset, data });

const turnStart = (turn = 1) => ev("turn/start", 0, { turn });
const stepStart = (step, offset) => ev("step/start", offset, { step });
const turnEnd = (offset) => ev("turn/end", offset, { reason: { kind: "completed" } });
const say = (text, offset) => ev("assistant/message", offset, {
  message: { content: [{ type: "text", text }] },
});
const call = (callId, name, args, offset) => ev("tool/call", offset, { callId, name, arguments: JSON.stringify(args) });
const done = (callId, text, offset, isError = false) => ev("tool/result", offset, {
  message: { role: "tool", toolCallId: callId, isError, content: [{ type: "text", text }] },
});

const fold = (events) => events.reduce((state, event) => applyEvent(state, event), emptyState());

test("场景 1：写文件并在同一步验证，算实际成果", () => {
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    say("先改卡片文案，再跑测试。", 110),
    call("c1", "write_file", { path: "lib/client.js" }, 120),
    done("c1", "written", 200),
    call("c2", "ops_bash", { command: "node --test tests/" }, 210),
    done("c2", "pass 40", 400),
    stepStart(2, 500),
    turnEnd(600),
  ]);

  assert.equal(state.decisions.length, 1);
  const record = state.decisions[0];
  assert.equal(record.outcome, "progress");
  assert.match(record.reasons[0], /验证/);
  assert.deepEqual([...record.wrote], ["lib/client.js"]);
  assert.equal(state.decisionCounts.progress, 1);
});

test("场景 2：排除错误假设（调用失败但说明了路不通）算信息进展", () => {
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    call("c1", "read_file", { path: "missing.json" }, 120),
    done("c1", "ENOENT: no such file", 260, true),
    stepStart(2, 300),
    turnEnd(400),
  ]);

  const record = state.decisions.at(-1);
  assert.equal(record.outcome, "info");
  assert.match(record.reasons[0], /排除/);
  assert.equal(state.decisionCounts.info, 1);
});

test("场景 3：连续相同读取只标重复动作，不推断结果", () => {
  const repeat = (step, offset) => [
    stepStart(step, offset),
    call("c" + step, "read_file", { path: "package.json" }, offset + 10),
    done("c" + step, "name: demo", offset + 40),
  ];
  const state = fold([turnStart(), ...repeat(1, 100), ...repeat(2, 200), ...repeat(3, 300), turnEnd(400)]);

  const outcomes = state.decisions.map((record) => record.outcome);
  assert.deepEqual(outcomes, ["info", "repeat", "repeat"], "第一次读到东西算新证据，之后才算重复");
  assert.equal(state.decisionCounts.repeat, 2);
  assert.equal(state.decisions.length, 3);
  assert.equal(state.repeatRead.count, 3);
  assert.match(state.decisions.at(-1).reasons[0], /结果是否变化无法判断/);
});

test("重复读取不推断结果，修改参数、写入、失败、并行或压缩会中断连续性", () => {
  const readStep = (n, args = { path: "a.md" }, output = "one", failed = false) => [
    stepStart(n, n * 100), call("r" + n, "read_file", args, n * 100 + 10), done("r" + n, output, n * 100 + 20, failed),
  ];
  const changedResult = fold([turnStart(), ...readStep(1), ...readStep(2, { path: "a.md" }, "two"), turnEnd(400)]);
  assert.equal(changedResult.repeatRead.count, 2);
  assert.match(changedResult.decisions.at(-1).reasons[0], /无法判断/);
  const differentArgs = fold([turnStart(), ...readStep(1), ...readStep(2, { path: "a.md", offset: 10 }), turnEnd(400)]);
  assert.equal(differentArgs.repeatRead.count, 1);
  const interruptions = [
    [call("x", "write_file", { path: "a.md" }, 210), done("x", "written", 220)],
    [call("x", "compress", { startId: "m1", endId: "m2" }, 210), done("x", "done", 220)],
    [call("x", "read_file", { path: "a.md" }, 210), call("y", "read_file", { path: "a.md" }, 211), done("x", "a", 220), done("y", "a", 221)],
    [call("x", "read_file", { path: "a.md" }, 210), done("x", "error", 220, true)],
    [call("x", "read_file", {}, 210), done("x", "unknown", 220)],
  ];
  for (const middle of interruptions) {
    const state = fold([turnStart(), ...readStep(1), stepStart(2, 200), ...middle, ...readStep(3), turnEnd(500)]);
    assert.equal(state.repeatRead.count, 1);
    assert.notEqual(state.decisions.at(-1).outcome, "repeat");
  }
  const newTurn = fold([turnStart(), ...readStep(1), turnEnd(200), turnStart(2), ...readStep(1), turnEnd(300)]);
  assert.equal(newTurn.repeatRead.count, 1);
});

test("场景 4：长时间只有说明没有动作，记“形成决策”，不编造成果", () => {
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    say("决定先用只读方式核对配置，再决定要不要改。", 9000),
    stepStart(2, 9500),
    turnEnd(9600),
  ]);

  const record = state.decisions.at(-1);
  assert.equal(record.outcome, "decided");
  assert.match(record.reasons[0], /下一步/);
  assert.equal(record.wrote.length, 0);
});

test("场景 5：模型不提供思考内容时，只按可观察行为记，said 保持为空", () => {
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    call("c1", "ops_bash", { command: "ls" }, 120),
    done("c1", "a.txt b.txt", 200),
    stepStart(2, 300),
    turnEnd(400),
  ]);

  const record = state.decisions.at(-1);
  assert.equal(record.said, "");
  assert.ok(["info", "unknown"].includes(record.outcome));
  assert.equal(state.decisions.some((entry) => /思考|推理/.test(entry.said)), false);
});

test("场景 6：上下文压缩不进入决策统计，压缩后照常记回合", () => {
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    call("c1", "compress", { startId: "m00001", endId: "m00030" }, 120),
    done("c1", "[Compressed m00001–m00030 → 1 block(s), ~12000 tokens saved.]", 200),
    stepStart(2, 300),
    call("c2", "read_file", { path: "README.md" }, 320),
    done("c2", "hello", 420),
    stepStart(3, 500),
    turnEnd(600),
  ]);

  assert.equal(state.decisions.length, 1, "压缩那一步不该算决策回合");
  assert.equal(state.decisions[0].outcome, "info");
  assert.equal(state.acp.ops.length, 1);
});

test("场景 7：子代理在独立会话里计，不与主 Agent 重复累计", () => {
  const main = [turnStart(), stepStart(1, 100), call("c1", "spawn_agent", { prompt: "调研" }, 120), done("c1", "started", 180), stepStart(2, 300), turnEnd(400)];
  const child = [turnStart(), stepStart(1, 100), call("d1", "read_file", { path: "a.md" }, 120), done("d1", "x", 200), stepStart(2, 300), turnEnd(400)];

  const mainState = fold(main);
  const childState = fold(child);

  assert.equal(mainState.decisions.length, 1);
  assert.equal(childState.decisions.length, 1);
  assert.equal(childState.decisionCounts.decisions, 1, "子代理的账不并进主会话");
  assert.equal(mainState.decisionCounts.decisions, 1);
  assert.notEqual(mainState.decisions[0].tools[0].label, childState.decisions[0].tools[0].label);
});

test("长步骤：动作条被截断后仍认得这一步的动作，不再退化成空窗口", () => {
  // 32 条是动作条的上限：先塞满，再让第 33 条落在新的一步里。
  const filler = [];
  for (let i = 1; i <= 32; i++) {
    filler.push(call("f" + i, "read_file", { path: "filler" + i + ".md" }, 100 + i * 2), done("f" + i, "ok", 101 + i * 2));
  }
  const state = fold([
    turnStart(),
    stepStart(1, 100),
    ...filler,
    stepStart(2, 200),
    call("w1", "write_file", { path: "lib/real.js" }, 210),
    done("w1", "written", 220),
    stepStart(3, 300),
    turnEnd(400),
  ]);

  assert.equal(state.items.length, 32, "动作条本身仍按上限截断");
  const record = state.decisions.at(-1);
  assert.deepEqual([...record.wrote], ["lib/real.js"], "被截断后仍要认出这一步写了什么");
  assert.equal(record.outcome, "pending");
  assert.equal(state.decisionCounts.unknown, 0, "不该因为窗口空了而记成无法判断");
});
