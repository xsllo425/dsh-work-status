#!/usr/bin/env node
/**
 * 清掉本机的步耗时记忆（`~/.dsh/work-status/step-stats.json`）。
 *
 * 只删这一个统计文件；插件下次冷启动会重新开始积累，不会因此报错。
 *
 *   node scripts/clear-stats.mjs          # 删掉
 *   node scripts/clear-stats.mjs --dry    # 只看看路径和大小
 */
import fs from "node:fs";
import { statsPath } from "../lib/step-store.js";

const dry = process.argv.includes("--dry");
const file = statsPath();

if (file === "") {
  console.log("找不到统计文件路径（环境变量或 home 目录不可用），什么也没做。");
  process.exit(0);
}

let size = 0;
try {
  size = fs.statSync(file).size;
} catch {
  console.log("还没有统计文件：" + file);
  process.exit(0);
}

if (dry) {
  console.log("统计文件：" + file + "（" + size + " 字节，未删除）");
  process.exit(0);
}

try {
  fs.rmSync(file);
  console.log("已删除：" + file + "（" + size + " 字节）");
} catch (error) {
  console.error("删除失败：" + (error && error.message ? error.message : String(error)));
  process.exit(1);
}
