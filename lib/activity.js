/**
 * dsh-work-status — the fold.
 *
 * A pure, synchronous reduction of the committed session log into one small
 * activity record: which turn is running, how far into it the agent is, the
 * tool calls it already made (with their outcome and duration), the calls the
 * model has just declared it will run next, and a one-line preview of the text
 * it is writing. The unit is registered on `ctx.sessionProjections`
 * (`lib/index.js`), so the Host folds every event once and the Web client reads
 * the finished value through `useProjection('workStatus')` — the client never
 * sees or replays session events.
 *
 * Everything here is plain JSON: the projection cache checkpoints it, cold
 * reads restore it, and a stale checkpoint (older `stateVersion`) is discarded
 * and refolded from the log.
 *
 * @module dsh-work-status/status
 */
import { historyRefs, historyTable, rememberSamples } from "./step-store.js";

/** Projection key the Host unit registers and the client reads. */
export const ACTIVITY_KEY = "workStatus";

/** How many finished/queued entries the client needs before it stops helping. */
const STATE_VERSION = 19;
const MAX_ITEMS = 32;

/** Preview budget for the streamed text: the card shows it as a short block. */
const DRAFT_LIMIT = 240;
/** How many lines of that preview survive — enough for a three-point answer. */
const DRAFT_LINES = 5;

/** Label budget for a tool call's target (a path, a command, a query …). */
const TARGET_LIMIT = 120;
/** 待办句子的上限：卡片把它当“这一步在办什么”的主标题。 */
const TASK_LIMIT = 72;
/** 引用“改的是哪一句”时的截断长度。 */
const SNIPPET_LIMIT = 28;
/** 每个动作记录“为了什么”的长度上限。 */
const WHY_LIMIT = 80;
/** 失败原因在卡片上只占一行，留得住关键字（ENOENT / 401 / 报错函数名）即可。 */
const ERROR_LIMIT = 90;
/** 历史窗口：够算中位数，又不让投影变大。 */
const HISTORY_TURNS = 24;

/** 等人回答的工具：等待时间不算工作量，也不进任何耗时基线。 */
const COMMAND_ROLES = [
  [/\b(node|npx)\s+--test\b|\bnpm\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b/, "test"],
  [/\bgit\s+(commit|push|merge|rebase|cherry-pick)\b/, "git-write"],
  [/\bgit\s+/, "git"],
  [/\bnpm\s+(i|install|ci|add)\b|\bpnpm\s+(i|install|add)\b/, "install"],
  [/\b(node|npx|tsx|python|python3|deno)\b/, "script"],
  [/\b(curl|wget)\b/, "network"],
  [/\b(ls|dir|rg|grep|find)\b/, "list"],
];

const COMMAND_TOOLS = new Set(["bash", "ops_bash", "pwsh", "shell", "run", "exec", "powershell"]);

const WAIT_TOOLS = new Set(["ask_user_question", "ask_user"]);

/** 网络类工具：受网络影响，不能和本地读写混在一个基线里。 */
const NETWORK_TOOLS = new Set(["web_search", "web_fetch", "browser", "cache_search", "research", "x_search", "video_search", "weather", "domain_search"]);
/** 后台/等待类工具：包含子代理与定时，耗时取决于外部，不作同类参照。 */
const BACKGROUND_TOOLS = new Set(["job_output", "job_list", "job_kill", "ask_user_question", "ask_user", "wait_agent", "send_message", "spawn_teammate", "subagent", "subagent_fork", "workflow", "schedule_create", "schedule_list", "schedule_update", "schedule_delete", "create_goal", "update_goal", "get_goal"]);
/** 上下文维护：系统开销，既不进任务进度，也不进执行耗时基线。 */
const SYSTEM_TOOLS = new Set(["compress", "decompress", "search_context", "acp_status", "acp_cache"]);
/** 每个签名的步样本上限；分位数不需要更多。 */
const STEP_SAMPLES = 30;
/** 最多保留多少个签名，避免投影无限长。 */
const STEP_SIGS = 12;
/** 太短的一步多半是并行的空转，不计入样本。 */
const MIN_STEP_MS = 300;
/** 模型推理与各类工具各存一份样本，键数有上限，避免投影无限长。 */
const STEP_KEYS = 48;
/** 上下文维护只留最近若干次操作，够回答“这轮做了什么”即可。 */
const ACP_OPS = 16;

/** 上下文维护记录的空初始值。 */
const EMPTY_ACP = Object.freeze({ blocks: Object.freeze({}), status: null, ops: Object.freeze([]) });

/** 阶段标题的上限：再长就是一段话，不是标题。 */
const STAGE_LIMIT = 40;

/**
 * 上下文维护类工具：billion-context 的 ACP 工具。只认结构化工具名
 * （允许 mcp__x__compress / billion_context.compress 这类前缀），
 * 从不靠消息 id（m00001）或正文猜。插件不在时这些名字根本不会出现，
 * 于是这条适配层天然是可选的：不认识就当普通工具，不影响任何计数。
 */
const ACP_TOOLS = Object.freeze({
  compress: "压缩上下文",
  decompress: "恢复上下文",
  search_context: "检索历史",
  acp_status: "上下文状态",
});

/**
 * Where a tool call points, as ordered rules: the first rule whose argument
 * field is present decides both the short text and its kind. The kind lets the
 * card render the target the way a person reads it — a file name rather than a
 * full path, a command as typed — instead of parsing strings in the browser.
 */
const TARGET_RULES = [
  { kind: "command", keys: ["command", "cmd", "script"] },
  { kind: "query", keys: ["pattern", "query", "q"] },
  { kind: "path", keys: ["file_path", "filePath", "path", "file", "paths"] },
  { kind: "url", keys: ["url"] },
  { kind: "list", keys: ["todos"] },
  { kind: "text", keys: ["description", "prompt", "name", "content", "text", "patch"] },
];

/**
 * Collapse whitespace and clip to `limit` from the end with a leading ellipsis
 * (paths keep their tail, which is the part a person reads), or from the start
 * when `fromEnd` is false.
 * @param {string} text - raw source text.
 * @param {number} limit - maximum code units of the result.
 * @param {boolean} fromEnd - keep the tail instead of the head.
 * @returns {string} the display-ready string.
 */
function clip(text, limit, fromEnd = false) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  if (fromEnd) return "…" + flat.slice(-(limit - 1));
  return flat.slice(0, limit - 1).trimEnd() + "…";
}

/**
 * Reduce a shell command to the part a reader cares about: agents habitually
 * wrap work in `cd "<dir>" && VAR=x && python - <<'PY' …`, and all of that
 * prologue is context noise in a status line. Only the leading, syntactic
 * parts are removed; the command itself is never rewritten.
 * @param {string} text - the raw command.
 * @returns {string} the command without its location/env/heredoc scaffolding.
 */
function tidyCommand(text) {
  let command = String(text).replace(/\s+/g, " ").trim();
  for (let round = 0; round < 8; round += 1) {
    const before = command;
    command = command
      .replace(/^(?:cd|pushd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\|\|)\s*/i, "")
      .replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, "")
      .replace(/^(?:&&|\|\||;)\s*/, "");
    if (command === before) break;
  }
  // Everything from a heredoc marker on is the script body, not the action.
  command = command.replace(/\s*<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?.*$/s, "");
  return command.replace(/[\s|&;<>-]+$/, "").trim();
}

/**
 * Turn a tool call's raw argument JSON into the short text the card shows
 * beside the action name, plus the kind that says how to shorten it further
 * for display. Never throws: unparseable or partial JSON (a streamed tool-call
 * block is not guaranteed to be complete) degrades to the raw text.
 * @param {unknown} rawArguments - the `arguments` string from the model or log.
 * @returns {{ target: string, kind: string }} a single-line target and its kind
 *   (`command` | `path` | `query` | `url` | `list` | `text` | `other`).
 */
/** 一行里最能说明“在动什么”的那句话：去掉缩进、只留首行。 */
function snippetOf(value, limit) {
  if (typeof value !== "string") return "";
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return clip(trimmed, limit, false);
  }
  return "";
}

/** 一条命令里串了多条（&&、;、||、管道、多行）：这步的真实开销不属于“同类步”。 */
function isCommandChain(rawArguments) {
  const text = String(rawArguments || "");
  if (text === "") return false;
  try {
    const args = JSON.parse(text);
    const command = typeof args?.command === "string" ? args.command : "";
    return /&&|\|\||[;|\n]/.test(command);
  } catch {
    return false;
  }
}

function stepSigOf(name, rawArguments) {
  if (!COMMAND_TOOLS.has(name)) return name;
  const text = String(rawArguments || "");
  const hit = COMMAND_ROLES.find(([pattern]) => pattern.test(text));
  return hit ? name + ":" + hit[1] : name;
}

export function describeCall(rawArguments) {
  const described = describeArguments(rawArguments);
  if (described.snippet === "") delete described.snippet;
  try {
    const args = JSON.parse(rawArguments);
    if (typeof args?.description === "string" && args.description.trim()) {
      described.description = clip(args.description, 200, false);
    }
  } catch { /* Partial arguments have no reliable description yet. */ }
  return described;
}

function describeArguments(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments.trim() === "") return { target: "", kind: "other" };
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return { target: clip(rawArguments, TARGET_LIMIT, false), kind: "other" };
  }
  if (parsed === null || typeof parsed !== "object") return { target: clip(parsed, TARGET_LIMIT, false), kind: "other" };
  const snippet = snippetOf(parsed.old_string, SNIPPET_LIMIT) || snippetOf(parsed.new_string, SNIPPET_LIMIT)
    || snippetOf(parsed.content, SNIPPET_LIMIT);
  for (const rule of TARGET_RULES) {
    for (const key of rule.keys) {
      const value = parsed[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value === "string") {
        if (value.trim() === "") continue;
        const trimmed = rule.kind === "command" ? tidyCommand(value) : value;
        return { target: clip(trimmed, TARGET_LIMIT, rule.kind === "path"), kind: rule.kind, snippet };
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return { target: "[]", kind: rule.kind, snippet };
        const primitives = value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
        return { target: clip(primitives ? value.join(", ") : JSON.stringify(value), TARGET_LIMIT, false), kind: rule.kind, snippet };
      }
      if (typeof value === "number" || typeof value === "boolean") return { target: String(value), kind: rule.kind, snippet };
      if (typeof value === "object") {
        try {
          return { target: clip(JSON.stringify(value), TARGET_LIMIT, false), kind: rule.kind, snippet };
        } catch {
          /* circular or exotic: fall through to the next field */
        }
      }
    }
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return { target: "", kind: "other" };
  const first = parsed[keys[0]];
  if (typeof first === "string") return { target: clip(first, TARGET_LIMIT, false), kind: "other", snippet };
  if (typeof first === "number" || typeof first === "boolean") return { target: String(first), kind: "other", snippet };
  return { target: clip(JSON.stringify(parsed) ?? "", TARGET_LIMIT, false), kind: "other", snippet };
}

/**
 * Turn an answer's text blocks into the preview the card shows. A point-by-point
 * answer must keep its line breaks — collapsing them into one paragraph turns a
 * list into an unreadable run-on — so only horizontal whitespace is folded, the
 * line structure is kept, and the preview is capped by lines as well as length.
 * @param {string} text - the joined text blocks of one assistant message.
 * @param {number} limit - maximum code units.
 * @param {number} maxLines - maximum rendered lines.
 * @returns {string} the display-ready multiline preview.
 */
function previewText(text, limit, maxLines) {
  const lines = String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "");
  const kept = lines.slice(0, maxLines);
  const joined = kept.join("\n");
  if (joined.length <= limit) return joined;
  return joined.slice(0, limit - 1).trimEnd() + "…";
}

/**
 * 从模型自己说的话里取“这一步是为了什么”：取最后一行、最后一句，
 * 因为紧挨着工具调用的那句话通常就是它的理由。
 * @param {string} text - 当前这一步模型写下的文字。
 * @param {number} [limit] - 最长保留的字符数。
 * @returns {string} 一句理由，没有可说的就返回空串。
 */
function purposeLine(text, limit = WHY_LIMIT) {
  if (typeof text !== "string") return "";
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1];
  const parts = last.split(/(?<=[。！？!?;；])\s*/).map((part) => part.trim()).filter(Boolean);
  const sentence = parts.length > 0 ? parts[parts.length - 1] : last;
  return clip(sentence.replace(/\s+/g, " "), limit, true);
}

/** Identity-validated schema: the registry only calls `parse`, and a shape this
 * plugin authored can never fail it. Keeps the host half free of dependencies —
 * a plugin installed by directory link resolves modules from its own checkout,
 * where no third-party validator is installed. */
const plainSchema = Object.freeze({
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
});

/**
 * The one line of the user's instruction the card shows above the work.
 * First non-empty line, folded, clipped — the card explains itself against it.
 *
 * Runtime context, the time sample, the skill catalog and memory recall all arrive
 * as `user/message` too; only `source.kind === "user"` is something the person
 * actually typed, so only that may become 你的要求.
 * @param {unknown} data - `data` of a `user/message` event.
 * @returns {string} the short instruction text; "" when there is nothing to show.
 */
function promptText(data) {
  if (data === null || typeof data !== "object") return "";
  const source = data.source;
  if (source === null || typeof source !== "object" || source.kind !== "user") return "";
  const content = data.content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block === null || typeof block !== "object" || typeof block.text !== "string") continue;
    const line = block.text.replace(/\s+/g, " ").trim();
    if (line === "") continue;
    return line.length <= PROMPT_LIMIT ? line : line.slice(0, PROMPT_LIMIT - 1) + "…";
  }
  return "";
}

/** How much of the user's instruction the card keeps. */
const PROMPT_LIMIT = 120;

/** 会话总账的初值。 */
const EMPTY_TOTALS = Object.freeze({ turns: 0, rounds: 0, steps: 0, ops: 0, errors: 0, ctx: 0, ctxFailed: 0, modelMs: 0, toolMs: 0, wallMs: 0, firstAt: 0, lastAt: 0 });
/** 日志里每轮目标留多长。 */
const LOG_PROMPT = 80;

/** The neutral record: no turn has started in this session yet. */
export function emptyState() {
  return Object.freeze({
    v: STATE_VERSION,
    turn: 0,
    step: 0,
    phase: "idle",
    /** 上一轮为什么停（`stopCause` 的结果）；没停过或日志没写就是 null。 */
    endCause: null,
    startedAt: 0,
    updatedAt: 0,
    endedAt: 0,
    prompt: "",
    stage: null,
    items: Object.freeze([]),
    plan: Object.freeze([]),
    todos: Object.freeze([]),
    draft: "",
    counts: Object.freeze({ ops: 0, steps: 0, tools: 0, context: 0, errors: 0, contextErrors: 0 }),
    contextMs: 0,
    history: Object.freeze([]),
    /** 整个会话从头累计的总账（日志面板用）；history 只留最近 HISTORY_TURNS 轮。 */
    totals: EMPTY_TOTALS,
    stepSig: "",
    stepStartAt: 0,
    stepWait: false,
    stepStats: Object.freeze({}),
    /** 跨会话的同类步参照（只有 n 与分位，全数字）；没有历史时是空对象。 */
    carried: historyRefs(historyTable()),
    /** 本步耗时的拆分：模型推理一段，工具按类别各记一段，绝不混算。 */
    stepModelMs: 0,
    /** 本轮模型推理合计：每步从 step/start 到这一步 assistant/message 落地。 */
    modelMs: 0,
    stepModelDone: false,
    /** 本轮工具占用合计：所有调用（含上下文维护）的时间并集，并行重叠只算一次。 */
    toolMs: 0,
    toolOpen: 0,
    toolSince: 0,
    stepToolCat: Object.freeze({}),
    stepOpen: Object.freeze({}),
    prev: null,
    /** 上下文维护：压缩块、官方统计快照、最近的操作。 */
    acp: EMPTY_ACP,
    /** 本轮上下文维护总账：压缩/恢复/检索的次数、省下的 token、失败数。 */
    turnCtx: Object.freeze({ n: 0, saved: 0, fails: 0 }),
    /** 决策回合：每步的起点、动作、落点，以及连续低收益时的“疑似停滞”计数。 */
    decisions: Object.freeze([]),
    decisionCounts: Object.freeze({ decisions: 0, progress: 0, info: 0, decided: 0, pending: 0, repeat: 0, unknown: 0 }),
    decisionSeen: Object.freeze([]),
    decisionStart: 0,
    decisionSaid: "",
    decisionSig: "",
    stall: 0,
  });
}

/** @type {ReturnType<typeof emptyState>} */
const EMPTY = emptyState();

/**
 * Which phase a turn-end reason leaves behind. Only a hard failure is an error;
 * an abort or interruption is a stop, everything else is a clean finish.
 * @param {unknown} reason - `turn/end` reason union from the log.
 * @returns {"done" | "error" | "aborted"} the phase.
 */
function endPhase(reason) {
  const kind = reason && typeof reason === "object" && typeof reason.kind === "string" ? reason.kind : "completed";
  if (kind === "error") return "error";
  if (kind === "aborted" || kind === "interrupted") return "aborted";
  return "done";
}

/**
 * 这一轮为什么会停：只看日志里已有的事实（`turn/end` 的 reason 与其中的
 * 结构化错误），归成一个可读的种类。日志没写原因时给 `""`，卡片就不说。
 *
 * @param {unknown} reason - `turn/end` 的 reason。
 * @returns {Readonly<{kind: string, cause: string, code: string, status: number, retryAfterMs: number, message: string}>}
 */
export function stopCause(reason) {
  const empty = Object.freeze({ kind: "", cause: "", code: "", status: 0, retryAfterMs: 0, message: "" });
  if (reason === null || typeof reason !== "object") return empty;
  const kind = typeof reason.kind === "string" ? reason.kind : "";
  const err = reason.error !== null && typeof reason.error === "object" ? reason.error : null;
  const code = err && typeof err.code === "string" ? err.code : "";
  const status = err && Number.isInteger(err.status) ? err.status : 0;
  const retryAfterMs = err && Number.isFinite(err.providerRetryAfterMs) && err.providerRetryAfterMs > 0
    ? Math.round(err.providerRetryAfterMs)
    : 0;
  const message = err && typeof err.message === "string" ? clip(err.message, 160, false) : "";
  const said = (message + " " + code).toLowerCase();
  let cause = "";
  if (kind === "max-tokens") cause = "truncated";
  else if (kind === "interrupted" || kind === "aborted") cause = "interrupted";
  else if (kind === "error") {
    if (code === "CONTEXT_WINDOW_EXCEEDED" || /context.{0,20}(length|window)|too many tokens|maximum context/.test(said)) cause = "context";
    else if (code === "QUOTA" || status === 402 || (status === 429 && /quota|余额|额度|insufficient/.test(said))) cause = "quota";
    else if (code === "AUTH" || code === "UNAUTHORIZED" || status === 401 || status === 403) cause = "auth";
    else if (code === "RATE_LIMIT" || status === 429) cause = "ratelimit";
    else if (status >= 500) cause = "server";
    else if (/econnreset|econnrefused|etimedout|enotfound|eai_again|network|fetch failed|socket hang up/.test(said)) cause = "network";
    else cause = "error";
  }
  return Object.freeze({ kind, cause, code, status, retryAfterMs, message });
}

/**
 * A failed call's own words: the first line of the error the tool reported, so
 * the card can say why a step failed instead of only colouring the row red. The
 * shape of `data` varies by tool (an `error` object, or text blocks inside the
 * result message), so every known carrier is tried and anything unreadable
 * degrades to "" — the card still shows the failure, it just cannot quote it.
 * @param {object} data - `data` of a `tool/result` event.
 * @returns {string} one clipped line of the failure, or "".
 */
function toolCategory(name) {
  const parts = String(name || "").split(/[.<>/:]/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : "";
  if (SYSTEM_TOOLS.has(base)) return "system";
  if (typeof acpKindOf === "function" && acpKindOf(name) !== "") return "system";
  if (BACKGROUND_TOOLS.has(base) || WAIT_TOOLS.has(base)) return "background";
  if (NETWORK_TOOLS.has(base)) return "network";
  return "local";
}

function errorText(data) {
  const candidates = [];
  const error = data && typeof data === "object" ? data.error : undefined;
  if (typeof error === "string") candidates.push(error);
  if (error !== null && typeof error === "object") {
    if (typeof error.message === "string") candidates.push(error.message);
    if (typeof error.text === "string") candidates.push(error.text);
    if (typeof error.code === "string") candidates.push(error.code);
  }
  const content = data && typeof data === "object" ? data.message?.content : undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === "object" && typeof block.text === "string") candidates.push(block.text);
    }
  }
  for (const candidate of candidates) {
    const line = String(candidate).replace(/\s+/g, " ").trim();
    if (line !== "") return clip(line, ERROR_LIMIT, false);
  }
  return "";
}

/**
 * Mark the running entry for one call id finished.
 * @param {readonly object[]} items - current entries.
 * @param {string | undefined} callId - the tool call id, when the log carries one.
 * @param {boolean} failed - whether the call reported an error.
 * @param {number} at - completion time (epoch ms).
 * @param {string} [err] - one clipped line of the failure, kept for the card.
 * @returns {{ items: object[], hit: boolean }} the updated entries and whether a call matched.
 */
function finishItem(items, callId, failed, at, err = "") {
  if (callId === undefined) return { items, hit: false };
  let hit = false;
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== callId || item.status !== "running") return item;
    hit = true;
    changed = true;
    return { ...item, status: failed ? "error" : "ok", t1: at, err: failed ? err : "" };
  });
  return { items: changed ? next : items, hit };
}

/**
 * Fold one committed session event into the activity record.
 *
 * Purity contract of the projection seam: returns the *same reference* for
 * every event it does not care about, so an unchanged fold costs nothing
 * downstream and publishes nothing.
 * @param {object} state - the current record (see {@link emptyState}).
 * @param {{ type: string, seq: number, time: number, data: any }} event - one log event.
 * @returns {object} the next record.
 */
function pushSample(map, key, ms) {
  if (!(ms > 0)) return map;
  const prev = Array.isArray(map[key]) ? map[key] : [];
  return { ...map, [key]: [...prev, Math.round(ms)].slice(-STEP_SAMPLES) };
}

/**
 * 把刚刚走完的一步记成样本：模型推理与工具耗时分开存，工具再按类别分。
 * 只有上下文维护或等人的步不进基线——那是系统开销，不是执行耗时。
 * @param {object} state - 当前记录。
 * @param {number} at - 这一步的结束时刻。
 * @returns {object} 新的有界样本表。
 */
function recordStep(state, at) {
  const started = state.stepStartAt;
  if (!(started > 0) || at - started < MIN_STEP_MS) return state.stepStats;
  if (state.stepWait || state.stepChain) return state.stepStats;
  const cats = Object.keys(state.stepToolCat || {});
  if (cats.includes("system")) return state.stepStats;
  const sig = state.stepSig === "" ? "（无工具）" : state.stepSig;
  const modelMs = state.stepModelMs > 0 ? state.stepModelMs : at - started;
  let stats = pushSample(state.stepStats, `model|${sig}`, modelMs);
  for (const cat of cats) stats = pushSample(stats, `tool|${cat}|${sig}`, state.stepToolCat[cat]);
  const keys = Object.keys(stats);
  if (keys.length > STEP_KEYS) {
    const keep = keys.slice(keys.length - STEP_KEYS);
    const pruned = {};
    for (const key of keep) pruned[key] = stats[key];
    return Object.freeze(pruned);
  }
  return Object.freeze(stats);
}

/** 会改变文件系统的工具（只按基础名匹配，兼容 mcp 前缀与不同写法）。 */
const MUTATING_TOOLS = new Set(["write", "write_file", "edit", "edit_file", "apply_patch", "patch", "notebook_edit", "create_file", "mkdir", "rm", "mv", "cp"]);
/** 只读取信息的工具：它们的成功是“拿到了新证据”，不等于产出成果。 */
const READING_TOOLS = new Set(["read", "read_file", "grep", "search", "glob", "web_fetch", "web_search", "read_image", "list_dir", "shell_output", "job_output"]);
/** 验证类动作：跑测试、lint、typecheck、smoke 之类。 */
const VERIFY_HINT = /(^|[\s/\\])(test|lint|check|typecheck|tsc|verify|smoke|node\s+--test|pytest|cargo\s+test|go\s+test)/i;
/** 一个决策回合最多记多少条、见过多少目标、留多少轮的记录。 */
const DECISION_KEEP = 60;
const SEEN_KEEP = 400;
const SAID_LIMIT = 160;
const DECISION_TARGETS = 6;

/**
 * 工具名的基础形式：mcp__x__read_file / read_file / x.read 都归到 read。
 * @param {string} name - 原始工具名。
 * @returns {string} 小写基础名。
 */
function baseToolName(name) {
  if (typeof name !== "string" || name === "") return "";
  const parts = name.split(/__|[.:/]/);
  return parts[parts.length - 1].toLowerCase();
}

/** 一个工具调用在界面上的“对象”，没有就退回空串。 */
function toolTargetOf(item) {
  if (item === null || typeof item !== "object") return "";
  if (typeof item.target === "string" && item.target !== "") return clip(item.target, 48, true);
  if (typeof item.detail === "string" && item.detail !== "") return clip(item.detail, 48, true);
  return "";
}

/**
 * 结算当前决策回合：只看事件里能证实的东西。
 * 规则刻意保守——写成功但没有验证只算“待验证”，读成功只算“信息进展”，
 * 什么都读不出来就是“无法判断”，绝不因为回合结束就当成有成果。
 * @param {object} state - 当前投影状态。
 * @param {number} at - 结束时间。
 * @returns {object} 更新后的状态（decisions / counts / stall / seen）。
 */
function finalizeDecision(state, at) {
  const from = typeof state.decisionStart === "number" ? state.decisionStart : 0;
  const items = Array.isArray(state.items) ? state.items.slice(from) : [];
  const said = typeof state.decisionSaid === "string" ? state.decisionSaid : "";
  const seen = Array.isArray(state.decisionSeen) ? state.decisionSeen : [];

  const tools = items.map((item) => ({
    name: baseToolName(item.name),
    label: typeof item.name === "string" ? item.name : "tool",
    status: typeof item.status === "string" ? item.status : "running",
    target: toolTargetOf(item),
    kind: item.kind === "context" ? "context" : "tool",
  }));
  const contextOnly = tools.length > 0 && tools.every((tool) => tool.kind === "context");
  if (tools.length === 0 && said === "") {
    return { ...state, decisionStart: 0, decisionSaid: "", decisionSig: state.decisionSig };
  }
  if (contextOnly) {
    // 上下文维护是另一本账：不进入决策统计，但也不能卡住边界。
    return { ...state, decisionStart: 0, decisionSaid: "", decisionSig: state.decisionSig };
  }

  const wrote = tools.filter((tool) => MUTATING_TOOLS.has(tool.name) && tool.status === "ok").map((tool) => tool.target).filter(Boolean);
  const verified = tools.filter((tool) => tool.status === "ok" && VERIFY_HINT.test(tool.name + " " + tool.target));
  const failed = tools.filter((tool) => tool.status === "failed" || tool.status === "error");
  const readOk = tools.filter((tool) => tool.status === "ok" && (READING_TOOLS.has(tool.name) || tool.name === ""));
  const fresh = [];
  const nextSeen = [...seen];
  for (const tool of readOk) {
    const key = tool.name + " " + tool.target;
    if (tool.target === "" || nextSeen.includes(key)) continue;
    fresh.push(tool.target);
    nextSeen.push(key);
  }
  const sig = tools.map((tool) => tool.name + " " + tool.target).sort().join("|");
  const reasons = [];
  let outcome;
  if (tools.length === 0) {
    outcome = said === "" ? "unknown" : "decided";
    reasons.push(said === "" ? "这一步只有说明，没有可核实的动作" : "给出了下一步说法，还没有动作");
  } else if (wrote.length > 0) {
    if (verified.length > 0) {
      outcome = "progress";
      reasons.push("改了 " + wrote.slice(0, 3).join("、") + "，并在本步验证");
    } else {
      outcome = "pending";
      reasons.push("改了 " + wrote.slice(0, 3).join("、") + "，结果还没验证");
    }
  } else if (failed.length > 0 && readOk.length === 0) {
    outcome = "info";
    reasons.push("这一步的调用失败了：" + (failed[0].target || failed[0].label) + "，可以排除这条路");
  } else if (fresh.length > 0) {
    outcome = "info";
    reasons.push("读到新内容：" + fresh.slice(0, 3).join("、"));
  } else if (sig !== "" && sig === state.decisionSig) {
    outcome = "repeat";
    reasons.push("动作与上一回合相同，也没有新证据");
  } else if (readOk.length > 0) {
    outcome = "unknown";
    reasons.push("读了东西，但没有新对象，也看不出结论");
  } else {
    outcome = "unknown";
    reasons.push("依据不足");
  }

  const previous = state.decisionSig || "";
  const record = {
    turn: typeof state.turn === "number" ? state.turn : 0,
    step: typeof state.step === "number" ? state.step : 0,
    endedAt: at,
    said: clip(said, SAID_LIMIT, false),
    outcome,
    reasons: Object.freeze(reasons.slice(0, 2)),
    tools: Object.freeze(tools.slice(0, DECISION_TARGETS).map((tool) => Object.freeze({ label: tool.label, status: tool.status, target: tool.target }))),
    wrote: Object.freeze(wrote.slice(0, 3)),
    verified: verified.length,
    fresh: Object.freeze(fresh.slice(0, 3)),
    failed: failed.length,
  };
  const counts = state.decisionCounts && typeof state.decisionCounts === "object"
    ? state.decisionCounts
    : { decisions: 0, progress: 0, info: 0, decided: 0, pending: 0, repeat: 0, unknown: 0 };
  const key = outcome === "decided" ? "decided" : outcome;
  const nextCounts = Object.freeze({
    decisions: counts.decisions + 1,
    progress: counts.progress + (outcome === "progress" ? 1 : 0),
    info: counts.info + (outcome === "info" ? 1 : 0),
    decided: counts.decided + (outcome === "decided" ? 1 : 0),
    pending: counts.pending + (outcome === "pending" ? 1 : 0),
    repeat: counts.repeat + (outcome === "repeat" ? 1 : 0),
    unknown: counts.unknown + (outcome === "unknown" ? 1 : 0),
  });
  const decisions = [...(Array.isArray(state.decisions) ? state.decisions : []), record].slice(-DECISION_KEEP);
  const stall = outcome === "repeat" ? (state.stall || 0) + 1 : 0;
  return {
    ...state,
    decisions: Object.freeze(decisions),
    decisionCounts: nextCounts,
    decisionSeen: Object.freeze(nextSeen.slice(-SEEN_KEEP)),
    decisionSig: sig,
    stall,
    decisionStart: 0,
    decisionSaid: "",
  };
}

/**
 * 会话级上下文账里属于本轮的那几条：完成时刻不早于本轮开始。
 * @param {object} state - 当前记录。
 * @returns {object[]} 本轮的上下文维护操作。
 */
export function turnOps(state) {
  const ops = state && state.acp && Array.isArray(state.acp.ops) ? state.acp.ops : [];
  const from = state && state.startedAt > 0 ? state.startedAt : 0;
  return ops.filter((op) => typeof op.at === "number" && op.at >= from);
}

/** 把刚结束的一轮压成一行摘要，供下一轮折叠显示。 */
function snapshotTurn(prevState) {
  if (!prevState || typeof prevState.turn !== "number" || prevState.turn <= 0) return null;
  const prevItems = Array.isArray(prevState.items) ? prevState.items : [];
  if (prevItems.length === 0) return null;
  const prevCounts = prevState.counts || {};
  return {
    turn: prevState.turn,
    prompt: typeof prevState.prompt === "string" ? prevState.prompt : "",
    startedAt: prevState.startedAt || 0,
    endedAt: prevState.endedAt || 0,
    steps: typeof prevCounts.steps === "number" ? prevCounts.steps : 0,
    errors: prevItems.filter((item) => item.status === "error" && item.kind !== "context").length,
    modelMs: typeof prevState.modelMs === "number" ? prevState.modelMs : 0,
    toolMs: typeof prevState.toolMs === "number" ? prevState.toolMs : 0,
    items: prevItems.slice(-40),
    // 这一轮自己的上下文维护（会话账里落在本轮时间窗内的那几条），随上一轮一起折叠。
    ctx: turnOps(prevState),
  };
}

export function applyEvent(state, event) {
  const data = event && event.data ? event.data : {};
  const at = typeof event?.time === "number" ? event.time : state.updatedAt;
  switch (event?.type) {
    case "todo/write": {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      const kept = [];
      for (const todo of todos.slice(0, 40)) {
        if (todo === null || typeof todo !== "object") continue;
        const text = clip(typeof todo.content === "string" ? todo.content : "", TASK_LIMIT, true);
        if (text === "") continue;
        kept.push({ text, status: typeof todo.status === "string" ? todo.status : "pending" });
      }
      return { ...state, todos: kept, updatedAt: at };
    }
    case "turn/start":
      return {
        v: STATE_VERSION,
        turn: typeof data.turn === "number" ? data.turn : state.turn + 1,
        step: 0,
        phase: "thinking",
        endCause: null,
        startedAt: at,
        updatedAt: at,
        endedAt: 0,
        // The instruction outlives its turn: the card stays framed by it.
        prompt: state.prompt,
        stage: null,
        items: [],
        plan: [],
        todos: [],
        draft: "",
        counts: { ops: 0, steps: 0, tools: 0, context: 0, errors: 0, contextErrors: 0 },
        contextMs: 0,
        turnCtx: Object.freeze({ n: 0, saved: 0, fails: 0 }),
        history: state.history,
        totals: state.totals || EMPTY_TOTALS,
        stepSig: "",
        stepStartAt: at,
        stepWait: false,
        stepStats: state.stepStats,
        carried: state.carried || historyRefs(historyTable()),
        prev: snapshotTurn(state) || state.prev || null,
        stepModelMs: 0,
        modelMs: 0,
        stepModelDone: false,
        toolMs: 0,
        toolOpen: 0,
        toolSince: 0,
        stepToolCat: Object.freeze({}),
        stepOpen: Object.freeze({}),
        // 上下文维护记的是整个会话的账，换一轮不该清零。
        acp: state.acp === undefined ? EMPTY_ACP : state.acp,
        decisions: state.decisions === undefined ? Object.freeze([]) : state.decisions,
        decisionCounts: state.decisionCounts,
        decisionSeen: state.decisionSeen === undefined ? Object.freeze([]) : state.decisionSeen,
        decisionStart: 0,
        decisionSaid: "",
        decisionSig: state.decisionSig || "",
        stall: state.stall || 0,
      };
    case "user/message": {
      const prompt = promptText(data);
      if (prompt === "" || prompt === state.prompt) return state;
      return { ...state, prompt, updatedAt: at };
    }
    case "step/start": {
      if (state.phase === "idle") return state;
      const settled = finalizeDecision(state, at);
      const step = typeof data.step === "number" ? data.step : settled.step;
      const stepStats = recordStep(settled, at);
      if (step === settled.step && settled.phase === "thinking" && stepStats === settled.stepStats && settled.decisionStart === 0) return settled;
      return {
        ...settled,
        step,
        phase: "thinking",
        stepStats,
        stepSig: "",
        stepStartAt: at,
        stepWait: false,
        stepModelMs: 0,
        stepModelDone: false,
        stepToolCat: Object.freeze({}),
        stepOpen: Object.freeze({}),
        decisionStart: settled.items.length,
        decisionSaid: "",
        updatedAt: at,
      };
    }
    case "assistant/message": {
      const content = Array.isArray(data.message?.content) ? data.message.content : [];
      const blocksOf = (type) => content
        .filter((block) => block && block.type === type && typeof block.text === "string")
        .map((block) => block.text);
      const text = blocksOf("text").join("\n");
      const calls = content
        .filter((block) => block && block.type === "tool-call" && typeof block.name === "string")
        .map((block) => ({ id: block.id, name: block.name, ...describeCall(block.arguments), why: purposeLine(text) }));
      const draft = text.trim() === "" ? "" : previewText(text, DRAFT_LIMIT, DRAFT_LINES);
      const stage = stageAfter(state.stage, text, state.todos, calls.length);
      // 模型这一步输出完成：从本步开始到此刻都是推理（每步只记一次）。
      const thought = state.phase !== "idle" && !state.stepModelDone && state.stepStartAt > 0
        ? Math.max(0, at - state.stepStartAt)
        : -1;
      const timed = thought < 0 ? state : { ...state, modelMs: (state.modelMs || 0) + thought, stepModelDone: true, updatedAt: at };
      if (calls.length === 0 && draft === "" && state.phase === "thinking") return timed;
      return {
        ...timed,
        phase: calls.length > 0 ? "thinking" : "writing",
        stage,
        whyText: purposeLine(text),
        whyStep: typeof data.step === "number" ? data.step : state.step,
        plan: calls.map((entry) => ({ ...entry, task: currentTask(state.todos), stage: stage ? stage.label : "" })),
        draft: draft === "" ? state.draft : draft,
        decisionSaid: purposeLine(text) === "" ? state.decisionSaid : purposeLine(text),
        updatedAt: at,
      };
    }
    case "tool/call": {
      const callId = data.callId;
      const name = typeof data.name === "string" ? data.name : "tool";
      if (state.items.some((item) => item.id === callId && item.status === "running")) return state;
      const step = typeof data.step === "number" ? data.step : state.step;
      const described = describeCall(data.arguments);
      const acp = acpKindOf(name);
      const item = {
        id: callId,
        // “后来有没有同类成功”只认这个键：同工具 + 同目标；上下文维护认范围。
        key: acp === ""
          ? "tool|" + name + "|" + described.kind + "|" + described.target
          : "ctx|" + acp + "|" + acpRangeOf(data.arguments),
        name,
        ...described,
        targetKind: described.kind,
        kind: acp === "" ? "tool" : "context",
        acp,
        range: acp === "" ? "" : acpRangeOf(data.arguments),
        // 溯源：原始参数留一份（截断），供上下文维护条目核对；普通工具不展示。
        args: clip(typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? ""), 200, false),
        // 理由只取“这一条消息自己写的话”，绝不复用上一段无关说明。
        why: state.whyStep === step ? state.whyText : "",
        task: currentTask(state.todos),
        stage: state.stage ? state.stage.label : "",
        stageKey: state.stage ? state.stage.key : "",
        step,
        status: "running",
        t0: at,
        t1: 0,
        err: "",
      };
      const items = [...state.items, item];
      return {
        ...state,
        phase: "tool",
        stepSig: state.stepSig === "" ? stepSigOf(name, data.arguments) : state.stepSig,
        stepStartAt: state.stepStartAt > 0 ? state.stepStartAt : at,
        stepWait: state.stepWait || WAIT_TOOLS.has(name),
        stepChain: state.stepChain || isCommandChain(data.arguments),
        stepModelMs: state.stepModelMs > 0 ? state.stepModelMs : Math.max(0, at - (state.stepStartAt > 0 ? state.stepStartAt : at)),
        toolOpen: (state.toolOpen || 0) + 1,
        toolSince: (state.toolOpen || 0) > 0 ? state.toolSince : at,
        stepOpen: { ...(state.stepOpen || {}), [callId]: { t0: at, cat: toolCategory(name) } },
        items: items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items,
        plan: state.plan.filter((entry) => entry.id !== callId),
        updatedAt: at,
        counts: {
          ...state.counts,
          ops: state.counts.ops + 1,
          tools: state.counts.tools + 1,
          context: state.counts.context + (acp === "" ? 0 : 1),
        },
      };
    }
    case "tool/result": {
      const callId = data.message?.toolCallId ?? data.callId;
      const flagged = data.error !== undefined || data.message?.isError === true || data.isError === true;
      const target = state.items.find((item) => item.id === callId);
      const upkeep = target !== undefined && target.kind === "context";
      const output = resultText(data);
      const exitErr = flagged ? "" : exitFailure(output, target ? target.name : "", target ? target.args : "");
      const failed = flagged || exitErr !== "";
      const text = flagged ? errorText(data) : (exitErr !== "" ? exitErr : output);
      const finished = finishItem(state.items, callId, failed, at, text);
      const patch = upkeep ? acpResultPatch(state, target, text, at, failed) : null;
      const items = patch === null
        ? finished.items
        : finished.items.map((item) => (item.id === callId ? { ...item, ...patch.item } : item));
      // 第二步：本轮上下文维护的总账不受 16 条窗口限制。
      const turnCtx = upkeep
        ? Object.freeze({
          n: (state.turnCtx ? state.turnCtx.n : 0) + 1,
          saved: (state.turnCtx ? state.turnCtx.saved : 0) + (patch && typeof patch.item.saved === "number" ? patch.item.saved : 0),
          fails: (state.turnCtx ? state.turnCtx.fails : 0) + (failed ? 1 : 0),
        })
        : state.turnCtx;
      const open = state.stepOpen ? state.stepOpen[callId] : undefined;
      const elapsed = open && open.t0 > 0 && at > open.t0 ? at - open.t0 : 0;
      const counted = open !== undefined && open.cat !== "system" && open.cat !== "background";
      const stepToolCat = counted ? { ...(state.stepToolCat || {}), [open.cat]: ((state.stepToolCat || {})[open.cat] || 0) + elapsed } : (state.stepToolCat || {});
      let stepOpen = state.stepOpen || {};
      if (open !== undefined) {
        const rest = { ...stepOpen };
        delete rest[callId];
        stepOpen = rest;
      }
      const toolOpen = Math.max(0, (state.toolOpen || 0) - 1);
      const toolMs = (state.toolMs || 0) + (toolOpen === 0 && state.toolSince > 0 && at > state.toolSince ? at - state.toolSince : 0);
      return {
        ...state,
        phase: toolOpen > 0 ? "tool" : "thinking",
        items,
        toolOpen,
        toolMs,
        toolSince: toolOpen === 0 ? 0 : state.toolSince,
        stepToolCat,
        stepOpen,
        ...(patch === null ? {} : { acp: patch.acp }),
        turnCtx,
        updatedAt: at,
        counts: {
          ...state.counts,
          // 上下文维护只算操作，不算用户任务的完成步数。
          steps: state.counts.steps + (failed || upkeep ? 0 : 1),
          errors: state.counts.errors + (failed && !upkeep ? 1 : 0),
          contextErrors: state.counts.contextErrors + (failed && upkeep ? 1 : 0),
        },
        contextMs: state.contextMs + (upkeep && target.t0 && at > target.t0 ? at - target.t0 : 0),
      };
    }
    case "turn/end": {
      const endTurn = typeof data.turn === "number" ? data.turn : state.turn;
      if (state.endedAt > 0 && state.turn === endTurn) return { ...state, updatedAt: at };
      const settledState = finalizeDecision(state, at);
      const stateAfter = settledState;
      const phase = endPhase(data.reason);
      // 一轮结束还没等到结果的调用，按“结果未知”收尾，别再让卡片一直转圈。
      const items = stateAfter.items.map((item) => (item.status === "running"
        ? { ...item, status: "unknown", t1: at }
        : item));
      // 结束的轮次留一条有界的历史样本：只记耗时与规模，供下一次估计参考。
      const stepStats = recordStep(stateAfter, at);
      const wall = stateAfter.startedAt > 0 ? Math.max(0, at - stateAfter.startedAt) : 0;
      const toolMs = (stateAfter.toolMs || 0) + (stateAfter.toolOpen > 0 && stateAfter.toolSince > 0 && at > stateAfter.toolSince ? at - stateAfter.toolSince : 0);
      const modelMs = stateAfter.modelMs || 0;
      const ctxOps = turnOps(stateAfter);
      const ctxFailed = ctxOps.filter((op) => op.status !== "ok").length;
      const record = {
        turn: stateAfter.turn,
        wallMs: wall,
        taskMs: Math.max(0, wall - stateAfter.contextMs),
        contextMs: stateAfter.contextMs,
        steps: stateAfter.counts.steps,
        ops: stateAfter.counts.ops,
        errors: stateAfter.counts.errors,
        // 日志面板用：起止、目标、推理/工具、上下文维护、结束方式。
        startedAt: stateAfter.startedAt,
        endedAt: at,
        prompt: clip(typeof stateAfter.prompt === "string" ? stateAfter.prompt : "", LOG_PROMPT, false),
        // 模型回合数（step 事件），与 DSH 状态栏的“步”同口径；steps 是成功的工具调用。
        rounds: typeof stateAfter.step === "number" ? stateAfter.step : 0,
        modelMs,
        toolMs,
        ctx: ctxOps.length,
        phase,
      };
      const history = wall > 0
        ? [...stateAfter.history, record].slice(-HISTORY_TURNS)
        : stateAfter.history;
      const base = stateAfter.totals || EMPTY_TOTALS;
      const totals = wall > 0
        ? Object.freeze({
          turns: base.turns + 1,
          rounds: (base.rounds || 0) + (typeof stateAfter.step === "number" ? stateAfter.step : 0),
          steps: base.steps + stateAfter.counts.steps,
          ops: base.ops + stateAfter.counts.ops,
          errors: base.errors + stateAfter.counts.errors,
          ctx: base.ctx + ctxOps.length,
          ctxFailed: base.ctxFailed + ctxFailed,
          modelMs: base.modelMs + modelMs,
          toolMs: base.toolMs + toolMs,
          wallMs: base.wallMs + wall,
          firstAt: base.firstAt > 0 ? base.firstAt : stateAfter.startedAt,
          lastAt: at,
        })
        : base;
      return { ...stateAfter, totals, toolMs, toolOpen: 0, toolSince: 0, stepModelDone: true, phase, endCause: stopCause(data.reason), items, plan: [], endedAt: at, updatedAt: at, whyText: "", whyStep: -1, history, stepStats, carried: rememberSamples(stepStats), stepStartAt: 0, stepSig: "", stepWait: false, stepChain: false, stepModelMs: 0, stepToolCat: Object.freeze({}), stepOpen: Object.freeze({}) };
    }
    default:
      return state;
  }
}

/**
 * 从模型这一条消息里取一个“阶段标题”：短、不带句号、不像叙述句。
 * 只用文字本身，不推断任何未证实的成果；不像标题就宁可返回空串。
 * @param {string} text - 一条 assistant 消息的文本。
 * @returns {string} 阶段标题，没有合适的就是空串。
 */
function headingLine(text) {
  if (typeof text !== "string") return "";
  for (const raw of text.split("\n")) {
    const line = raw.trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*>]\s+/, "")
      .replace(/^\d+[.)]\s+/, "");
    if (line === "") continue;
    if (line.length > STAGE_LIMIT) return "";
    if (/[。！？；;]/.test(line)) return "";
    if (/[，,]/.test(line)) return "";
    if (/^(我|让我|先|接下来|然后|现在|好的|好，|OK|Sure|Let me|I'll|Next)/i.test(line)) return "";
    return clip(line, STAGE_LIMIT, false);
  }
  return "";
}

/**
 * 当前阶段：优先用计划里 in_progress 的那一条（用户能对上号），
 * 没有计划时才用模型自己写的小标题；两者都没有就保持上一个阶段。
 * @param {object | null} stage - 当前阶段。
 * @param {string} text - 这一步的文字。
 * @param {readonly object[]} todos - 最新待办。
 * @param {number} calls - 这一步声明的工具调用数。
 * @returns {object | null} 新的阶段。
 */
function stageAfter(stage, text, todos, calls) {
  if (calls === 0) return stage;
  const todo = currentTask(todos);
  if (todo !== "") {
    if (stage && stage.label === todo) return stage;
    return { key: "todo:" + todo, label: todo, kind: "todo" };
  }
  const heading = headingLine(text);
  if (heading === "") return stage;
  if (stage && stage.label === heading) return stage;
  return { key: "text:" + heading, label: heading, kind: "text" };
}

/**
 * 判定一个工具是不是 ACP 上下文维护。只看工具名的最后一段
 * （mcp__billion-context__compress / billion_context.compress 都算），
 * 不依赖安装形式，也不依赖 billion-context 是否在场。
 * @param {string} name - 工具名。
 * @returns {string} ACP 基础名，不是 ACP 就是空串。
 */
function acpKindOf(name) {
  if (typeof name !== "string" || name === "") return "";
  const parts = name.split(/__|[.:/]/);
  const base = parts[parts.length - 1];
  return Object.prototype.hasOwnProperty.call(ACP_TOOLS, base) ? base : "";
}

/**
 * 从 ACP 调用的参数里取一个可读的“影响范围”（消息区间或检索词）。
 * 参数不完整、不同版本不同字段时宁可返回空串。
 * @param {unknown} rawArguments - 工具调用的 arguments 字符串。
 * @returns {string} 一行范围说明。
 */
function acpRangeOf(rawArguments) {
  let parsed;
  if (rawArguments !== null && typeof rawArguments === "object") {
    parsed = rawArguments;
  } else {
    if (typeof rawArguments !== "string" || rawArguments.trim() === "") return "";
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return "";
    }
  }
  if (parsed === null || typeof parsed !== "object") return "";
  const start = parsed.startId ?? parsed.startRef ?? parsed.from;
  const end = parsed.endId ?? parsed.endRef ?? parsed.to;
  if (typeof start === "string" && typeof end === "string" && start !== "" && end !== "") return start + "–" + end;
  if (typeof parsed.query === "string" && parsed.query.trim() !== "") return "「" + clip(parsed.query, 24, false) + "」";
  if (typeof parsed.scope === "string" && parsed.scope.trim() !== "") return clip(parsed.scope, 24, false);
  return "";
}

/**
 * 当前正在办的那件待办（in_progress 第一条）。卡片用它当动作的主语：
 * “把卡片改成常驻一行”比“写文件 client.js”更接近人话。
 */
function currentTask(todos) {
  if (!Array.isArray(todos)) return "";
  for (const todo of todos) {
    if (todo !== null && typeof todo === "object" && todo.status === "in_progress") {
      return clip(typeof todo.text === "string" ? todo.text : "", TASK_LIMIT, true);
    }
  }
  return "";
}

/** ACP 工具结果的纯文本——卡片只读事件里的文本，不去连别的接口。 */
function resultText(data) {
  const content = data && data.message && Array.isArray(data.message.content) ? data.message.content : [];
  const fromBlocks = content
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  if (fromBlocks !== "") return fromBlocks;
  return data && typeof data.text === "string" ? data.text.trim() : "";
}

// 命令类工具跑完会在结果末尾写 [exit code: N]，而宿主并不把非零退出标成 error。
// 只认最后一条：命令链前面失败、后面成功，整体算成功。
const EXIT_RE = /\[exit code:\s*(\d+)\]/g;
const SEARCHY_CMD = /\b(grep|rg|findstr|diff|ag|ack)\b|git\s+diff/i;

function exitFailure(text, name, args) {
  if (!COMMAND_TOOLS.has(name)) return "";
  let last = null;
  for (const hit of String(text || "").matchAll(EXIT_RE)) last = hit;
  if (last === null) return "";
  const code = Number(last[1]);
  if (code === 0) return "";
  // 1 是 grep/rg/diff 的“没有匹配 / 有差异”，不是失败。
  if (code === 1 && SEARCHY_CMD.test(String(args || ""))) return "";
  return "退出码 " + code;
}

/** “50.6K”“878”“1.4K” → token 数；认不出就是 null，绝不猜。 */
function tokenCount(text) {
  const match = /^([\d.]+)([KkMm])?$/.exec(String(text === undefined ? "" : text).trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] === undefined ? "" : match[2].toUpperCase();
  const scale = unit === "K" ? 1000 : unit === "M" ? 1000000 : 1;
  return Math.round(value * scale);
}

/**
 * compress 工具的回执：`[Compressed m00001–m00065 → 1 block(s), ~9746 tokens saved.]`
 * @param {string} text - 工具结果原文。
 */
function parseCompress(text) {
  const match = /Compressed\s+([\s\S]{1,120}?)\s*→\s*(\d+)\s*block\(s\),\s*~?([\d,]+)\s*tokens? saved/i.exec(text);
  if (match === null) return { state: "unknown", ranges: "", blocks: 0, saved: null };
  return {
    state: "compressed",
    ranges: clip(match[1].replace(/\s+/g, ""), 64, false),
    blocks: Number(match[2]),
    saved: Number(match[3].replace(/,/g, "")),
  };
}

/**
 * decompress 的回执：`[Block b3 content → 26 item(s)]`，有的版本用破折号：
 * `[Block b3 content — 9 item(s)]`。
 * @param {string} text - 工具结果原文。
 */
function parseDecompress(text) {
  const match = /Block\s+(b\d+)\s+content\s*[→—–-]\s*(\d+)\s*item\(s\)/i.exec(text);
  if (match === null) return { state: "unknown", block: "", items: 0 };
  return { state: "restored", block: match[1], items: Number(match[2]) };
}

/**
 * acp_status 的官方统计：压缩块数、摘要总 token、原文总 token，以及每个块的
 * “原文 → 摘要”数字。这是唯一“压缩前后对比”的可信来源，解析失败就返回 null。
 * @param {string} text - acp_status 工具结果原文。
 */
function parseAcpStatus(text) {
  const header = /COMPRESSED BLOCKS[^\n]*?(\d+)\s+active\s*\(([\d.]+[KM]?)\s+summary,\s*([\d.]+[KM]?)\s+original\)/i.exec(text);
  const rows = [];
  const rowPattern = /^\s*(b\d+)\s+\(T\d+\)\s+([\d.]+[KM]?)\s*→\s*([\d.]+[KM]?)\s+(\d+)\s+msgs\s+"([^"]*)"/gm;
  for (;;) {
    const row = rowPattern.exec(text);
    if (row === null) break;
    rows.push({
      id: row[1],
      before: tokenCount(row[2]),
      after: tokenCount(row[3]),
      msgs: Number(row[4]),
      title: clip(row[5], 48, true),
    });
  }
  if (header === null && rows.length === 0) return null;
  return {
    active: header === null ? rows.length : Number(header[1]),
    summaryTokens: header === null ? null : tokenCount(header[2]),
    originalTokens: header === null ? null : tokenCount(header[3]),
    blocks: rows,
  };
}

/**
 * 一次上下文维护结果对投影的影响：这一条操作怎么看、块的恢复状态、统计快照。
 * 失败与“解析不出”严格分开：前者是事件带 isError，后者是版本没给这段文本。
 */
function acpResultPatch(state, target, text, at, failed) {
  const base = state.acp === undefined || state.acp === null ? EMPTY_ACP : state.acp;
  const ms = target.t0 && at > target.t0 ? at - target.t0 : 0;
  const op = {
    id: target.id,
    acp: target.acp,
    range: target.range,
    status: failed ? "failed" : "ok",
    saved: null,
    block: "",
    at,
    ms,
    args: clip(String(target.args || ""), 200, false),
    detail: clip(text, 240, false),
    error: "",
    reason: "",
  };
  const blocks = { ...base.blocks };
  let status = base.status;
  let item = {};
  // range 首选调用参数；真实 compress 常用 {content} 形式，只能从回执里取。
  let parsedRanges = target.range;

  if (failed) {
    op.error = clip(text, 240, false);
    item = { acpState: "failed" };
  } else if (target.acp === "compress") {
    const parsed = parseCompress(text);
    item = { acpState: parsed.state, saved: parsed.saved, acpBlocks: [] };
    if (parsed.state === "unknown") op.reason = "回执未匹配";
    op.saved = parsed.saved;
    parsedRanges = parsed.ranges === "" ? target.range : parsed.ranges;
  } else if (target.acp === "decompress") {
    const parsed = parseDecompress(text);
    item = { acpState: parsed.state, acpBlocks: parsed.block === "" ? [] : [parsed.block] };
    if (parsed.state === "unknown") op.reason = "回执未匹配";
    if (parsed.block !== "") {
      const known = blocks[parsed.block] === undefined ? { before: null, after: null, msgs: 0, title: "" } : blocks[parsed.block];
      blocks[parsed.block] = { ...known, restoredAt: at };
      op.block = parsed.block;
    }
  } else if (target.acp === "search_context") {
    item = { acpState: "searched" };
  } else if (target.acp === "acp_status") {
    const parsed = parseAcpStatus(text);
    item = { acpState: parsed === null ? "unknown" : "reported" };
    if (parsed === null) op.reason = "统计未匹配";
    if (parsed !== null) {
      status = { ...parsed, at };
      for (const block of parsed.blocks) {
        const known = blocks[block.id] === undefined ? {} : blocks[block.id];
        blocks[block.id] = { ...known, ...block };
      }
    }
  } else {
    item = { acpState: "ok" };
  }

  if (op.range === "") op.range = parsedRanges;

  const ops = [...base.ops, op].slice(-ACP_OPS);
  return { item, acp: { blocks, status, ops } };
}

/**
 * The `activity` projection unit: one record per session, folded over the whole
 * log, published to the client as-is (the client renders, it does not compute).
 */
export const activityProjection = {
  key: ACTIVITY_KEY,
  stateVersion: STATE_VERSION,
  stateSchema: plainSchema,
  // 每次冷启动都重新读一次本机历史：同一个进程里新开的会话也能用上刚攒的样本。
  init: () => ({ ...EMPTY, carried: historyRefs(historyTable()) }),
  apply: (state, event) => applyEvent(state, event),
  wire: {
    viewSchema: plainSchema,
    view: (state) => state,
  },
};
