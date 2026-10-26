/**
 * 跨会话的步耗时记忆（只在本机、只存数字）。
 *
 * 为什么要它：同类步的参照只看本会话时，新会话前几步没有样本，就不显示参照。
 * 这份小文件把「每一步用了多久」按「首个工具」归档下来，新会话可以拿它当起点，
 * 几轮之后自然过渡到本会话自己的样本。
 *
 * 隐私边界（刻意保守）：
 * - 只存「归类键 + 毫秒数」；键形如 `model|read`、`tool|local|edit`，来自工具名白名单，
 *   不含路径、命令内容、提示词、会话 id、时间戳。
 * - 单键最多 30 个样本、全部不超过 48 个键，文件不会无限长大。
 * - 文件在 `~/.dsh/work-status/step-stats.json`；删掉即回到冷启动，插件不会因此报错。
 * - 设 `DSH_WORK_STATUS_NO_HISTORY=1` 可彻底关闭读写。
 *
 * @module dsh-work-status/step-store
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 文件格式版本：结构变了就换号，旧的直接丢弃。 */
const FILE_VERSION = 1;

/** 每个键保留的样本数（与本会话内的窗口一致）。 */
const SAMPLES_PER_KEY = 30;

/** 最多保留多少个键（超出丢最久没更新的）。 */
const KEYS_MAX = 48;

/** 合理的步耗时上限：超过 10 分钟的样本多半是挂机或系统调度，不要。 */
const MAX_SAMPLE_MS = 600000;

/** 文件读失败后，最多每分钟再试一次，避免每个事件都去戳磁盘。 */
const RETRY_MS = 60000;

/** 关闭开关：显式设了非空值就当作「不要历史」。 */
function disabled() {
  try {
    const flag = process.env.DSH_WORK_STATUS_NO_HISTORY;
    return typeof flag === "string" && flag !== "" && flag !== "0";
  } catch {
    return false;
  }
}

/** 统计文件路径：默认在用户目录下，可用环境变量指到别处（测试用）。 */
export function statsPath() {
  try {
    const override = process.env.DSH_WORK_STATUS_STATS;
    if (typeof override === "string" && override !== "") return override;
    return path.join(os.homedir(), ".dsh", "work-status", "step-stats.json");
  } catch {
    return "";
  }
}

/** 只接受「数字数组、长度有限、值合理」的样本表。 */
function sanitize(table) {
  const out = {};
  if (!table || typeof table !== "object") return out;
  let keys = 0;
  for (const [key, samples] of Object.entries(table)) {
    if (keys >= KEYS_MAX) break;
    if (typeof key !== "string" || key.length > 80) continue;
    if (!Array.isArray(samples)) continue;
    const clean = samples
      .filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SAMPLE_MS)
      .map((value) => Math.round(value))
      .slice(-SAMPLES_PER_KEY);
    if (clean.length === 0) continue;
    out[key] = clean;
    keys += 1;
  }
  return out;
}

/** 读文件；坏文件、缺失、无权限都当成「没有历史」，不抛错。 */
function readFile() {
  const file = statsPath();
  if (file === "") return null;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== FILE_VERSION) return null;
    return { table: sanitize(parsed.samples), mtimeMs: Date.now() };
  } catch {
    return null;
  }
}

/** 进程内的缓存：读一次，写的时候顺手更新。 */
let cache = null;
let lastAttempt = 0;

/** 当前可用于「历史参照」的样本表（已裁剪）。 */
export function historyTable() {
  if (disabled()) return {};
  const now = Date.now();
  if (cache === null && now - lastAttempt > RETRY_MS) {
    lastAttempt = now;
    const loaded = readFile();
    cache = loaded ? loaded.table : {};
  }
  return cache || {};
}

/** 从样本算分位（线性插值，与客户端同一套路）。 */
function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

/** 把样本表压成「n + 三个分位」，客户端只需要这几个数。 */
export function historyRefs(table) {
  const out = {};
  for (const [key, samples] of Object.entries(table || {})) {
    if (samples.length < 5) continue;
    const sorted = samples.slice().sort((left, right) => left - right);
    out[key] = { n: samples.length, p25: quantile(sorted, 0.25), med: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
  }
  return Object.freeze(out);
}

/** 原子写：先写临时文件再改名，进程中途被杀也不会留下半个 JSON。 */
function writeFile(table) {
  const file = statsPath();
  if (file === "") return;
  const payload = JSON.stringify({ v: FILE_VERSION, samples: table });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* 写不进去（只读盘、无权限）就退化成「只用本会话样本」 */
  }
}

/**
 * 把本轮攒到的样本并进历史文件：同一键按时间追加，超过窗口丢最旧。
 * @param {Readonly<Record<string, readonly number[]>>} sessionStats - 本会话按签名归档的样本。
 * @returns {Readonly<Record<string, {n:number,p25:number,med:number,p75:number}>>} 合并后的参照。
 */
export function rememberSamples(sessionStats) {
  if (disabled()) return Object.freeze({});
  const current = { ...historyTable() };
  let touched = false;
  for (const [key, samples] of Object.entries(sessionStats || {})) {
    if (!Array.isArray(samples) || samples.length === 0) continue;
    const merged = sanitize({ [key]: (current[key] || []).concat(samples) })[key] || [];
    if (merged.length === 0) continue;
    current[key] = merged;
    touched = true;
  }
  if (!touched) return historyRefs(current);
  // 键太多时丢「样本最少」的，留着更像样本的类目。
  const keys = Object.keys(current);
  if (keys.length > KEYS_MAX) {
    keys.sort((left, right) => current[left].length - current[right].length);
    for (const key of keys.slice(0, keys.length - KEYS_MAX)) delete current[key];
  }
  cache = current;
  writeFile(current);
  return historyRefs(current);
}

/** 测试用：清掉进程内缓存（文件还在）。 */
export function resetHistoryCache() {
  cache = null;
  lastAttempt = 0;
}
