/**
 * dsh-work-status — the Host half.
 *
 * Registers one session-projection unit (`activity`) on
 * `ctx.sessionProjections`. The unit folds the committed log into the small
 * record the Web card renders; delivery to the client is the projection seam's
 * job (registry snapshot, change feed, persisted checkpoints), so this plugin
 * subscribes to nothing, polls nothing, and appends no session events.
 *
 * @module dsh-work-status
 */
import { activityProjection } from "./activity.js";

/** Cordis plugin name. */
export const name = "work-status";

/** The projection registry is this plugin's whole purpose; without it the
 * fiber stays pending instead of throwing. */
export const inject = ["sessionProjections"];

/**
 * Register the `activity` unit. The registration rides this plugin's fiber, so
 * unloading the bundle removes the key and every client reads it as absent.
 * @param {object} ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(activityProjection);
}
