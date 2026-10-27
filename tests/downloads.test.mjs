import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ACTIVE_STATUSES, MAX_JOBS, STALE_MIN_MS, readDownloads } from "../lib/downloads.js";

/** 造一个临时 jobs 目录，按给定内容写 status.json；返回根路径。 */
function makeRoot(jobs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dws-dl-"));
  for (const [name, payload] of Object.entries(jobs)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (payload !== null) fs.writeFileSync(path.join(dir, "status.json"), payload, "utf8");
  }
  return root;
}

const ISO = (ms) => new Date(ms).toISOString();

test("没有 jobs 目录就是空列表：下载功能没装也不报错", () => {
  assert.deepEqual(readDownloads({ root: path.join(os.tmpdir(), "dws-dl-missing-" + process.pid) }), []);
});

test("按开始时间倒序，最新的任务在前", () => {
  const now = Date.now();
  const root = makeRoot({
    a: JSON.stringify({ id: "a", status: "done", startedAt: ISO(now - 9000), updatedAt: ISO(now - 8000) }),
    b: JSON.stringify({ id: "b", status: "done", startedAt: ISO(now - 3000), updatedAt: ISO(now - 2000) }),
  });
  assert.deepEqual(readDownloads({ root, now }).map((job) => job.id), ["b", "a"]);
});

test("坏掉半写的 status.json 只跳过那一条，别的照常读", () => {
  const now = Date.now();
  const root = makeRoot({
    good: JSON.stringify({ id: "good", status: "done", startedAt: ISO(now - 5000) }),
    broken: "{ not json",
    empty: null,
  });
  assert.deepEqual(readDownloads({ root, now }).map((job) => job.id), ["good"]);
});

test("最多给 MAX_JOBS 条：接口不把上百个历史任务都吐给前端", () => {
  const now = Date.now();
  const jobs = {};
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    jobs["j" + i] = JSON.stringify({ id: "j" + i, status: "done", startedAt: ISO(now - i * 1000) });
  }
  assert.equal(readDownloads({ root: makeRoot(jobs), now }).length, MAX_JOBS);
});

test("进程已经没了却还写着「下载中」：标 stale，让卡片能说这是在装死", () => {
  const now = Date.now();
  const deadPid = 2 ** 22 + 12345; // 本机上不可能存在的 pid
  const root = makeRoot({
    x: JSON.stringify({
      id: "x", status: "downloading", pid: deadPid,
      startedAt: ISO(now - 60000), updatedAt: ISO(now - STALE_MIN_MS - 1000),
    }),
  });
  const [job] = readDownloads({ root, now });
  assert.equal(job.stale, true);
});

test("刚更新过的活跃任务不算 stale：正在下的不能被误判", () => {
  const now = Date.now();
  const root = makeRoot({
    y: JSON.stringify({
      id: "y", status: "downloading", pid: process.pid,
      startedAt: ISO(now - 60000), updatedAt: ISO(now - 1000),
    }),
  });
  const [job] = readDownloads({ root, now });
  assert.equal(job.stale, undefined, "刚写过状态的任务照实返回");
});

test("已完成/已取消的任务永远不标 stale：它们本来就没有进程在跑", () => {
  const now = Date.now();
  const root = makeRoot({
    done: JSON.stringify({ id: "done", status: "done", pid: 2 ** 22 + 1, startedAt: ISO(now - 900000), updatedAt: ISO(now - 900000) }),
    failed: JSON.stringify({ id: "failed", status: "failed", pid: 2 ** 22 + 1, startedAt: ISO(now - 900000), updatedAt: ISO(now - 900000) }),
  });
  for (const job of readDownloads({ root, now })) {
    assert.equal(job.stale, undefined, `${job.status} 不该被标 stale`);
  }
});

test("ACTIVE_STATUSES 覆盖 worker 的所有中间状态", () => {
  for (const status of ["probe", "queued", "running", "connecting", "downloading", "reconnecting", "finalizing"]) {
    assert.ok(ACTIVE_STATUSES.has(status), status + " 应当是活跃状态");
  }
  assert.ok(!ACTIVE_STATUSES.has("done"));
  assert.ok(!ACTIVE_STATUSES.has("failed"));
});
