/**
 * Download tasks reader — the read-only half of the download integration.
 *
 * The integration is file-based and fully generic: a downloader writes one
 * status.json per task in ~/.agent-downloads/jobs/<id>/ (AGENT_DL_HOME
 * overrides the root). This module only reads those files: no healing writes,
 * no cancel flags, nothing that mutates the writer's data. A stale task is
 * merely flagged (`stale: true`) so the card can gray it out; whoever runs the
 * downloader stays responsible for its state.
 *
 * @module dsh-work-status/downloads
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Task statuses that mean "a worker process should still be alive". */
export const ACTIVE_STATUSES = new Set([
  "probe", "queued", "running", "connecting", "downloading", "reconnecting", "finalizing",
]);

/** Unupdated age after which an active task with a dead pid is flagged stale. */
export const STALE_MIN_MS = 6000;

/** Unupdated age after which an active task is flagged stale even if its pid looks alive. */
export const STALE_DOUBLE_MS = STALE_MIN_MS * 2;

/** At most this many newest tasks are returned. */
export const MAX_JOBS = 10;

/** The jobs directory the worker writes to (AGENT_DL_HOME overrides ~/.agent-downloads). */
export function downloadsRoot(env = process.env) {
  return path.join(env.AGENT_DL_HOME || path.join(os.homedir(), ".agent-downloads"), "jobs");
}

/**
 * Windows note from the worker: EPERM on kill(pid, 0) means the process exists
 * but sends no signals — treat it as alive so live downloads are not misflagged.
 */
function procAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

/**
 * Read every task's status.json and return the newest `limit` entries,
 * newest first. Broken or missing files are skipped silently — a half-written
 * status must never break the whole card.
 * @param {{root?: string, now?: number, limit?: number}} [options]
 * @returns {object[]} status records, stale ones carrying `stale: true`.
 */
export function readDownloads({ root = downloadsRoot(), now = Date.now(), limit = MAX_JOBS } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(root, name, "status.json"), "utf8"));
      if (status && typeof status === "object") jobs.push(status);
    } catch {
      // 半写坏或被并发表写的 status.json：跳过这一条，别的照常。
    }
  }
  jobs.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return jobs.slice(0, limit).map((status) => {
    if (!ACTIVE_STATUSES.has(status.status)) return status;
    const age = now - Date.parse(status.updatedAt || status.startedAt || "");
    if (!(age >= STALE_MIN_MS)) return status;
    if (!procAlive(status.pid) || age > STALE_DOUBLE_MS) {
      return { ...status, stale: true };
    }
    return status;
  });
}
