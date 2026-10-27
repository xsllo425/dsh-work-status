/**
 * dsh-work-status — the Host half.
 *
 * Two jobs:
 * 1. Registers one session-projection unit (`activity`) on
 *    `ctx.sessionProjections`. The unit folds the committed log into the small
 *    record the Web card renders; delivery to the client is the projection seam's
 *    job (registry snapshot, change feed, persisted checkpoints), so this plugin
 *    subscribes to nothing, polls nothing, and appends no session events.
 * 2. Exposes a read-only HTTP endpoint (`GET /api/dsh-work-status/downloads`)
 *    that reports the download tasks persisted under ~/.agent-downloads/jobs/.
 *    It only reads status files — the downloader stays the single writer.
 *
 * @module dsh-work-status
 */
import { activityProjection } from "./activity.js";
import { readDownloads } from "./downloads.js";

/** Cordis plugin name. */
export const name = "work-status";

/** The projection registry is this plugin's core; webServer powers the
 * downloads endpoint. Without the registry the fiber stays pending instead of
 * throwing; the endpoint degrades to a warning when webServer is absent. */
export const inject = ["sessionProjections", "webServer"];

/**
 * Register the `activity` unit and the downloads endpoint. The registration
 * rides this plugin's fiber, so unloading the bundle removes the key and every
 * client reads it as absent.
 * @param {object} ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(activityProjection);
  registerDownloadsApi(ctx);
}

function sendJson(response, code, payload) {
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

/** Same host-auth convention as the bundled web UI: requestRejection returns a
 * rejection status or undefined for trusted same-origin requests. */
function rejectIfUntrusted(ctx, request, response) {
  try {
    const connection = ctx.get("connection");
    const rejection = typeof connection?.requestRejection === "function"
      ? connection.requestRejection(request)
      : undefined;
    if (rejection !== undefined) {
      sendJson(response, rejection, {
        error: rejection === 401 ? "请先登录 DSH。" : "已拒绝不可信或跨站请求。",
      });
      return true;
    }
  } catch {
    sendJson(response, 503, { error: "宿主认证服务暂不可用。" });
    return true;
  }
  return false;
}

/**
 * Serve `GET /api/dsh-work-status/downloads` with the worker's task list.
 * webServer is expected on the desktop host; when it is missing the projection
 * still works and only a warning notes the endpoint did not register.
 */
function registerDownloadsApi(ctx) {
  const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : null;
  if (!webServer || typeof webServer.register !== "function") {
    ctx.logger?.warn?.("[work-status] webServer 不可用，下载进度接口未注册。");
    return;
  }
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: "exact",
      path: "/api/dsh-work-status/downloads",
      handler: async (request, response) => {
        if (rejectIfUntrusted(ctx, request, response)) return;
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405);
          response.end();
          return;
        }
        sendJson(response, 200, { jobs: readDownloads() });
      },
    });
    ctx.logger?.debug?.("[work-status] 下载进度接口已注册: /api/dsh-work-status/downloads");
    return () => {
      try { dispose?.(); } catch { /* ignore */ }
    };
  });
}
