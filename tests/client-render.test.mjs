import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const file = path.join(import.meta.dirname, "..", "lib", "client.js");

// 组件里的 useNow 会开一秒一次的定时器，测试不需要它打转。
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

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

  globalThis.window = { __ModuleLoader__: { load: (value) => { config = value; } } };
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
  assert.match(String(chips[0].props["aria-label"]), /改文件 数据代码/);
});

test("点开面板：当前动作在标题，最近几步各说各的事", async () => {
  const mount = await loadBadge();
  const view = mount(props());
  view.click(byClass("dws-chip"));
  assert.equal(collect(view.tree, byClass("dws-panel")).length, 1);
  const head = textOf(collect(view.tree, byClass("dws-head-text"))[0]);
  assert.match(textOf(view.tree), /改文件s*界面代码/, "展开面板后正文里能看到最近的动作");

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
  assert.match(nowRow(), /读文件/);
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

test("问题还挂着时说「等你回答」，答完了记成「问你一句」", async () => {
  const mount = await loadBadge();
  const open = call("ask_user_question", "", "running", { id: "ask-1", t0: NOW - 3000, t1: 0 });
  const waiting = mount(props({ items: [...FIVE_CALLS, open] }));
  waiting.click(byClass("dws-chip"));
  assert.match(textOf(waiting.tree), /等你回答/, "还没回答就别写成普通工具在跑");

  const answered = mount(props({ items: [...FIVE_CALLS, { ...open, status: "ok", t1: NOW - 1000 }] }));
  answered.click(byClass("dws-chip"));
  assert.match(textOf(answered.tree), /问你一句/, "答完了就回到平常的说法");
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
  assert.match(textOf(running.tree), /本步|读文件|跑测试|写文件|查看|打开|执行/, "时间轴里仍能看到这一步");

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
  assert.match(metric, /上下文压缩1 次/);
  assert.doesNotMatch(metric, /失败/);
});

test("模型推理和工具调用各取宿主算好的本轮合计", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done", modelMs: 14000, toolMs: 633, stepModelDone: true }));
  view.click(byClass("dws-chip"));
  const metric = collect(view.tree, byClass("dws-metric")).map(textOf).join(" | ");
  assert.match(metric, /模型推理14s/);
  assert.match(metric, /工具调用633ms/);
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
  assert.match(text, /跑 Node 脚本/);
  assert.doesNotMatch(text, /复制\/移动文件/);
  assert.doesNotMatch(text, /Node 脚本\s*const/);
});

test("简单对话：没调用工具的一轮写“直接回答”，不显示 0 步、工具 0ms 和空记录，时长按结束时刻算", async () => {
  const mount = await loadBadge();
  const view = mount(props({ phase: "done", items: [], counts: { steps: 0, tools: 0, errors: 0 }, startedAt: NOW - 7100, endedAt: NOW, modelMs: 7000, toolMs: 0, stepModelDone: true }));
  view.click(byClass("dws-chip"));
  const text = view.text();
  assert.match(text, /本轮 · 直接回答/);
  assert.doesNotMatch(text, /0 步|工具调用|noEvents|还没有动作/);
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
  assert.match(text, /上下文压缩 31 次/);
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
  assert.match(rowText, /找代码|执行命令|跑脚本|跑测试/, "行内要有人话动作");
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
  assert.match(text, /跑测试s*unknown-thing/, "测试目录按职责归类（命令里只剩文件名也认得出，且不重复“测试”）");
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
  assert.ok(verbs.includes("用外部工具"), "有词不认识就不硬翻");
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
