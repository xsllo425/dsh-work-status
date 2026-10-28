import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const file = path.join(import.meta.dirname, "..", "lib", "client.js");

// 组件里的 useNow 会开一秒一次的定时器，测试不需要它打转。
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
// 下载轮询也是定时器：首帧那一次 tick 同步就跑完了，后面的重排不要留下活句柄。
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

/**
 * 客户端只有 `window.__ModuleLoader__` 这一个入口，React 由宿主注入。
 * 这里给一个极小的替身：元素是普通对象，useState 会触发重渲染，effect 在渲染后执行，
 * 于是可以真的“点一下按钮”再读它渲染成了什么。
 */
async function loadBadge(options = {}) {
  delete globalThis.window;
  let config;
  let component;
  let renderer = null;

  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (init) => {
      const i = renderer.index++;
      if (!(i in renderer.state)) renderer.state[i] = typeof init === "function" ? init() : init;
      const set = (value) => {
        renderer.state[i] = typeof value === "function" ? value(renderer.state[i]) : value;
        renderer.dirty = true;
      };
      return [renderer.state[i], set];
    },
    useEffect: (fn, deps) => {
      const i = renderer.effectIndex++;
      const prev = renderer.deps[i];
      const changed = prev === undefined || deps === undefined || deps.some((value, k) => value !== prev[k]);
      if (changed) renderer.pending.push(fn);
      renderer.deps[i] = deps;
    },
    useRef: (init) => {
      const i = renderer.refIndex++;
      if (!(i in renderer.refs)) renderer.refs[i] = { current: init };
      return renderer.refs[i];
    },
  };

  const fakeRequire = (id) => {
    if (id === "react") return React;
    throw new Error(`unexpected require: ${id}`);
  };

  globalThis.window = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    __ModuleLoader__: { load: (value) => { config = value; } },
  };
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: "", id: "" }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  await import(`${pathToFileURL(file).href}?v=${Math.random()}`);
  assert.equal(config.id, "dsh-work-status");
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    sessions: options.sessions,
    slots: {
      inject: (_slot, apply) => apply(),
      register: (_spec, render) => { component = render; return () => {}; },
    },
  };
  const mod = config.factory(fakeRequire);
  mod.apply(ctx);
  assert.equal(typeof component, "function");

  const mount = (props) => {
    renderer = { index: 0, effectIndex: 0, refIndex: 0, state: [], deps: {}, pending: [], refs: [], dirty: false };
    const run = () => {
      renderer.index = 0;
      renderer.effectIndex = 0;
      renderer.refIndex = 0;
      renderer.pending = [];
      renderer.dirty = false;
      const tree = component(props);
      for (const effect of renderer.pending) effect();
      return tree;
    };
    let tree = run();
    return {
      get tree() { return tree; },
      rerender() { tree = run(); return tree; },
      click(predicate) {
        const button = collect(tree, (node) => node.props?.onClick && predicate(node))[0];
        assert.ok(button, "找不到可点击的元素");
        button.props.onClick({ preventDefault() {}, stopPropagation() {}, key: "Enter" });
        tree = run();
        return tree;
      },
      text() { return textOf(tree); },
      /**
       * 走一遍当前这棵树，先把 hook 计数归零：textOf/collect 会把函数组件再跑一次，
       * 不归零的话状态槽位会一路错开，读到别人的 useState。
       */
      walk(fn) {
        renderer.index = 0;
        renderer.effectIndex = 0;
        renderer.refIndex = 0;
        renderer.pending = [];
        return fn(tree);
      },
    };
  };
  return mount;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node.type === "function") return textOf(node.type(node.props));
  return (node.props?.children ?? []).map(textOf).join("");
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (typeof node.type === "function") {
    collect(node.type(node.props), predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.props?.children ?? []) collect(child, predicate, out);
  return out;
}

function byClass(name) {
  return (node) => String(node.props?.className ?? "").split(" ").includes(name);
}

const NOW = Date.now();

function call(name, target, status, extra = {}) {
  return {
    kind: "call",
    name,
    target,
    status,
    t0: NOW - 4000,
    t1: NOW - 1000,
    task: "给徽标换一个读法",
    why: "先看清现状再改",
    ...extra,
  };
}

const FIVE_CALLS = [
  call("read", "lib/client.js", "ok"),
  call("edit", "lib/client.js", "ok"),
  call("ops_bash", "node --test tests/*.test.mjs", "ok"),
  call("web_fetch", "https://github.com/topics/dsh-plugin", "ok"),
  call("edit", "lib/activity.js", "ok"),
];

function activity(over = {}) {
  return {
    phase: "thinking",
    turn: 3,
    startedAt: NOW - 60000,
    updatedAt: NOW - 2000,
    counts: { steps: 5, tools: 5, errors: 0 },
    items: FIVE_CALLS,
    draft: "",
    ...over,
  };
}

function props(over = {}, todos = []) {
  const state = activity(over);
  return {
    useProjection: (key) => (key === "workStatus" ? state : key === "todos" ? todos : undefined),
  };
}

test("收起态只有一个徽标：用时、呼吸点，读屏念得出现在在做什么", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 0);
  const chips = collect(view.tree, byClass("dws-chip"));
  assert.equal(chips.length, 1);
  assert.match(textOf(chips[0]), /1m00s|60s/);
  assert.match(String(chips[0].props["aria-label"]), /修改文件 数据代码/);
});

test("点开面板：当前动作在标题，最近几步各说各的事", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 1);
  const head = textOf(collect(view.tree, byClass("dws-head-text"))[0]);
  assert.match(textOf(view.tree), /修改文件\s*界面代码/, "展开面板后正文里能看到最近的动作");

  const rows = collect(view.tree, byClass("dws-row"));
  assert.ok(rows.length >= 3, `最近只画了 ${rows.length} 行`);
  const labels = rows.map((row) => textOf(row));
  assert.equal(new Set(labels).size, labels.length, `行文案重复：${labels.join(" | ")}`);
});

test("失败：还没补上的挂着「未恢复」，已被后续成功接替的划掉转灰", async () => {
  const mount = await loadBadge();
  const errorItems = [
    call("ops_bash", "node --test", "error", { err: "expected 8, got 7" }),
    call("ops_bash", "node --test", "ok"),
  ];
  const view = mount(props({ items: errorItems, counts: { steps: 2, tools: 2, errors: 1 } }));
  view.click(byClass("dws-chip"));
  const settled = collect(view.tree, byClass("dws-item")).filter((item) => item.props["data-settled"] === "true");
  assert.equal(settled.length, 1, "重试成功的那次失败应被划掉");
  const text = view.text();
  assert.doesNotMatch(text, /已恢复|未恢复/, "已了结的失败不再挂标签");
  assert.doesNotMatch(text, /expected 8, got 7/, "错误原文收进悬停");

  const fresh = mount(props({ items: [call("ops_bash", "npm run lint", "error", { err: "boom" })], counts: { steps: 1, tools: 1, errors: 1 } }));
  fresh.click(byClass("dws-chip"));
  assert.match(fresh.text(), /未恢复/);
  assert.match(fresh.text(), /boom/);
});

test("同一目标再失败一次：第二行改成「重试仍失败」，不叠两个标签", async () => {
  const mount = await loadBadge();
  const items = [
    call("ops_bash", "node --test", "error", { err: "expected 8, got 7" }),
    call("ops_bash", "node --test", "error", { err: "still 8" }),
    call("read", "lib/client.js", "error", { err: "ENOENT" }),
  ];
  const view = mount(props({ items, counts: { steps: 3, tools: 3, errors: 3 } }));
  view.click(byClass("dws-chip"));
  const tags = collect(view.tree, (node) => node.props?.["data-kind"] === "pending").map((node) => textOf(node));
  assert.equal(tags.filter((label) => label === "重试仍失败").length, 1, "同一目标第二行才是重试");
  assert.equal(tags.filter((label) => label === "未恢复").length, 2, "第一次失败与另一个目标都还是未恢复");
  assert.doesNotMatch(view.text(), /重试仍失败.*重试仍失败/);
});

test("末尾连着两步都失败：标题旁挂一句「连着没成」，只失败一次不挂", async () => {
  const mount = await loadBadge();
  const twice = mount(props({ items: [call("ops_bash", "npm test", "error", { err: "boom" }), call("ops_bash", "npm test", "error", { err: "boom" })], counts: { steps: 2, tools: 2, errors: 2 } }));
  twice.click(byClass("dws-chip"));
  const flags = collect(twice.tree, byClass("dws-head-flag"));
  assert.equal(flags.length, 1);
  assert.match(textOf(flags[0]), /连着没成/);

  const once = mount(props({ items: [call("ops_bash", "npm test", "error", { err: "boom" })], counts: { steps: 1, tools: 1, errors: 1 } }));
  once.click(byClass("dws-chip"));
  assert.equal(collect(once.tree, byClass("dws-head-flag")).length, 0, "只失败一次不摆脸色");
});

test("这一步跑过 20 秒：行尾挂「有点久」，加上就慢的整轮也不催", async () => {
  const mount = await loadBadge();
  const slow = mount(props({ startedAt: NOW - 30000, stepSig: "ops_bash", stepStartAt: NOW - 25000, stepModelMs: 3000 }));
  slow.click(byClass("dws-chip"));
  const slowTags = collect(slow.tree, (node) => node.props?.["data-kind"] === "slow").map((node) => textOf(node));
  assert.deepEqual(slowTags, ["有点久"]);

  const quick = mount(props({ startedAt: NOW - 8000, stepSig: "ops_bash", stepStartAt: NOW - 5000, stepModelMs: 3000 }));
  quick.click(byClass("dws-chip"));
  assert.equal(collect(quick.tree, (node) => node.props?.["data-kind"] === "slow").length, 0);

  const long = mount(props({ startedAt: NOW - 130000 }));
  long.click(byClass("dws-chip"));
  const flag = collect(long.tree, byClass("dws-head-flag"))[0];
  assert.ok(flag, "整轮过了两分钟应有一句");
  assert.match(textOf(flag), /本轮偏长/);
});

test("长时间没有新事件：有工具在跑只标那一行，没在飞才在标题旁说一句", async () => {
  const mount = await loadBadge();
  const quietTags = (view) => collect(view.tree, (node) => node.props?.className === "dws-tag" && node.props?.["data-kind"] === "quiet").map(textOf);
  const headFlags = (view) => collect(view.tree, byClass("dws-head-flag")).map(textOf);

  // 没有工具在跑、60 秒没新事件：标题旁说一句，行上不挂。
  const idle = mount(props({ updatedAt: NOW - 60000 }));
  idle.click(byClass("dws-chip"));
  assert.equal(headFlags(idle).length, 1);
  assert.match(headFlags(idle)[0], /没动静/);
  assert.deepEqual(quietTags(idle), []);

  // 工具还在跑、60 秒没新事件：只标那一行，不说「卡住」——跑得慢和挂住，事件上分不出来。
  const running = mount(props({
    updatedAt: NOW - 60000,
    items: [...FIVE_CALLS, call("ops_bash", "cat big.log", "running", { id: "run-1", t0: NOW - 90000, t1: 0 })],
  }));
  running.click(byClass("dws-chip"));
  assert.deepEqual(quietTags(running), ["没新动静"]);
  assert.deepEqual(headFlags(running), []);

  // 正在等你回答：多久都别说没动静。
  const waiting = mount(props({
    updatedAt: NOW - 60000,
    items: [...FIVE_CALLS, call("ask_user_question", "用哪个方案？", "running", { id: "ask-1", t0: NOW - 8000, t1: 0 })],
  }));
  waiting.click(byClass("dws-chip"));
  assert.deepEqual(quietTags(waiting), []);
  assert.deepEqual(headFlags(waiting), []);

  // 刚有事件：什么都不说。
  const fresh = mount(props({ updatedAt: NOW - 1000 }));
  fresh.click(byClass("dws-chip"));
  assert.deepEqual(quietTags(fresh), []);
  assert.deepEqual(headFlags(fresh), []);
});

test("这一轮为什么停：日志给了原因就直说，限流还带上要等多久", async () => {
  const mount = await loadBadge();
  const headFlags = (view) => collect(view.tree, byClass("dws-head-flag")).map((node) => textOf(node));
  const rate = mount(props({
    phase: "error",
    endedAt: NOW - 1000,
    endCause: { kind: "error", cause: "ratelimit", code: "RATE_LIMIT", status: 429, retryAfterMs: 8000, message: "Too Many Requests" },
  }));
  rate.click(byClass("dws-chip"));
  const flags = headFlags(rate);
  assert.equal(flags.length, 1);
  assert.match(flags[0], /限流.*8.*秒/);
  const node = collect(rate.tree, byClass("dws-head-flag"))[0];
  assert.match(String(node.props.title), /429|Too Many/, "悬停里留原始错误码，方便排查");

  const context = mount(props({
    phase: "error",
    endedAt: NOW - 1000,
    endCause: { kind: "error", cause: "context", code: "CONTEXT_WINDOW_EXCEEDED", status: 0, retryAfterMs: 0, message: "" },
  }));
  context.click(byClass("dws-chip"));
  assert.match(headFlags(context)[0] ?? "", /上下文满了/);

  // 自己按停的，不用说；正常完成也不用说。
  const stopped = mount(props({
    phase: "aborted",
    endedAt: NOW - 1000,
    endCause: { kind: "interrupted", cause: "interrupted", code: "", status: 0, retryAfterMs: 0, message: "" },
  }));
  stopped.click(byClass("dws-chip"));
  assert.deepEqual(headFlags(stopped), []);
});

test("命令、网址里夹着凭据，卡片也只显示遮掉的样子", async () => {
  const mount = await loadBadge();
  const items = [call("mystery_tool", "Authorization: Bearer abcdef123456", "ok", { targetKind: "other" })];
  const view = mount(props({ items, counts: { steps: 1, tools: 1, errors: 0 } }));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.doesNotMatch(text, /abcdef123456/);
  assert.match(text, /\*\*\*/);
});

test("名字认不出的工具：参数露了用途就按种类说，不留英文残片", async () => {
  const mount = await loadBadge();
  const items = [call("frobnicate", "git status --short", "ok", { kind: "command" })];
  const view = mount(props({ items, counts: { steps: 1, tools: 1, errors: 0 } }));
  view.click(byClass("dws-chip"));
  const row = collect(view.tree, byClass("dws-row")).at(-1);
  assert.match(textOf(row), /跑命令/);
  assert.match(textOf(row), /git status/);
  assert.doesNotMatch(textOf(row), /frobnicate/);
});

test("模型还在念参数时先说接下来做什么，参数没闭合就保持原样", async () => {
  const events = [];
  let change = { kind: "append", entries: [] };
  const listeners = new Set();
  const source = {
    getSnapshot: () => ({ entries: events.slice(), change }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const mount = await loadBadge({ sessions: { binding: () => ({ eventSource: source }) } });
  const view = mount({ ...props(), sid: "s1" });
  view.click(byClass("dws-chip"));
  const nowRow = () => textOf(collect(view.tree, byClass("dws-item-now"))[0] ?? { props: {} });
  assert.match(nowRow(), /模型思考中/);

  const push = (event, kind = "append") => {
    const entry = { type: "transient", event };
    events.push(entry);
    change = { kind, entries: [entry] };
    for (const fn of listeners) fn();
    view.rerender();
  };
  const delta = (raw) => push({ type: "assistant/live-chunk", data: { chunk: { type: "tool-call-delta", id: "c1", name: "read", argumentsDelta: raw } } });

  delta('{"file_pa');
  assert.match(nowRow(), /模型思考中/, "参数还没闭合时不能猜");

  delta('th":"lib/client.js"}');
  assert.match(nowRow(), /看文件/);
  assert.match(nowRow(), /lib\/client\.js/);

  push({ type: "tool/call", data: { callId: "c1", name: "read" } }, "replace");
  assert.match(nowRow(), /模型思考中/, "调用真发生了就交回时间轨");
});

test("模型已经在写正文时说「写回答」，只吐推理时还是「思考中」", async () => {
  const events = [];
  let change = { kind: "append", entries: [] };
  const listeners = new Set();
  const source = {
    getSnapshot: () => ({ entries: events.slice(), change }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const mount = await loadBadge({ sessions: { binding: () => ({ eventSource: source }) } });
  const view = mount({ ...props(), sid: "s1" });
  view.click(byClass("dws-chip"));
  const nowRow = () => textOf(collect(view.tree, byClass("dws-item-now"))[0] ?? { props: {} });
  const push = (event) => {
    const entry = { type: "transient", event };
    events.push(entry);
    change = { kind: "append", entries: [entry] };
    for (const fn of listeners) fn();
    view.rerender();
  };
  const chunk = (type) => push({ type: "assistant/live-chunk", data: { chunk: { type, index: 0, text: "字" } } });

  chunk("reasoning-delta");
  assert.match(nowRow(), /模型思考中/, "只在推理时还是在思考");

  chunk("text-delta");
  assert.match(nowRow(), /写回答/, "开始出正文就该说在写回答");

  push({ type: "tool/call", data: { callId: "c2", name: "edit" } });
  assert.match(nowRow(), /模型思考中/, "正文收了、调用开始了，就交回时间轨");
});

test("模型一直不出声：过了 10 秒在现在那行说「还没输出」，已经在催就不叠「有点久」", async () => {
  const mount = await loadBadge();
  const waitTags = (view) => collect(view.tree, (node) => node.props?.["data-kind"] === "wait").map(textOf);

  const early = mount(props({ stepStartAt: NOW - 5000, items: [] }));
  early.click(byClass("dws-chip"));
  assert.deepEqual(waitTags(early), [], "五秒还不算异常，先不说");

  const late = mount(props({ stepStartAt: NOW - 12000, items: [] }));
  late.click(byClass("dws-chip"));
  assert.deepEqual(waitTags(late), ["还没输出"]);

  const slowWait = mount(props({ stepStartAt: NOW - 25000, items: [] }));
  slowWait.click(byClass("dws-chip"));
  assert.deepEqual(waitTags(slowWait), ["还没输出"], "已经在催了就不再挂「有点久」");
  assert.doesNotMatch(slowWait.text(), /有点久/);
});

test("说着说着断了：超过 5 秒在现在那行说「停了 Xs」，新一段来了就撤", async () => {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    const events = [];
    let change = { kind: "append", entries: [] };
    const listeners = new Set();
    const source = {
      getSnapshot: () => ({ entries: events.slice(), change }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
    const mount = await loadBadge({ sessions: { binding: () => ({ eventSource: source }) } });
    const view = mount({ ...props({ stepStartAt: clock - 3000, items: [] }), sid: "s1" });
    view.click(byClass("dws-chip"));
    const waitTags = () => collect(view.tree, (node) => node.props?.["data-kind"] === "wait").map(textOf);
    const push = (event) => {
      const entry = { type: "transient", event };
      events.push(entry);
      change = { kind: "append", entries: [entry] };
      for (const fn of listeners) fn();
      view.rerender();
    };
    const chunk = (type) => push({ type: "assistant/live-chunk", data: { chunk: { type, index: 0, text: "字" } } });

    chunk("text-delta");
    assert.deepEqual(waitTags(), [], "刚吐过字，不该说停了");

    clock += 6000;
    view.rerender();
    assert.match(waitTags()[0] ?? "", /停了\s*6(\.0)?s/);

    chunk("text-delta");
    assert.deepEqual(waitTags(), [], "又出声了，这句就撤");
  } finally {
    Date.now = realNow;
  }
});

test("时间轨固定 4 行：有没有「现在」那行，总行数都不变", async () => {
  const mount = await loadBadge();
  const count = (view) => collect(view.tree, byClass("dws-item")).length;

  const thinking = mount(props());
  thinking.click(byClass("dws-chip"));
  assert.equal(count(thinking), 4, "思考中：三条历史 + 一行现在");
  assert.equal(collect(thinking.tree, byClass("dws-item-now")).length, 1);

  const runningRow = call("read", "lib/activity.js", "running", { id: "run-1", t0: NOW - 900, t1: 0 });
  const running = mount(props({ items: [...FIVE_CALLS, runningRow] }));
  running.click(byClass("dws-chip"));
  assert.equal(count(running), 4, "工具在跑：四行历史，没有现在那行");
  assert.equal(collect(running.tree, byClass("dws-item-now")).length, 0);

  const done = mount(props({ phase: "done" }));
  done.click(byClass("dws-chip"));
  assert.equal(count(done), 4, "本轮结束：四行历史");
});

test("问题还挂着时说「等你回答」，答完了记成「向你提问」", async () => {
  const mount = await loadBadge();
  const open = call("ask_user_question", "", "running", { id: "ask-1", t0: NOW - 3000, t1: 0 });
  const waiting = mount(props({ items: [...FIVE_CALLS, open] }));
  waiting.click(byClass("dws-chip"));
  assert.match(textOf(waiting.tree), /等你回答/, "还没回答就别写成普通工具在跑");

  const answered = mount(props({ items: [...FIVE_CALLS, { ...open, status: "ok", t1: NOW - 1000 }] }));
  answered.click(byClass("dws-chip"));
  assert.match(textOf(answered.tree), /向你提问/, "答完了就回到平常的说法");
  assert.doesNotMatch(textOf(answered.tree), /等你回答/);
});

test("有 todo 才报进度，没清单就不画那行", async () => {
  const mount = await loadBadge();
  const todos = [
    { content: "读代码", status: "completed" },
    { content: "改渲染", status: "in_progress" },
    { content: "补测试", status: "pending" },
  ];
  const view = mount(props({}, todos));
  view.click(byClass("dws-chip"));
  const progress = collect(view.tree, byClass("dws-progress"));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].props["data-mode"], "determined");
  assert.match(textOf(progress[0]), /1\/3/);
  assert.match(textOf(progress[0]), /33%/);

  const plain = mount(props());
  plain.click(byClass("dws-chip"));
  assert.equal(collect(plain.tree, byClass("dws-progress")).length, 0, "没有清单就不画那行，不摆「未知」");
});

test("进行中的这一步只在时间轴上出现一次，不再单独占一行", async () => {
  const mount = await loadBadge();
  const stats = {
    "model|ops_bash": [2000, 3000, 4000, 6000, 9000],
    "tool|local|ops_bash": [200, 300, 400, 600, 900],
  };

  const running = mount(props(activity({
    startedAt: NOW - 20000,
    stepSig: "ops_bash",
    stepStartAt: NOW - 5000,
    stepModelMs: 3000,
    stepToolCat: { local: 500 },
    stepStats: stats,
  })));
  running.click(byClass("dws-chip"));
  assert.equal(collect(running.tree, byClass("dws-progress")).length, 0, "步级不再单独占一行");
  assert.match(textOf(running.tree), /本步|看文件|运行测试|写入文件|查看|读网页|运行命令/, "时间轴里仍能看到这一步");

  const waiting = mount(props(activity({ startedAt: NOW - 8000, stepSig: "", stepStartAt: 0 })));
  waiting.click(byClass("dws-chip"));
  assert.equal(collect(waiting.tree, byClass("dws-progress")).length, 0, "没有清单就不画进度行");
});

test("最新三条常显，其余折进本轮历史，点开再收起", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  assert.equal(collect(view.tree, byClass("dws-item")).filter((node) => node.props.className !== "dws-item dws-item-now").length, 3, "常显的应只有最新三条（进行中的那一行不算）");
  assert.equal(collect(view.tree, byClass("dws-raw")).length, 0, "不该再有原始记录行");
  const toggle = collect(view.tree, byClass("dws-history"))[0];
  assert.ok(toggle, "没有历史折叠按钮");
  assert.match(textOf(toggle), /历史/);

  view.click(byClass("dws-history"));
  assert.equal(collect(view.tree, byClass("dws-item")).filter((node) => node.props.className !== "dws-item dws-item-now").length, 5, "点开后应看到本轮全部记录");
  view.click(byClass("dws-history"));
  assert.equal(collect(view.tree, byClass("dws-item")).filter((node) => node.props.className !== "dws-item dws-item-now").length, 3, "再点应收回三条");
});

test("展开历史后新开始的操作仍在时间轨最上面", async () => {
  let state = activity({ items: FIVE_CALLS.map((item, i) => ({ ...item, id: String(i) })) });
  const mount = await loadBadge();
  const view = mount({ useProjection: (name) => name === "workStatus" ? state : [] });
  view.click(byClass("dws-chip"));
  view.click(byClass("dws-history"));
  state = activity({ items: [...state.items, call("read", "new-file.js", "running", { id: "new", t0: NOW, t1: 0 })] });
  view.rerender();
  const rows = collect(view.tree, byClass("dws-item"));
  assert.equal(rows[0].props["data-status"], "running");
  assert.match(textOf(rows[0]), /new-file/);
  assert.equal(rows.filter((row) => row.props["data-status"] === "running").length, 1);
  view.click(byClass("dws-history"));
  const collapsed = collect(view.tree, byClass("dws-item"));
  assert.equal(collapsed[0].props["data-status"], "running");
});

test("快的连招不会把整屏换掉：每行至少停 600ms，后来的排队等位", async () => {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    const step = (id, target, doneAt) => call("read", target, "ok", { id, t0: doneAt - 120, t1: doneAt });
    const items = [step("1", "alpha.js", NOW - 5000), step("2", "beta.js", NOW - 4000), step("3", "gamma.js", NOW - 3000)];
    let state = activity({ items, counts: { steps: 3, tools: 3, errors: 0 } });
    const mount = await loadBadge();
    const view = mount({ useProjection: (name) => (name === "workStatus" ? state : []) });
    view.click(byClass("dws-chip"));
    const rows = () => collect(view.tree, byClass("dws-item"))
      .filter((node) => node.props.className !== "dws-item dws-item-now")
      .map((node) => textOf(node));
    const first = rows();
    assert.equal(first.length, 3);

    const add = (id, target) => {
      clock += 200;
      items.push(step(id, target, clock));
      state = activity({ items: [...items], counts: { steps: items.length, tools: items.length, errors: 0 } });
      view.rerender();
    };

    add("4", "delta.js");
    assert.deepEqual(rows(), first, "刚完成的一步先排队，屏上不该整片换掉");
    add("5", "epsilon.js");
    assert.deepEqual(rows(), first, "没停满 600ms 就还不换");

    clock += 250;
    view.rerender();
    const swapped = rows();
    assert.notDeepEqual(swapped, first, "停满 600ms 之后才让位");
    assert.equal(swapped.length, 3);
    assert.match(swapped[0], /delta/, "排队最久的先顶上，顺序不能乱");
    assert.doesNotMatch(swapped.join(""), /alpha/, "停最久的那行让位");

    clock += 600;
    view.rerender();
    const later = rows();
    assert.match(later.join(""), /epsilon/, "排队的最后都看得到，不丢步");
    assert.doesNotMatch(later.join(""), /beta/);
  } finally {
    Date.now = realNow;
  }
});

test("这一轮结束就不再排队：立刻落到最新几条", async () => {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    const step = (id, target, doneAt) => call("read", target, "ok", { id, t0: doneAt - 120, t1: doneAt });
    const items = [step("1", "alpha.js", NOW - 5000), step("2", "beta.js", NOW - 4000), step("3", "gamma.js", NOW - 3000)];
    let state = activity({ items, counts: { steps: 3, tools: 3, errors: 0 } });
    const mount = await loadBadge();
    const view = mount({ useProjection: (name) => (name === "workStatus" ? state : []) });
    view.click(byClass("dws-chip"));
    clock += 200;
    items.push(step("4", "delta.js", clock));
    state = activity({ items: [...items], counts: { steps: 4, tools: 4, errors: 0 } });
    view.rerender();

    state = activity({ phase: "done", items: [...items], counts: { steps: 4, tools: 4, errors: 0 } });
    view.rerender();
    const text = textOf(view.tree);
    assert.match(text, /delta/, "收尾时最新那步立刻可见，不等排队");
    const rows = collect(view.tree, byClass("dws-item"));
    assert.equal(rows.length, 4, "结束态常显四条");
  } finally {
    Date.now = realNow;
  }
});

test("点 × 收起后本轮不再出现，下一轮重新出现", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  view.click(byClass("dws-close"));
  assert.equal(collect(view.tree, byClass("dws-chip")).length, 0);

  const nextTurn = mount(props({ turn: 4, startedAt: NOW - 1000 }));
  assert.equal(collect(nextTurn.tree, byClass("dws-chip")).length, 1);
});

test("面板只有一层滚动：自身 max-height，不再嵌套", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  const scrollers = collect(view.tree, (node) => {
    const style = node.props?.style;
    return style !== undefined && typeof style === "object" && String(style.overflowY ?? "") === "auto";
  });
  assert.equal(scrollers.length, 0);
  const panelStyle = collect(view.tree, byClass("dws-panel"))[0].props.style;
  assert.ok(panelStyle === undefined || panelStyle.maxHeight !== undefined || panelStyle.visibility === "hidden");
});

test("目标与当前问题各占一行：用户能对上号，阶段标题只在变化时出现", async () => {
  const mount = await loadBadge();
  const view = mount(props(activity({
    prompt: "把活动卡片重做成三层信息",
    stage: { label: "重做卡片的信息层级", kind: "todo" },
    items: FIVE_CALLS.map((item) => ({ ...item, stage: "重做卡片的信息层级" })),
  })));
  view.click(byClass("dws-chip"));
  const goal = collect(view.tree, byClass("dws-goal"))[0];
  const stage = collect(view.tree, byClass("dws-stage-line"))[0];
  assert.ok(goal && textOf(goal).includes("把活动卡片重做成三层信息"));
  assert.ok(stage && textOf(stage).includes("重做卡片的信息层级"));
  assert.equal(collect(view.tree, byClass("dws-stage")).length, 0, "只有一个阶段时不加分组标题");
});

test("上下文维护作为普通记录进时间轨，不再单独一栏", async () => {
  const op = (id, acp, range, extra) => ({
    id, acp, range, status: "ok", saved: null, block: "", at: NOW - 5000, ms: 1800, ...extra,
  });
  const mount = await loadBadge();
  const oldCalls = FIVE_CALLS.map((item) => ({ ...item, t0: NOW - 30000, t1: NOW - 20000 }));
  const view = mount(props(activity({
    items: oldCalls,
    acp: {
      ops: [
        op("c1", "compress", "m00001–m00065", { saved: 6400, at: NOW - 2000 }),
        op("c2", "acp_status", "", { at: NOW - 3000 }),
        op("c3", "decompress", "", { block: "b2", at: NOW - 4000 }),
        op("c4", "decompress", "", { block: "b1", status: "failed", at: NOW - 1000, error: "Error: [Compression FAILED: Requested range(s) cannot be anchored]" }),
      ],
      blocks: {},
      status: null,
    },
  })));
  view.click(byClass("dws-chip"));

  assert.equal(collect(view.tree, byClass("dws-ctx-head")).length, 0, "不再有独立的上下文维护入口");
  assert.equal(collect(view.tree, byClass("dws-ctx-row")).length, 0);

  const rows = collect(view.tree, byClass("dws-item")).map(textOf).join(" | ");
  assert.match(rows, /压缩上下文/, "上下文操作就是普通记录");
  assert.match(rows, /m00001–m00065/);
  assert.match(rows, /省 ~6\.4K/, "只有事件里写了数字才显示省下多少");
  assert.match(rows, /没压成：范围已失效/, "失败要说清楚，不甩原始报错");
  const failed = collect(view.tree, byClass("dws-item")).filter((node) => node.props["data-status"] === "error");
  assert.equal(failed.length, 1);
});

test("统计缺失时不编数字：只有范围就只写范围", async () => {
  const mount = await loadBadge();
  const view = mount(props(activity({
    items: FIVE_CALLS,
    acp: {
      ops: [{ id: "c1", acp: "compress", range: "m00001–m00009", status: "ok", saved: null, block: "", at: NOW - 500, ms: 900 }],
      blocks: {},
      status: null,
    },
  })));
  view.click(byClass("dws-chip"));
  const rows = collect(view.tree, byClass("dws-item")).map(textOf).join(" | ");
  assert.match(rows, /压缩上下文/);
  assert.match(rows, /m00001–m00009/);
  assert.doesNotMatch(rows, /省 ~/, "没有数字就不能出现“省”");
});

test("压缩因范围失效被拒时，说清楚“没压成”，而不是只甩原始报错", async () => {
  const mount = await loadBadge();
  const stale = {
    id: "call_stale",
    acp: "compress",
    range: "m00301–m00356",
    status: "failed",
    saved: null,
    block: "",
    at: NOW,
    ms: 27,
    args: "{\"startId\":\"m00301\",\"endId\":\"m00356\"}",
    detail:
      "Error: [Compression FAILED: Requested range(s) cannot be anchored (e.g. m00301..m00356): refs m00301, m00356, m00361 are DEAD]",
    error:
      "Error: [Compression FAILED: Requested range(s) cannot be anchored (e.g. m00301..m00356): refs m00301, m00356, m00361 are DEAD]",
    reason: "",
  };
  const view = mount(props({ acp: { blocks: {}, status: null, ops: [stale] } }));
  view.click(byClass("dws-chip"));
  const text = textOf(view.tree);
  assert.match(text, /没压成/, "要说清这次没有压缩任何内容");
  assert.match(text, /范围已失效/, "要给出原因");
  assert.doesNotMatch(text, /Compression FAILED/, "原文只进悬停详情，不进正文");
});

test("模型思考、没有工具在跑时：进行中这一行写“思考中”，不重复上一个已完成的动作", async () => {
  const mount = await loadBadge();
  const items = [call("grep", "1070,1105p", "ok")];
  const view = mount(props({ items, stepStartAt: NOW - 3000 }));
  view.click(byClass("dws-chip"));
  const now = collect(view.tree, byClass("dws-item-now"));
  assert.equal(now.length, 1);
  assert.match(textOf(now[0]), /思考中/);
  assert.doesNotMatch(textOf(now[0]), /1070,1105p/);
  const running = collect(view.tree, (node) => node.props?.["data-status"] === "running");
  assert.equal(running.length, 1, "同一时刻只有一行进行中");
});

test("上一轮的上下文压缩不留在本轮：时间轨和计数只算本轮开始之后的", async () => {
  const mount = await loadBadge();
  const startedAt = NOW - 60000;
  const op = (id, at, status = "ok") => ({ id, acp: "compress", range: "m" + id, status, at, ms: 100, saved: 1000 });
  const acp = { blocks: {}, status: null, ops: [op("00001", startedAt - 5000, "failed"), op("00002", startedAt - 4000), op("00003", startedAt + 1000)] };
  const view = mount(props({ acp, startedAt }));
  view.click(byClass("dws-chip"));
  view.click(byClass("dws-history"));
  const text = view.text();
  assert.match(text, /m00003/);
  assert.doesNotMatch(text, /m00001|m00002/);
  const metric = collect(view.tree, byClass("dws-metric")).map(textOf).join(" ");
  assert.match(metric, /压缩1 次/);
  assert.doesNotMatch(metric, /失败/);
});

test("推理和工具各取宿主算好的本轮合计", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done", modelMs: 14000, toolMs: 633, stepModelDone: true }));
  view.click(byClass("dws-chip"));
  const metric = collect(view.tree, byClass("dws-metric")).map(textOf).join(" | ");
  assert.match(metric, /推理14s/);
  assert.match(metric, /工具633ms/);
});

test("一步展开后写成“几点 → 几点”与用时", async () => {
  const mount = await loadBadge();
  const items = [call("read", "lib/client.js", "ok", { t0: NOW - 1565, t1: NOW - 1000 })];
  const view = mount(props({ items, phase: "done" }));
  view.click(byClass("dws-chip"));
  view.click(byClass("dws-row"));
  const detail = textOf(collect(view.tree, byClass("dws-detail"))[0]);
  assert.match(detail, /\d\d:\d\d:\d\d\s*→\s*\d\d:\d\d:\d\d/);
  assert.match(detail, /用时 565ms/);
});

test("收起按钮不在滚动区里：头尾固定，只有中间一段滚动", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  const panel = collect(view.tree, byClass("dws-panel"))[0];
  const kids = panel.props.children.filter(Boolean).map((node) => String(node.props?.className ?? ""));
  assert.deepEqual(kids, ["dws-head", "dws-body", "dws-foot"]);
  assert.equal(collect(collect(view.tree, byClass("dws-body"))[0], byClass("dws-foot")).length, 0);
});

test("上一轮单独成块：写明第几轮、起止时间、当时的目标，展开是那一轮自己的记录", async () => {
  const mount = await loadBadge();
  const prev = {
    turn: 2, prompt: "先分析，先不改", startedAt: NOW - 200000, endedAt: NOW - 120000, steps: 2, errors: 0,
    modelMs: 9000, toolMs: 400,
    items: [call("write", "docs/HANDOFF.md", "ok", { id: "w1" })],
    ctx: [{ id: "c9", acp: "compress", range: "m09000-m09010", status: "ok", at: NOW - 130000, ms: 80 }],
  };
  const view = mount(props({ prev }));
  view.click(byClass("dws-chip"));
  const block = collect(view.tree, byClass("dws-prev"))[0];
  assert.match(textOf(block), /上一轮 · 第 2 轮/);
  assert.match(textOf(block), /\d\d:\d\d → \d\d:\d\d · 2 步/);
  assert.match(textOf(block), /先分析，先不改/);
  view.click(byClass("dws-prev-head"));
  const opened = textOf(collect(view.tree, byClass("dws-prev"))[0]);
  assert.match(opened, /交接文档/);
  assert.match(opened, /m09000-m09010/);
  assert.match(opened, /推理 9.0s · 工具 400ms/);
});

test("node -e 内联脚本：不把脚本正文里的 const、require、copy 当成命令", async () => {
  const mount = await loadBadge();
  const items = [
    call("ops_bash", "cd \"C:/x/plugin\" && node -e \"\nconst fs=require('fs');const copy = require('./a');\nfs.copyFileSync('a','b');\"", "ok", { t0: NOW - 9000, t1: NOW - 8000 }),
    call("ops_bash", "python -c 'import shutil; shutil.move(\"a\", \"b\")'", "ok", { t0: NOW - 7000, t1: NOW - 6000 }),
  ];
  const view = mount(props({ items, phase: "done" }));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.match(text, /运行 Node/);
  assert.doesNotMatch(text, /复制\/移动文件/);
  assert.doesNotMatch(text, /Node 脚本\s*const/);
});

test("简单对话：没调用工具的一轮写“直接回答”，不显示 0 步、工具 0ms 和空记录，时长按结束时刻算", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done", items: [], counts: { steps: 0, tools: 0, errors: 0 }, startedAt: NOW - 7100, endedAt: NOW, modelMs: 7000, toolMs: 0, stepModelDone: true }));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.match(text, /本轮 · 直接回答/);
  assert.doesNotMatch(text, /0 步|工具|noEvents|还没有动作/);
  assert.match(textOf(collect(view.tree, byClass("dws-head-time"))[0]), /7\.1s/);
});

test("已结束的轮次：标题时长是结束减开始，不随打开面板的时刻变大", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done", startedAt: NOW - 3_000_000, endedAt: NOW - 2_940_000 }));
  view.click(byClass("dws-chip"));
  assert.equal(textOf(collect(view.tree, byClass("dws-head-time"))[0]), "1m00s");
});

test("底栏“日志”：会话总计与逐轮记录，新的在前；再点“返回”回到本轮", async () => {
  const mount = await loadBadge();
  const totals = { turns: 56, rounds: 1235, steps: 1131, ops: 1187, errors: 25, ctx: 31, ctxFailed: 5, modelMs: 6_061_639, toolMs: 1_211_092, wallMs: 7_334_528, firstAt: NOW - 9e6, lastAt: NOW };
  const history = [
    { turn: 55, startedAt: NOW - 200000, endedAt: NOW - 174000, wallMs: 26000, rounds: 3, ops: 2, errors: 0, modelMs: 25600, toolMs: 448, ctx: 0, prompt: "先分析，先不改", phase: "done" },
    { turn: 56, startedAt: NOW - 100000, endedAt: NOW - 60500, wallMs: 39500, rounds: 5, ops: 4, errors: 0, modelMs: 38400, toolMs: 807, ctx: 2, prompt: "是接手继续开发", phase: "aborted" },
  ];
  const view = mount(props({ phase: "done", totals, history }));
  view.click(byClass("dws-chip"));
  view.click(byClass("dws-log-toggle"));
  const log = collect(view.tree, byClass("dws-log"))[0];
  const text = textOf(log);
  assert.match(text, /共 56 轮 · 1235 步 · 1187 次调用/);
  assert.match(text, /推理 1h41m · 工具 20m11s/);
  assert.match(text, /压缩 31 次/);
  assert.ok(text.indexOf("第 56 轮") < text.indexOf("第 55 轮"), "新的在前");
  assert.match(text, /5 步 · 4 次调用/);
  assert.match(text, /已中断/);
  assert.match(text, /是接手继续开发/);
  assert.equal(collect(view.tree, byClass("dws-rail")).length, 0, "日志视图里不画本轮时间轨");
  assert.equal(collect(view.tree, byClass("dws-log-copy")).length, 1);
  view.click(byClass("dws-log-toggle"));
  assert.equal(collect(view.tree, byClass("dws-log")).length, 0);
});

test("不同的内联脚本逐条展示，不能按简写合并", async () => {
  const mount = await loadBadge();
  const view = mount(props({phase:'done',items:[
    call('ops_bash', 'node -e "console.log(1)"', 'ok', {id:'a'}),
    call('ops_bash', 'node -e "console.log(2)"', 'ok', {id:'b'}),
  ]}));
  view.click(byClass('dws-chip'));
  assert.equal(collect(view.tree, byClass('dws-item')).length, 2);
});

test("行内先写看得懂的动作，宿主说明只进悬停与展开", async () => {
  const mount = await loadBadge();
  const view = mount(props({phase:'done',items:[call('ops_bash', 'printf "%-14s %s\n" x; rg version package.json', 'ok', {description:'Check version field consistency and usage'})]}));
  view.click(byClass('dws-chip'));
  const rowText = view.text();
  assert.doesNotMatch(rowText, /Check version field consistency and usage/, "行内不摆英文说明");
  assert.match(rowText, /搜代码|运行命令|运行脚本|运行测试/, "行内要有人话动作");
  const row = collect(view.tree, byClass("dws-row"))[0];
  assert.match(String(row && row.props && row.props.title || ""), /Check version field consistency/, "悬停仍能看到说明");
});

test("思考、工具执行、完成均常显四条，进行中计入四条上限", async () => {
  for (const phase of ['thinking', 'tool', 'done']) {
    const mount = await loadBadge();
    const items = FIVE_CALLS.map((item, index) => ({...item, status: phase === 'tool' && index === 4 ? 'running' : 'ok'}));
    const view = mount(props({phase, items}));
    view.click(byClass('dws-chip'));
    assert.equal(collect(view.tree, byClass('dws-item')).length, 4, phase);
  }
});

test("压缩失败后同一段成功：失败那行划掉转灰，不再挂未恢复", async () => {
  const mount = await loadBadge();
  const op = (over) => Object.assign({
    id: "1", acp: "compress", status: "ok", range: "m00001–m00005",
    at: NOW - 20000, ms: 30, saved: 0, block: "", error: "", detail: "",
  }, over);
  const view = mount(props({
    items: [],
    acp: {
      ops: [
        op({ id: "1", status: "failed", at: NOW - 20000, ms: 27, error: "Compression FAILED: refs are DEAD" }),
        op({ id: "2", status: "ok", at: NOW - 10000, ms: 80, range: "m00001–m00005", saved: 25000 }),
      ],
    },
  }));
  view.click(byClass("dws-chip"));
  const settled = collect(view.tree, byClass("dws-item")).filter((item) => item.props["data-settled"] === "true");
  assert.equal(settled.length, 1, "失败那行应被标记为已了结");
  const text = textOf(view.tree);
  assert.doesNotMatch(text, /未恢复/, "有后续成功时不再挂未恢复");
  assert.doesNotMatch(text, /没压成：范围已失效/, "错误说明不再当正文");
});

test("压缩失败、下一段成功：不把两段混成一次恢复", async () => {
  const mount = await loadBadge();
  const op = (over) => Object.assign({
    id: "1", acp: "compress", status: "ok", range: "m00001–m00005",
    at: NOW - 20000, ms: 30, saved: 0, block: "", error: "", detail: "",
  }, over);
  const view = mount(props({
    items: [],
    acp: {
      ops: [
        op({ id: "1", status: "failed", at: NOW - 20000, ms: 27, range: "m00001–m00005" }),
        op({ id: "2", status: "ok", at: NOW - 10000, ms: 80, range: "m00006–m00020", saved: 25000 }),
      ],
    },
  }));
  view.click(byClass("dws-chip"));
  const settled = collect(view.tree, byClass("dws-item")).filter((item) => item.props["data-settled"] === "true");
  assert.equal(settled.length, 0, "压的是别的段，不能算恢复");
  assert.match(textOf(view.tree), /未恢复/);
});

test("动作对象按目录职责与扩展名归类，认不出的仍写文件名", async () => {
  const mount = await loadBadge();
  const items = [
    call("read", "docs/guide.md", "ok"),
    call("ops_bash", "node --test tests/unknown-thing.test.mjs", "ok"),
    call("edit", "styles/theme.css", "ok"),
  ];
  const view = mount(props({ items, counts: { steps: 3, tools: 3, errors: 0 } }));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.match(text, /文档 guide/, "文档目录按职责归类");
  assert.match(text, /运行测试\s*unknown-thing/, "测试目录按职责归类（命令里只剩文件名也认得出，且不重复“测试”）");
  assert.match(text, /样式 theme/, "样式目录按职责归类");

  const odd = mount(props({ items: [call("read", "weird-blob.bin", "ok")], counts: { steps: 1, tools: 1, errors: 0 } }));
  odd.click(byClass("dws-chip"));
  assert.match(odd.text(), /weird-blob.bin/, "认不出的仍保留文件名，不编解释");
});

test("外部工具名里写着要干什么：认得全就念成人话，缺一个词仍留原名", async () => {
  const mount = await loadBadge();
  const items = [
    call("mcp__github__fetch_issues", "登录页的问题", "ok", { id: "m1" }),
    call("mcp__github__create_pull_request", "bump deps", "ok", { id: "m2" }),
    call("mcp__filesystem__read_file", "lib/client.js", "ok", { id: "m3" }),
    call("mcp__ghost__fetch_widget", "x", "ok", { id: "m4" }),
  ];
  const view = mount(props({ phase: "done", items, counts: { steps: 4, tools: 4, errors: 0 } }));
  view.click(byClass("dws-chip"));
  const verbs = collect(view.tree, byClass("verb")).map(textOf);
  const targets = collect(view.tree, byClass("target")).map(textOf);
  assert.deepEqual(verbs.slice(0, 3), ["读", "新建", "读"], "动词按词表念");
  assert.deepEqual(targets.slice(0, 3), ["议题", "合并请求", "文件"], "对象按词表念");
  assert.ok(verbs.includes("调用外部工具"), "有词不认识就不硬翻");
  assert.ok(targets.includes("fetch widget"), "退回原名，仍看得出调了什么");
});

test("英文界面同一套词表：动词名词都走字典，对象之间用空格", async () => {
  const mount = await loadBadge();
  const dictionary = {
    "intent.mcp.read": "read", "mcp.noun.file": "files", "mcp.noun.content": "contents", "mcp.noun.issue": "issues",
  };
  const t = (key) => (Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key);
  const items = [
    call("mcp__github__get_file_contents", "lib/client.js", "ok", { id: "e1" }),
    call("mcp__github__fetch_issues", "登录页的问题", "ok", { id: "e2" }),
  ];
  const view = mount({ ...props({ phase: "done", items, counts: { steps: 2, tools: 2, errors: 0 } }), t });
  view.click(byClass("dws-chip"));
  const targets = collect(view.tree, byClass("target")).map(textOf);
  assert.deepEqual(targets.slice(0, 2), ["files contents", "issues"], "英文词之间用空格连起来");
});

test("进行中这一步带同类参照：样本够就说区间，超了就说比 75% 久", async () => {
  const mount = await loadBadge();
  const base = {
    phase: "thinking",
    turn: 3,
    startedAt: NOW - 60000,
    stepStartAt: NOW - 1500,
    stepSig: "",
    stepStats: { "model|（无工具）": [3000, 3200, 3400, 3600, 3800] },
  };
  const normal = mount(props(activity(base)));
  normal.click(byClass("dws-chip"));
  assert.match(normal.text(), /同类通常/, "样本够 5 个就说区间");

  const slow = mount(props(activity({ ...base, stepStartAt: NOW - 20000 })));
  slow.click(byClass("dws-chip"));
  assert.match(slow.text(), /比 75% 的同类更久/, "超过 p75 只说事实");

  const thin = mount(props(activity({ ...base, stepStats: { "model|（无工具）": [3000, 3400] } })));
  thin.click(byClass("dws-chip"));
  assert.doesNotMatch(thin.text(), /同类通常/, "样本不足时不编区间");
});

test("冷启动没有本会话样本时，用跨会话历史垫底并标明来源", async () => {
  const mount = await loadBadge();
  const carried = { "model|（无工具）": { n: 12, p25: 3000, med: 4200, p75: 6000 } };
  const view = mount(props(activity({
    phase: "thinking",
    turn: 2,
    stepStartAt: NOW - 1500,
    stepSig: "",
    stepStats: {},
    carried,
  })));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.match(text, /同类通常/, "有历史就给出区间");
  assert.match(text, /据历史/, "并且要说清这段参照来自别的会话");
});

test("工具失败后同一目标再成功：前面那次划掉转灰；换个工具操作同一文件不算恢复", async () => {
  const mount = await loadBadge();
  const same = mount(props({
    counts: { steps: 2, tools: 2, errors: 1 },
    items: [
      call("read", "lib/fail.js", "error", { key: "tool|read|path|/lib/fail.js", err: "ENOENT: no such file" }),
      call("read", "lib/fail.js", "ok", { key: "tool|read|path|/lib/fail.js" }),
    ],
  }));
  same.click(byClass("dws-chip"));
  const settled = collect(same.tree, byClass("dws-item")).filter((item) => item.props["data-settled"] === "true");
  assert.equal(settled.length, 1, "同工具同目标后来又成功，失败那条应被了结");
  assert.doesNotMatch(same.text(), /未恢复/);

  const other = mount(props({
    counts: { steps: 2, tools: 2, errors: 1 },
    items: [
      call("read", "lib/fail.js", "error", { key: "tool|read|path|/lib/fail.js", err: "ENOENT: no such file" }),
      call("edit", "lib/fail.js", "ok", { key: "tool|edit|path|/lib/fail.js" }),
    ],
  }));
  other.click(byClass("dws-chip"));
  assert.equal(collect(other.tree, byClass("dws-item")).filter((item) => item.props["data-settled"] === "true").length, 0);
  assert.match(other.text(), /未恢复/);
});

test("同一处动到第六次才说「第 6 次」：反复五次以内不啰嗦", async () => {
  const mount = await loadBadge();
  const nthTags = (view) => collect(view.tree, (node) => node.props?.["data-kind"] === "nth").map(textOf);
  const edits = (count) => Array.from({ length: count }, (_value, index) =>
    call("edit", "lib/client.js", "ok", { id: "edit-" + index, t0: NOW - 30000 + index * 1000, t1: NOW - 29000 + index * 1000 }));

  const six = mount(props({ phase: "done", items: edits(6), counts: { steps: 6, tools: 6, errors: 0 } }));
  six.click(byClass("dws-chip"));
  assert.deepEqual(nthTags(six), ["第 6 次"], "最新那次是第六次，标一次就够");

  const five = mount(props({ phase: "done", items: edits(5), counts: { steps: 5, tools: 5, errors: 0 } }));
  five.click(byClass("dws-chip"));
  assert.deepEqual(nthTags(five), [], "五次以内是正常迭代，不贴标签");
});

test("失败散着也不会漏掉：一轮里累计三次就在标题旁报数", async () => {
  const mount = await loadBadge();
  const headFlags = (view) => collect(view.tree, byClass("dws-head-flag")).map(textOf);
  const spread = [
    call("ops_bash", "npm test", "error", { id: "f1", err: "boom" }),
    call("read", "lib/a.js", "ok", { id: "k1" }),
    call("ops_bash", "npm run lint", "error", { id: "f2", err: "boom" }),
    call("read", "lib/b.js", "ok", { id: "k2" }),
    call("ops_bash", "npm run build", "error", { id: "f3", err: "boom" }),
  ];
  const three = mount(props({ items: spread, counts: { steps: 5, tools: 5, errors: 3 } }));
  three.click(byClass("dws-chip"));
  assert.equal(headFlags(three).length, 1);
  assert.match(headFlags(three)[0], /失败 3 次/, "没有连着失败也要报总数");

  const two = mount(props({ items: spread.slice(0, 2), counts: { steps: 2, tools: 2, errors: 1 } }));
  two.click(byClass("dws-chip"));
  assert.deepEqual(headFlags(two), [], "一两次失败不值得摆脸色");
});

test("这一轮结束时补一句：失败几次、同一处反复了几次", async () => {
  const mount = await loadBadge();
  const edits = Array.from({ length: 6 }, (_value, index) =>
    call("edit", "lib/client.js", "ok", { id: "edit-" + index, t0: NOW - 30000 + index * 1000, t1: NOW - 29000 + index * 1000 }));
  const fails = [
    call("ops_bash", "npm test", "error", { id: "f1", err: "boom" }),
    call("ops_bash", "npm run lint", "error", { id: "f2", err: "boom" }),
    call("ops_bash", "npm run build", "error", { id: "f3", err: "boom" }),
  ];
  const done = mount(props({ phase: "done", items: [...edits, ...fails], counts: { steps: 9, tools: 9, errors: 3 } }));
  done.click(byClass("dws-chip"));
  const sum = collect(done.tree, byClass("dws-sum"));
  assert.equal(sum.length, 1, "收尾只留一句");
  assert.match(textOf(sum[0]), /失败 3 次/);
  assert.match(textOf(sum[0]), /同一处 6 次/);

  const running = mount(props({ items: [...edits, ...fails], counts: { steps: 9, tools: 9, errors: 3 } }));
  running.click(byClass("dws-chip"));
  assert.equal(collect(running.tree, byClass("dws-sum")).length, 0, "还在跑就先别下结论");
});

test("切会话重新挂载：吉祥物已在页面上，首帧就不画徽标（不闪）", async () => {
  const mount = await loadBadge();
  globalThis.document.querySelector = (selector) => (selector.includes("dsh-claude-deepy") ? { style: {}, getAttribute: () => null, setAttribute() {} } : null);
  const view = mount(props({ phase: "done" }));
  assert.equal(collect(view.tree, byClass("dws-chip")).length, 0);
});

test("主题在但吉祥物还没画出来：先不画徽标，等宽限期", async () => {
  const mount = await loadBadge();
  globalThis.document.querySelector = (selector) => (selector === "body[data-dsh-claude-style]" ? {} : null);
  const view = mount(props({ phase: "done" }));
  assert.equal(collect(view.tree, byClass("dws-chip")).length, 0);
});

test("没有主题也没有吉祥物：照旧马上画徽标", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done" }));
  assert.equal(collect(view.tree, byClass("dws-chip")).length, 1);
});

// ── 下载进度 ─────────────────────────────────────────────────────────────────

/** 一帧里的异步 tick 走完：fetch 的 promise 链至少两个微任务。 */
async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function fakeFetch(payload) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

test("下载区读的是本插件的只读接口，有任务才出现在面板里", async () => {
  const fetchImpl = fakeFetch({ jobs: [] });
  const mount = await loadBadge({ fetch: fetchImpl });
  const view = mount(props());
  await flushMicrotasks();
  view.rerender();
  view.click(byClass("dws-chip"));
  assert.deepEqual(fetchImpl.calls, ["/api/dsh-work-status/downloads"], "打的必须是插件自己的接口");
  assert.equal(collect(view.tree, byClass("dws-dl")).length, 0, "没有任务时不留一块空白");

  const running = fakeFetch({
    jobs: [{ id: "d1", status: "running", phase: "downloading", totalBytes: 10000000, receivedBytes: 2500000, speedBps: 2500000, filename: "model.gguf" }],
  });
  const mount2 = await loadBadge({ fetch: running });
  const view2 = mount2(props());
  await flushMicrotasks();
  view2.rerender();
  view2.click(byClass("dws-chip"));
  const rows = collect(view2.tree, byClass("dws-dl"));
  assert.equal(rows.length, 1);
  const text = textOf(rows[0]);
  assert.match(text, /下载/);
  assert.match(text, /model\.gguf/);
  assert.match(text, /25%/);
  assert.match(text, /2\.4 MB\/s/);
  assert.match(text, /剩/, "有速度就该给剩余时间");
});

test("下载进程没了却还写着下载中：标成中断，不假装在跑", async () => {
  const fetchImpl = fakeFetch({
    jobs: [{ id: "d2", status: "running", phase: "downloading", totalBytes: 100, receivedBytes: 40, speedBps: 0, filename: "a.bin", stale: true }],
  });
  const mount = await loadBadge({ fetch: fetchImpl });
  const view = mount(props());
  await flushMicrotasks();
  view.rerender();
  view.click(byClass("dws-chip"));
  const row = collect(view.tree, byClass("dws-dl"))[0];
  assert.equal(row.props["data-status"], "error");
  assert.match(textOf(row), /中断/);
});

test("下载区最多列四条：卡片是概览，不是下载管理器", async () => {
  const jobs = Array.from({ length: 8 }, (_v, i) => ({ id: "j" + i, status: "done", phase: "done", filename: "f" + i + ".bin", totalBytes: 10, receivedBytes: 10 }));
  const mount = await loadBadge({ fetch: fakeFetch({ jobs }) });
  const view = mount(props());
  await flushMicrotasks();
  view.rerender();
  view.click(byClass("dws-chip"));
  assert.equal(collect(view.tree, byClass("dws-dl")).length, 4);
});

test("接口挂了就安静：不崩、不画下载区", async () => {
  const mount = await loadBadge({ fetch: async () => { throw new Error("offline"); } });
  const view = mount(props());
  await flushMicrotasks();
  view.rerender();
  view.click(byClass("dws-chip"));
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 1, "主卡片照常");
  assert.equal(collect(view.tree, byClass("dws-dl")).length, 0);
});

// ── 下载进度：收起态与轮次结束后 ─────────────────────────────────────────────

const RUNNING_JOB = {
  id: "d9", status: "running", phase: "downloading",
  totalBytes: 10000000, receivedBytes: 4000000, speedBps: 2000000, filename: "big.bin",
};

test("面板收起、下载还在跑：徽标旁留一条常驻进度，不跟着消失", async () => {
  const mount = await loadBadge({ fetch: fakeFetch({ jobs: [RUNNING_JOB] }) });
  const view = mount(props());
  await flushMicrotasks();
  view.rerender();
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 0, "面板是收起的");
  const strip = collect(view.tree, byClass("dws-strip"));
  assert.equal(strip.length, 1, "收起时也要看得见下载");
  const row = collect(strip[0], byClass("dws-dl"));
  assert.equal(row.length, 1);
  assert.match(textOf(row[0]), /big\.bin/);
  assert.match(textOf(row[0]), /40%/);
});

test("轮次已经结束、下载还在跑：卡片不整个消失，下载行留着", async () => {
  const mount = await loadBadge({ fetch: fakeFetch({ jobs: [RUNNING_JOB] }) });
  const view = mount(props({ phase: "done" }));
  await flushMicrotasks();
  view.rerender();
  assert.equal(collect(view.tree, byClass("dws-chip")).length, 1, "结束的这轮照样有徽标");
  assert.equal(collect(view.tree, byClass("dws-dl")).length, 1, "下载还活着就不能一起藏起来");
});

test("下载跑完了、面板收着：常驻条自动收起，不留一条没用的空条", async () => {
  const done = { ...RUNNING_JOB, status: "done", phase: "done", receivedBytes: 10000000, speedBps: 0 };
  const mount = await loadBadge({ fetch: fakeFetch({ jobs: [done] }) });
  const view = mount(props({ phase: "done" }));
  await flushMicrotasks();
  view.rerender();
  assert.equal(collect(view.tree, byClass("dws-strip")).length, 0);
});

test("完全没有下载任务又不在跑：一律不画（不装下载功能的人看不到变化）", async () => {
  const mount = await loadBadge({ fetch: fakeFetch({ jobs: [] }) });
  const view = mount(props({ phase: "done" }));
  await flushMicrotasks();
  view.rerender();
  assert.equal(collect(view.tree, byClass("dws-strip")).length, 0);
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 0);
});

// ── 术语解释 ─────────────────────────────────────────────────────────────────

/** 打开面板、展开第一行，回读那行下面的大白话（没展开时这里应当是空的）。 */
async function glossAfterOpen(item) {
  const mount = await loadBadge();
  const view = mount(props({ items: [item] }));
  view.click(byClass("dws-chip"));
  assert.equal(view.walk((tree) => collect(tree, byClass("dws-gloss")).length), 0, "行没展开就不占地方");
  const rows = view.walk((tree) => collect(tree, (node) => node.props?.["data-open"] !== undefined && node.props?.onClick));
  assert.ok(rows.length > 0, "找不到可展开的行");
  rows[0].props.onClick();
  view.rerender();
  return view.walk((tree) => collect(tree, byClass("dws-gloss")).map(textOf));
}

test("点开一步能看到那句大白话；解释跟着动作走，不是同一句", async () => {
  const gloss = await glossAfterOpen(call("ops_bash", "node --test tests/x.test.mjs", "ok"));
  assert.equal(gloss.length, 1);
  assert.match(gloss[0], /自动检查/, "运行测试要解释成「验证改动没弄坏别的」");

  const other = await glossAfterOpen(call("ops_bash", "git diff --stat", "ok"));
  assert.equal(other.length, 1);
  assert.notEqual(other[0], gloss[0], "不同动作给不同解释");
});
test("认不出的工具不给假解释：没有词条就不加那一行", async () => {
  const mount = await loadBadge();
  const view = mount(props({ items: [call("mystery_tool_xyz", "something", "ok")] }));
  view.click(byClass("dws-chip"));
  const rows = view.walk((tree) => collect(tree, (node) => node.props?.["data-open"] !== undefined && node.props?.onClick));
  rows[0].props.onClick();
  view.rerender();
  assert.equal(view.walk((tree) => collect(tree, byClass("dws-gloss")).length), 0);
});

// ── 回归：进行中的行不许沉下去，下载条不许闪没 ───────────────────────────────

test("进行中的那一步当场出现在最上面：不跟刚跑完的行一起排队", async () => {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    const step = (id, target, doneAt) => call("read", target, "ok", { id, t0: doneAt - 120, t1: doneAt });
    const items = [
      step("1", "alpha.js", NOW - 5000),
      step("2", "beta.js", NOW - 4000),
      step("3", "gamma.js", NOW - 3000),
      step("4", "delta.js", NOW - 2000),
      step("5", "epsilon.js", NOW - 1000),
    ];
    let state = activity({ items, counts: { steps: 5, tools: 5, errors: 0 } });
    const mount = await loadBadge();
    const view = mount({ useProjection: (name) => (name === "workStatus" ? state : []) });
    view.click(byClass("dws-chip"));
    const rows = () => collect(view.tree, byClass("dws-item"))
      .filter((node) => node.props.className !== "dws-item dws-item-now")
      .map((node) => textOf(node));
    const before = rows();
    assert.equal(before.length, 3, "没有工具在跑时，那格留给“模型在想什么”");

    // 一个还在跑的动作进场，同一瞬间还有一个刚跑完的普通步。
    clock += 200;
    items.push(call("ops_bash", "npm test", "running", { id: "run-1", t0: clock, t1: 0 }));
    items.push(step("6", "zeta.js", clock));
    state = activity({ items: [...items], counts: { steps: 7, tools: 7, errors: 0 } });
    view.rerender();

    const now = rows();
    assert.equal(now.length, 4, "有工具在跑：四行历史，卡片不许撑高");
    assert.match(now[0], /运行测试/, "正在跑的那步必须当场在最上面，不许被排队藏到下面");
    assert.doesNotMatch(now.join(""), /zeta/, "刚跑完的普通步该排队让位，不能抢");
  } finally {
    Date.now = realNow;
  }
});

test("轮询一时失败：已经在跑的下载条不许清空闪没", async () => {
  const pending = [];
  const realSetTimeout = globalThis.setTimeout;
  let fail = false;
  const flaky = async () => {
    if (fail) throw new Error("offline");
    return { ok: true, json: async () => ({ jobs: [RUNNING_JOB] }) };
  };
  globalThis.setTimeout = (fn) => { pending.push(fn); return 0; };
  try {
    const mount = await loadBadge({ fetch: flaky });
    const view = mount(props());
    await flushMicrotasks();
    view.rerender();
    assert.equal(collect(view.tree, byClass("dws-strip")).length, 1, "先拿到一波数据");

    fail = true;
    const nextTick = pending.shift();
    assert.equal(typeof nextTick, "function", "应该已经排了下一轮");
    await nextTick();
    await flushMicrotasks();
    view.rerender();

    assert.equal(collect(view.tree, byClass("dws-strip")).length, 1, "接口抽一下不该把下载条清掉");
    assert.equal(collect(view.tree, byClass("dws-dl")).length, 1);
    assert.match(view.text(), /big\.bin/, "旧数据还在，等下一轮成功");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
