import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dws-step-"));
const file = path.join(dir, "step-stats.json");
process.env.DSH_WORK_STATUS_STATS = file;

const { activityProjection } = await import("../lib/activity.js");
const store = await import("../lib/step-store.js");

const at = (ms) => 1790000000000 + ms;
const ev = (type, time, data = {}) => ({ type, time, data });

/** 跑一轮：一个 read 步（约 2s）。 */
function foldTurn(state, turn) {
  let next = activityProjection.apply(state, ev("turn/start", at(turn * 100000), { turn }));
  next = activityProjection.apply(next, ev("step/start", at(turn * 100000 + 10), { turn, step: 1 }));
  next = activityProjection.apply(next, ev("tool/call", at(turn * 100000 + 20), { turn, step: 1, callId: "c1", name: "read", arguments: '{"path":"a.txt"}' }));
  next = activityProjection.apply(next, ev("tool/result", at(turn * 100000 + 2020), { turn, step: 1, callId: "c1", message: { content: [{ type: "tool-result", text: "ok" }] } }));
  next = activityProjection.apply(next, ev("step/end", at(turn * 100000 + 2100), { turn, step: 1 }));
  return activityProjection.apply(next, ev("turn/end", at(turn * 100000 + 8000), { turn, reason: "stop" }));
}

test("turn/end 把同类步样本写进本机小文件，新会话能直接拿来当参照", () => {
  store.resetHistoryCache();
  let state = activityProjection.init();
  for (let turn = 1; turn <= 6; turn += 1) state = foldTurn(state, turn);

  assert.ok(fs.existsSync(file), "文件应该被创建");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.v, 1);
  assert.ok(Object.keys(saved.samples).includes("model|read"), "按首个工具归档");
  assert.ok(saved.samples["model|read"].length >= 5, "攒够五次就该有五个样本");

  // 新会话：重置缓存与状态，模拟冷启动读历史。
  store.resetHistoryCache();
  const fresh = activityProjection.init();
  assert.ok(fresh.carried && fresh.carried["model|read"], "冷启动时载体里应该已经有历史参照");
  assert.ok(fresh.carried["model|read"].n >= 5);
  assert.ok(fresh.carried["model|read"].p25 > 0 && fresh.carried["model|read"].p75 >= fresh.carried["model|read"].p25);
});

test("文件里只有归类键和耗时数字，没有路径、命令或提示词", () => {
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /[A-Za-z]:\\\\/, "不该出现盘符路径");
  assert.doesNotMatch(raw, /echo hi|a\.txt/, "不该出现命令或文件名");
  const saved = JSON.parse(raw);
  for (const [key, samples] of Object.entries(saved.samples)) {
    assert.match(key, /^(model|tool)\|/, "键只能是 model| / tool| 开头");
    for (const value of samples) assert.equal(typeof value, "number", "样本只能是数字");
  }
});

test("删掉文件就等于回到冷启动，不会报错", () => {
  fs.rmSync(file, { force: true });
  store.resetHistoryCache();
  const fresh = activityProjection.init();
  assert.deepEqual(fresh.carried, {}, "没有历史时载体为空，界面就不显示参照");
});
