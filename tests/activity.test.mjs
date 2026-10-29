/**
 * 宿主端 `activity` 投影的折叠规则。
 *
 * 投影就是整个宿主端，所以不起 Cordis：用下面几个小函数拼出一段会话日志，从空记录开始
 * 逐条 applyEvent，再检查卡片要画的东西——发生了什么、接下来要做什么、这一轮为什么停。
 * 跑法：node --test tests/
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVITY_KEY, activityProjection, applyEvent, describeCall, emptyState, turnOps } from "../lib/activity.js";

// ── 拼日志用的小函数 ─────────────────────────────────────────────────────

/** 一条日志事件；seq 对折叠没有意义，统一写 0。 */
const at = (type, time, data = {}) => ({ type, seq: 0, time, data });
/** 从空记录开始依次折叠（参数可以嵌套数组，方便拼整段流程）。 */
const play = (...events) => events.flat(Infinity).reduce((state, event) => applyEvent(state, event), emptyState());
const json = (value) => (typeof value === "string" ? value : JSON.stringify(value));

const begin = (turn, time) => at("turn/start", time, { turn });
const finish = (time, kind, extra = {}) => at("turn/end", time, { reason: { kind, ...extra } });
const call = (id, name, args, time, extra = {}) => at("tool/call", time, { callId: id, name, arguments: json(args), ...extra });
const done = (id, time, message = {}) => at("tool/result", time, { message: { toolCallId: id, ...message } });
/** 模型这一步说的话：text("…") 与 wants(id, name, args) 混排。 */
const reply = (time, blocks, extra = {}) => at("assistant/message", time, { message: { content: blocks }, ...extra });
const text = (value) => ({ type: "text", text: value });
const wants = (id, name, args) => ({ type: "tool-call", id, name, arguments: json(args) });
const asked = (time, value, source = { kind: "user" }) =>
  at("user/message", time, { role: "user", source, content: [text(value)] });

// ── 投影本身 ─────────────────────────────────────────────────────────────

test("投影登记在 workStatus 键下，版本号与线上视图都在", () => {
  assert.equal(ACTIVITY_KEY, "workStatus");
  assert.equal(activityProjection.key, ACTIVITY_KEY);
  assert.equal(activityProjection.stateVersion, 21);
  assert.equal(typeof activityProjection.stateSchema.parse, "function");
  const blank = emptyState();
  assert.strictEqual(activityProjection.wire.view(blank), blank, "线上视图原样转发记录");
});

test("新一轮开始：清空上一轮，进入思考", () => {
  const before = play(begin(1, 50), call("x", "read", { path: "a.md" }, 60));
  const state = applyEvent(before, begin(7, 4200));
  assert.deepEqual(
    { turn: state.turn, phase: state.phase, startedAt: state.startedAt, items: state.items, plan: state.plan },
    { turn: 7, phase: "thinking", startedAt: 4200, items: [], plan: [] },
  );
});

// ── 工具调用 ─────────────────────────────────────────────────────────────

test("工具调用按先后记下，结果回来时标成功或失败并记结束时刻", () => {
  const state = play(
    begin(2, 0),
    at("step/start", 5, { turn: 2, step: 1 }),
    call("g", "grep", { pattern: "renderPanel", path: "src" }, 10),
    done("g", 70),
    call("w", "write", { file_path: "docs/notes.md", content: "…" }, 80),
    done("w", 95, { isError: true }),
  );
  assert.equal(state.phase, "thinking", "两个调用都结账后回到思考");
  assert.deepEqual(
    state.items.map(({ name, target, status, t1 }) => ({ name, target, status, t1 })),
    [
      { name: "grep", target: "renderPanel", status: "ok", t1: 70 },
      { name: "write", target: "docs/notes.md", status: "error", t1: 95 },
    ],
  );
  assert.deepEqual([state.counts.tools, state.counts.errors], [2, 1]);
});

test("模型一次声明的几个调用就是接下来的计划；真正开跑一个就从计划里挪走一个", () => {
  const announced = play(
    begin(1, 0),
    reply(30, [
      text("先看配置，再搜一下用法。\n"),
      wants("p1", "read", { file_path: "config/app.json" }),
      wants("p2", "web_fetch", { url: "https://docs.example.org/guide" }),
    ], { turn: 1, step: 1 }),
  );
  assert.equal(announced.phase, "thinking");
  assert.deepEqual(
    announced.plan.map(({ id, name, target, kind }) => ({ id, name, target, kind })),
    [
      { id: "p1", name: "read", target: "config/app.json", kind: "path" },
      { id: "p2", name: "web_fetch", target: "https://docs.example.org/guide", kind: "url" },
    ],
  );
  assert.equal(announced.draft, "先看配置，再搜一下用法。");
  assert.equal(announced.counts.steps, 0, "只声明、没跑完的调用不算步数");

  const started = applyEvent(announced, call("p1", "read", { file_path: "config/app.json" }, 40, { turn: 1, step: 1 }));
  assert.deepEqual(started.plan.map((entry) => entry.id), ["p2"]);
  assert.deepEqual(started.items.map((item) => [item.id, item.status]), [["p1", "running"]]);
});

// ── 写回答 ───────────────────────────────────────────────────────────────

test("只有文字的一步算在写回答，预览把行内多余空白压成一个", () => {
  const state = play(begin(1, 0), reply(20, [text("结论：  缓存   命中率\t已经够高。")], { turn: 1, step: 1 }));
  assert.equal(state.phase, "writing");
  assert.equal(state.draft, "结论： 缓存 命中率 已经够高。");
});

test("分条的回答在预览里保留换行，但去掉空行", () => {
  const state = play(begin(1, 0), reply(20, [text("要做两件事：\n\n\n- 换图标\n- 补测试\n")], { turn: 1, step: 1 }));
  assert.equal(state.draft, "要做两件事：\n- 换图标\n- 补测试");
});

// ── 一轮怎么结束 ─────────────────────────────────────────────────────────

test("一轮结束：完成、出错、被停下各有各的阶段，计划清空", () => {
  const cases = [["completed", "done"], ["error", "error"], ["aborted", "aborted"]];
  for (const [kind, phase] of cases) {
    const state = play(begin(1, 0), reply(10, [wants("q", "grep", { pattern: "x" })]), finish(900, kind));
    assert.equal(state.phase, phase, kind);
    assert.equal(state.endedAt, 900, kind);
    assert.deepEqual(state.plan, [], kind);
  }
});

test("一轮为什么停：限流带等待时间、上下文满、余额不足、输出被截断；正常完成不写原因", () => {
  const started = play(begin(3, 0));
  const endWith = (reason) => applyEvent(started, at("turn/end", 500, { turn: 3, reason }));

  const limited = endWith({ kind: "error", error: { code: "RATE_LIMIT", status: 429, message: "slow down", providerRetryAfterMs: 12000 } });
  assert.deepEqual([limited.endCause.cause, limited.endCause.status, limited.endCause.retryAfterMs], ["ratelimit", 429, 12000]);

  const table = [
    [{ kind: "error", error: { code: "CONTEXT_WINDOW_EXCEEDED", message: "prompt is too long" } }, "context"],
    [{ kind: "error", error: { code: "HTTP_402", status: 402, message: "余额不足" } }, "quota"],
    [{ kind: "max-tokens" }, "truncated"],
    [{ kind: "completed" }, ""],
  ];
  for (const [reason, cause] of table) assert.equal(endWith(reason).endCause.cause, cause, JSON.stringify(reason));

  assert.equal(applyEvent(limited, begin(4, 9000)).endCause, null, "下一轮开始就不再提上一轮的原因");
});

// ── 你说了什么 ───────────────────────────────────────────────────────────

test("记下你这一轮的要求（压成一行），后面几轮也一直带着", () => {
  const first = play(asked(5, "\n  帮我把图标换成线条风格\n  顺便更新截图 \n"), begin(1, 10));
  assert.equal(first.prompt, "帮我把图标换成线条风格 顺便更新截图");
  assert.equal(applyEvent(first, begin(2, 800)).prompt, first.prompt, "换轮不丢");
  assert.strictEqual(applyEvent(first, at("user/message", 900, { source: { kind: "user" }, content: [] })), first, "没有文字的消息不覆盖");

  const long = play(asked(5, "很长的要求".repeat(80)));
  assert.ok(long.prompt.length <= 120 && long.prompt.endsWith("…"), `${long.prompt.length}`);
});

test("系统注入的上下文、插件的召回、来源不明的消息，都不当成你的要求", () => {
  const notYou = [
    { kind: "runtime-context", form: "snapshot" },
    { kind: "time-context", form: "snapshot" },
    { kind: "skill-catalog", form: "catalog" },
    { kind: "plugin:some-memory", plugin: "some-memory", form: "recall" },
    undefined,
  ];
  for (const source of notYou) {
    const state = play(at("user/message", 5, { role: "user", source, content: [text("当前时间 2026-10-28 16:00")] }));
    assert.equal(state.prompt, "", JSON.stringify(source));
  }
});

test("与卡片无关的事件原样返回同一个对象，不触发重画", () => {
  const state = play(begin(1, 0), at("step/start", 1, { turn: 1, step: 1 }));
  for (const event of [at("user/message", 2), at("step/end", 3, { turn: 1, step: 1 }), at("request/header", 4)]) {
    assert.strictEqual(applyEvent(state, event), state, event.type);
  }
});

// ── 从参数里读出"在动什么" ───────────────────────────────────────────────

test("describeCall 挑出最能说明对象的那个参数，并标出它是什么", () => {
  const table = [
    [{ file_path: "D:/repo/src/index.ts" }, "D:/repo/src/index.ts", "path"],
    [{ command: "git log --oneline -5" }, "git log --oneline -5", "command"],
    [{ command: 'cd "D:/my repo" && pnpm build' }, "pnpm build", "command"],
    [{ command: "Set-Location D:/x; ./run.ps1" }, "./run.ps1", "command"],
    [{ command: 'BIN="/opt/tool" && "$BIN" --version' }, '"$BIN" --version', "command"],
    [{ command: "node - <<'JS'\nconsole.log(1)\nJS" }, "node", "command"],
    [{ pattern: "TODO\\(", path: "src" }, "TODO\\(", "query"],
    [{ url: "https://registry.npmjs.org/react" }, "https://registry.npmjs.org/react", "url"],
    [{ todos: [{ content: "b" }] }, '[{"content":"b"}]', "list"],
    [{ retries: 2 }, "2", "other"],
  ];
  for (const [args, target, kind] of table) assert.deepEqual(describeCall(JSON.stringify(args)), { target, kind }, JSON.stringify(args));
  for (const raw of ["不是 JSON", "", undefined]) {
    assert.deepEqual(describeCall(raw), { target: raw ?? "", kind: "other" }, String(raw));
  }
});

test("太长的路径留尾巴，太长的命令留开头，都不超过 120 字", () => {
  const deep = "D:/" + Array.from({ length: 30 }, (_, i) => "level" + i).join("/") + "/target.css";
  const path = describeCall(JSON.stringify({ file_path: deep }));
  assert.equal(path.kind, "path");
  assert.ok(path.target.startsWith("…") && path.target.endsWith("target.css") && path.target.length <= 120, path.target);

  const wordy = "pnpm exec eslint " + Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`).join(" ");
  const command = describeCall(JSON.stringify({ command: wordy }));
  assert.equal(command.kind, "command");
  assert.ok(command.target.startsWith("pnpm exec eslint") && command.target.endsWith("…") && command.target.length <= 120, command.target);
});

// ── 为什么做、为哪条计划做 ───────────────────────────────────────────────

test("模型在调用前说的那句话记成这一步的理由（不超过 80 字）", () => {
  const state = play(
    begin(1, 0),
    reply(10, [text("截图里按钮偏了两像素，先量一下现在的样式再改。"), wants("m", "read", { file_path: "styles/button.css" })], { turn: 1, step: 1 }),
    call("m", "read", { file_path: "styles/button.css" }, 20, { turn: 1, step: 1 }),
    done("m", 60, { role: "tool", content: [] }),
  );
  const step = state.items.at(-1);
  assert.equal(step.status, "ok");
  assert.match(step.why, /先量一下/);
  assert.ok(step.why.length <= 80);
});

test("模型没说理由就直接调用，理由留空，不替它编", () => {
  const state = play(begin(1, 0), call("s", "grep", { pattern: "fontSize" }, 10));
  assert.equal(state.items.at(-1).why, "");
});

test("每一步记下它在为哪条进行中的计划干活；还没有计划时为空", () => {
  const plan = [{ content: "统一按钮尺寸", status: "in_progress" }, { content: "更新截图", status: "pending" }];
  const withPlan = play(begin(2, 0), at("todo/write", 5, { todos: plan }), call("e", "edit", { file_path: "styles/button.css", old_string: "1", new_string: "2" }, 10));
  assert.equal(withPlan.items[0].task, "统一按钮尺寸");
  assert.equal(withPlan.todos.length, 2);

  const noPlan = play(begin(1, 0), call("r", "read", { file_path: "styles/button.css" }, 10));
  assert.equal(noPlan.items[0].task, "");
});

test("新一轮不带上一轮的计划", () => {
  const state = play(begin(1, 0), at("todo/write", 5, { todos: [{ content: "旧计划", status: "in_progress" }] }), begin(2, 100));
  assert.deepEqual(state.todos, []);
});

test("步样本把模型与工具分开记，按类别归档，等待与上下文维护不进基线", () => {
  const events = [at("turn/start", 0, { turn: 1 }), at("step/start", 0, {})];
  for (let index = 0; index < 40; index += 1) {
    const when = 1000 * (index + 1);
    events.push(at("step/start", when, {}));
    events.push(at("tool/call", when + 200, { callId: String(index), name: "ops_bash", arguments: {} }));
    events.push(at("tool/result", when + 800, { message: { toolCallId: String(index), isError: false, content: [] } }));
  }
  // 一次网络调用与一次等人回答：前者进 network 基线，后者完全不进。
  events.push(at("step/start", 90000, {}));
  events.push(at("tool/call", 90000, { callId: "net", name: "web_fetch", arguments: {} }));
  events.push(at("tool/result", 93000, { message: { toolCallId: "net", isError: false, content: [] } }));
  events.push(at("step/start", 94000, {}));
  events.push(at("tool/call", 94000, { callId: "wait", name: "ask_user_question", arguments: {} }));
  events.push(at("tool/result", 99000, { message: { toolCallId: "wait", isError: false, content: [] } }));
  // 一次压缩：系统维护，整步不进任何耗时基线。
  events.push(at("step/start", 100000, {}));
  events.push(at("tool/call", 100200, { callId: "ctx", name: "compress", arguments: {} }));
  events.push(at("tool/result", 100900, { message: { toolCallId: "ctx", isError: false, content: [] } }));
  events.push(at("turn/end", 102000, { turn: 1, reason: "completed" }));
  const state = play(events);

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
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("step/start", 1000, { step: 1 }),
    at("assistant/message", 4000, { step: 1, message: { content: [{ type: "tool-call", id: "a", name: "read", arguments: "{}" }, { type: "tool-call", id: "b", name: "grep", arguments: "{}" }] } }),
    at("tool/call", 4000, { callId: "a", name: "read", arguments: "{}" }),
    at("tool/call", 4500, { callId: "b", name: "grep", arguments: "{}" }),
    at("tool/result", 5000, { message: { toolCallId: "a" } }),
    at("tool/result", 6000, { message: { toolCallId: "b" } }),
    at("step/start", 6000, { step: 2 }),
    at("assistant/message", 9000, { step: 2, message: { content: [{ type: "text", text: "完成" }] } }),
    at("turn/end", 9000, { reason: { kind: "completed" } }),
  ]);
  // 3s + 3s of generation, the final text-only step included.
  assert.equal(state.modelMs, 6000);
  // two overlapping calls 4.0–5.0 and 4.5–6.0 occupy 2s, not 2.5s.
  assert.equal(state.toolMs, 2000);
  assert.equal(state.toolOpen, 0);
});

test("a new turn starts its timers at zero and folds the old turn, context ops included", () => {
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("step/start", 1000, { step: 1 }),
    at("assistant/message", 2000, { step: 1, message: { content: [{ type: "tool-call", id: "c", name: "compress", arguments: "{}" }] } }),
    at("tool/call", 2000, { callId: "c", name: "compress", arguments: "{}" }),
    at("tool/result", 2500, { message: { toolCallId: "c", content: [{ type: "text", text: "ok" }] } }),
    at("turn/end", 3000, { reason: { kind: "completed" } }),
    at("turn/start", 5000, { turn: 2 }),
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
    at("turn/start", t0, { turn: n }),
    at("step/start", t0, { step: 1 }),
    at("user/message", t0 + 1, { content: [{ type: "text", text: "第" + n + "轮的问题" }], source: { kind: "user" }, role: "user" }),
    at("assistant/message", t0 + 2000, { step: 1, message: { content: [{ type: "tool-call", id: "c" + n, name: "read", arguments: "{}" }] } }),
    at("tool/call", t0 + 2000, { callId: "c" + n, name: "read", arguments: "{}" }),
    at("tool/result", t0 + 2500, { message: { toolCallId: "c" + n } }),
    at("step/start", t0 + 2500, { step: 2 }),
    at("assistant/message", t0 + 4000, { step: 2, message: { content: [{ type: "text", text: "好" }] } }),
    at("turn/end", t0 + 4000, { reason: { kind: "completed" } }),
  ];
  const state = play([...turn(1, 1000), ...turn(2, 10000)]);
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

test("工具说明保留为独立字段，不丢掉宿主显示的调用目的", () => {
  const result = describeCall(JSON.stringify({ command: 'printf "%-14s %s\\n" x; rg version package.json', description: 'Check version field consistency and usage' }));
  assert.equal(result.description, 'Check version field consistency and usage');
});

test("并行调用部分完成后仍处于工具执行阶段", () => {
  const state = play([
    at('turn/start', 1000, {turn: 1}),
    at('tool/call', 1010, {callId:'a', name:'read', arguments:'{}'}),
    at('tool/call', 1020, {callId:'b', name:'write', arguments:'{}'}),
    at('tool/result', 1030, {message:{toolCallId:'a'}}),
  ]);
  assert.equal(state.phase, 'tool');
  assert.equal(state.toolOpen, 1);
});

test("每条操作都带可恢复键：同工具同目标才算同类，上下文维护认范围", () => {
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"/a/x.js"}' }),
    at("tool/call", 1200, { turn: 1, step: 1, callId: "c2", name: "compress", arguments: '{"startId":"m00001","endId":"m00005"}' }),
  ]);
  assert.equal(state.items[0].key, "tool|read|path|/a/x.js");
  assert.equal(state.items[1].key.startsWith("ctx|compress|"), true);
  assert.match(state.items[1].key, /m00001/);
});

test("结果一定结账：条目被挤出显示窗口，工具账也不再挂起", () => {
  const events = [at("turn/start", 1000, { turn: 1 })];
  for (let index = 0; index < 40; index += 1) {
    events.push(at("tool/call", 1100 + index * 10, { turn: 1, step: 1, callId: "k" + index, name: "read", arguments: '{"path":"/a/f' + index + '.js"}' }));
  }
  for (let index = 0; index < 40; index += 1) {
    events.push(at("tool/result", 1600 + index * 10, { turn: 1, step: 1, message: { toolCallId: "k" + index, isError: false } }));
  }
  const state = play(events);
  assert.equal(state.toolOpen, 0, "最后一个结果之后不该还有未结的调用");
  assert.equal(state.phase, "thinking");
  assert.ok(state.toolMs > 0, "工具耗时要算进来");
  assert.equal(state.counts.steps, 40);
});

test("重复的 turn/end 不会重复结算：历史只记一条，结束时刻不变", () => {
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" }),
    at("tool/result", 1200, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }),
    at("turn/end", 2000, { turn: 1, reason: { kind: "completed" } }),
    at("turn/end", 9000, { turn: 1, reason: { kind: "completed" } }),
  ]);
  assert.equal(state.endedAt, 2000);
  assert.equal(state.history.filter((sample) => sample.turn === 1).length, 1);
});

test("本轮上下文维护总账：次数、省下的量、失败数不受显示窗口影响", () => {
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "compress", arguments: '{"startId":"m00001","endId":"m00005"}' }),
    at("tool/result", 1200, {
      turn: 1, step: 1,
      message: { toolCallId: "c1", isError: false, content: [{ type: "text", text: "[Compressed m00001–m00005 → 1 block(s), ~1000 tokens saved.]" }] },
    }),
    at("tool/call", 1300, { turn: 1, step: 1, callId: "c2", name: "compress", arguments: '{"startId":"m00006","endId":"m00009"}' }),
    at("tool/result", 1400, { turn: 1, step: 1, message: { toolCallId: "c2", isError: true } }),
  ]);
  assert.equal(state.turnCtx.n, 2);
  assert.equal(state.turnCtx.fails, 1);
  assert.equal(state.turnCtx.saved, 1000);
});

test("命令类工具按在干什么分开记：跑测试和 git 不共用同一个中位数", () => {
  const run = (command) => play([
    at("turn/start", 1000, { turn: 1 }),
    at("step/start", 1100, { turn: 1, step: 1 }),
    at("tool/call", 1200, { turn: 1, step: 1, callId: "c1", name: "ops_bash", arguments: JSON.stringify({ command }) }),
    at("tool/result", 2200, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }),
    at("step/start", 2400, { turn: 1, step: 2 }),
  ]);
  const keysOf = (command) => Object.keys(run(command).stepStats).join(" ");
  assert.match(keysOf("node --test tests/*.test.mjs"), /ops_bash:test/);
  assert.match(keysOf("git status --short"), /ops_bash:git(?!-)/);
  assert.match(keysOf("node scripts/release.mjs"), /ops_bash:script/);
});

test("一条命令串了好几步时，不把它算成“同类步”样本", () => {
  const run = (command) => {
    const events = [
      at("turn/start", 900, { turn: 1 }),
      at("step/start", 950, { turn: 1, step: 1 }),
      at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "ops_bash", arguments: JSON.stringify({ command }) }),
      at("tool/result", 4100, { turn: 1, step: 1, message: { toolCallId: "c1", isError: false } }),
      at("assistant/message", 4150, { turn: 1, step: 1, message: { content: [{ type: "text", text: "跑完了" }] } }),
      at("step/start", 4200, { turn: 1, step: 2 }),
    ];
    return Object.keys(play(events).stepStats);
  };
  assert.ok(run("node --test tests/x.test.mjs").some((key) => key.includes("ops_bash:test")));
  assert.deepEqual(run("git add -A && git commit -m x"), []);
});

test("命令非零退出就是失败：宿主不给 error 标记，也要认出来", () => {
  const NL = String.fromCharCode(10);
  const run = (command, text) => play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "ops_bash", arguments: JSON.stringify({ command }) }),
    at("tool/result", 2100, { turn: 1, step: 1, callId: "c1", message: { toolCallId: "c1", isError: false, content: [{ type: "text", text }] } }),
  ]);
  const bad = run("node scripts/build.mjs", ["boom", "", "[exit code: 2]"].join(NL));
  assert.equal(bad.items[0].status, "error");
  assert.equal(bad.items[0].err, "退出码 2");
  assert.equal(bad.counts.errors, 1);

  const grep = run("grep -n TODO src/app.js", "[exit code: 1]");
  assert.equal(grep.items[0].status, "ok", "没有匹配不是失败");

  const chained = run("make || true", ["fail", "[exit code: 1]", "ok", "[exit code: 0]"].join(NL));
  assert.equal(chained.items[0].status, "ok", "只看最后一条");

  const read = play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ path: "x.md" }) }),
    at("tool/result", 2100, { turn: 1, step: 1, callId: "c1", message: { toolCallId: "c1", isError: false, content: [{ type: "text", text: "[exit code: 2]" }] } }),
  ]);
  assert.equal(read.items[0].status, "ok", "读文件读到这几个字不算命令失败");
});

test("退出码 1 只看命令：测试失败要红，git diff 有差异不算失败", () => {
  const run = (command) => play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c1", name: "ops_bash", arguments: JSON.stringify({ command }) }),
    at("tool/result", 2100, { turn: 1, step: 1, callId: "c1", message: { toolCallId: "c1", isError: false, content: [{ type: "text", text: "[exit code: 1]" }] } }),
  ]);
  const failing = run("node --test tests/*.test.mjs");
  assert.equal(failing.items[0].status, "error", "测试挂了就是挂了");
  assert.equal(failing.items[0].err, "退出码 1");

  const diff = run("git diff --stat HEAD");
  assert.equal(diff.items[0].status, "ok", "有差异不是失败");

  const rg = run("rg -n TODO src");
  assert.equal(rg.items[0].status, "ok", "没匹配不是失败");
});

test("老形态数据：data.isError / data.text 也要认", () => {
  const state = play([
    at("turn/start", 1000, { turn: 1 }),
    at("tool/call", 1100, { turn: 1, step: 1, callId: "c9", name: "write", arguments: JSON.stringify({ path: "a.txt" }) }),
    at("tool/result", 2100, { turn: 1, step: 1, callId: "c9", isError: true, text: "disk full" }),
  ]);
  assert.equal(state.items[0].status, "error");
});



// ── 等人回答的时间不算工期 ────────────────────────────────────────────────

/** 记日志的时刻从 1000 起：0 在记录里是“还没开始”的哨兵。 */
const T0 = 1000;

test("问用户之后到回答回来：这段不算这一轮的工期", () => {
  const state = play([
    at("turn/start", T0, { turn: 1 }),
    at("tool/call", T0 + 1000, { callId: "a1", name: "ask_user_question", arguments: "{}" }),
    at("tool/result", T0 + 61000, { message: { toolCallId: "a1" } }),
    at("turn/end", T0 + 62000, { reason: { kind: "completed" } }),
  ]);
  assert.equal(state.pauseMs, 60000, "挂起的那 60 秒记在挂起账上");
  assert.equal(state.activeMs, 2000, "真正干活的只有前后两秒");
  assert.equal(state.totals.wallMs, 62000, "墙上时间照记，不篡改");
  assert.equal(state.totals.activeMs, 2000);
  assert.equal(state.totals.pauseMs, 60000);
  assert.equal(state.history.at(-1).activeMs, 2000);
});

test("等审批同样不算工期，点头之后立刻接着算", () => {
  const state = play([
    at("turn/start", T0, { turn: 1 }),
    at("approval/asked", T0 + 500, { id: "ap1", toolName: "ops_bash" }),
    at("approval/decided", T0 + 9500, { id: "ap1", outcome: "approved" }),
    at("turn/end", T0 + 10000, { reason: { kind: "completed" } }),
  ]);
  assert.equal(state.activeMs, 1000);
  assert.equal(state.pauseMs, 9000);
});

test("两件事同时在等：只算一次，不重复累加", () => {
  const state = play([
    at("turn/start", T0, { turn: 1 }),
    at("approval/asked", T0 + 1000, { id: "ap1", toolName: "ops_bash" }),
    at("tool/call", T0 + 2000, { callId: "a1", name: "ask_user_question", arguments: "{}" }),
    at("approval/decided", T0 + 5000, { id: "ap1", outcome: "approved" }),
    at("tool/result", T0 + 11000, { message: { toolCallId: "a1" } }),
    at("turn/end", T0 + 11000, { reason: { kind: "completed" } }),
  ]);
  assert.equal(state.pauseMs, 10000, "从第一件开始等算到最后一件结束");
  assert.equal(state.activeMs, 1000);
});

test("等到一半这一轮被打断：还开着的那段也结账，不留悬空时间", () => {
  const state = play([
    at("turn/start", T0, { turn: 1 }),
    at("tool/call", T0 + 1000, { callId: "a1", name: "ask_user_question", arguments: "{}" }),
    at("turn/end", T0 + 31000, { reason: { kind: "interrupted" } }),
  ]);
  assert.equal(state.pauseAt, 0, "结束后不再挂着");
  assert.equal(state.pauseMs, 30000);
  assert.equal(state.activeMs, 1000);
});

test("没在等谁的时候，activeMs 就是墙上时间", () => {
  const state = play([
    at("turn/start", T0, { turn: 1 }),
    at("tool/call", T0 + 1000, { callId: "r1", name: "read", arguments: "{}" }),
    at("tool/result", T0 + 3000, { message: { toolCallId: "r1" } }),
    at("turn/end", T0 + 4000, { reason: { kind: "completed" } }),
  ]);
  assert.equal(state.pauseMs, 0);
  assert.equal(state.activeMs, 4000);
});
