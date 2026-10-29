/**
 * dsh-work-status 的宿主端：把会话日志折叠成一条"工作状态"记录。
 *
 * 宿主每收到一条已提交的会话事件就调用一次 applyEvent，得到新的记录；记录里有这一轮
 * 进行到哪、已经做过的动作（结果与耗时）、模型刚声明要做的下一批动作、正在写的回答
 * 预览，以及耗时统计和上下文维护的账。插件在 lib/index.js 里把它登记成会话投影，
 * 浏览器端通过 useProjection('workStatus') 直接读结果，自己不回放事件。
 *
 * 记录全是普通 JSON：投影缓存可以存检查点、冷启动可以恢复；stateVersion 变了，
 * 旧检查点作废，从日志重新折叠。
 *
 * @module dsh-work-status/status
 */
import { createHash } from "node:crypto";
import { historyRefs, historyTable, rememberSamples } from "./step-store.js";

/** Projection key the Host unit registers and the client reads. */
export const ACTIVITY_KEY = "workStatus";

/** 记录的结构版本；改了字段就加一，旧检查点会被丢弃重算。 */
const STATE_VERSION = 21;

/** 记录里各段文字与列表的上限。 */
const LIMIT = Object.freeze({
  /** 时间轨保留的动作条数：卡片只画最近几条，多留一些给"本轮历史"。 */
  items: 32,
  /** 回答预览：字数与行数（三点式回答刚好放得下）。 */
  draft: 240,
  draftLines: 5,
  /** 动作对象（路径、命令、搜索词……）。 */
  target: 120,
  /** 待办句子：卡片拿它当"这一步在办什么"。 */
  task: 72,
  /** 改的是哪一句：只引一小段。 */
  snippet: 28,
  /** 这一步的理由。 */
  why: 80,
  /** 失败原因：一行，留得住关键字（ENOENT / 401 / 报错函数名）即可。 */
  error: 90,
  /** 你这一轮的要求。 */
  prompt: 120,
});
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
 * 一次工具调用"在动什么"，按参数字段名认：从上往下，第一个有值的字段决定显示的文字和
 * 它的种类。种类让卡片按人的读法缩短——路径只看结尾的文件名，命令照原样——不用在
 * 浏览器里再猜字符串。字段名是各家工具的惯例写法。
 */
const ARG_FIELDS = [
  ["command", "command cmd script"],
  ["query", "pattern query q"],
  ["path", "file_path filePath path file paths"],
  ["url", "url"],
  ["list", "todos"],
  ["text", "description prompt name content text patch"],
].map(([kind, names]) => Object.freeze({ kind, names: names.split(" ") }));

/**
 * 压成一行再截断：keepTail 为真时留结尾、前面补省略号（路径要看的是文件名），
 * 否则留开头、结尾补省略号。
 */
function clip(text, limit, keepTail = false) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return keepTail ? "…" + flat.slice(flat.length - limit + 1) : flat.slice(0, limit - 1).trimEnd() + "…";
}

/** 命令开头常见的铺垫：先切目录、先设变量、多出来的连接符。 */
const COMMAND_PROLOGUE = [
  /^(?:cd|pushd|set-location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;|\|\|)\s*/i,
  /^(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+/,
  /^(?:&&|\|\||;)\s*/,
];

/**
 * 命令只留真正在干活的那段：agent 爱把活包在 `cd "<目录>" && VAR=x && python - <<'PY' …`
 * 里，这些铺垫在状态行上都是噪音。只去掉开头的语法铺垫和 heredoc 正文，命令本身一字不改。
 */
function tidyCommand(text) {
  let command = String(text).replace(/\s+/g, " ").trim();
  // 铺垫可能叠好几层（cd && export && …），最多剥 8 层。
  for (let layer = 0; layer < 8; layer += 1) {
    const stripped = COMMAND_PROLOGUE.reduce((rest, pattern) => rest.replace(pattern, ""), command);
    if (stripped === command) break;
    command = stripped;
  }
  // heredoc 标记往后都是脚本正文，不是动作。
  const heredoc = command.search(/\s*<<-?\s*['"]?[A-Za-z_]\w*['"]?/);
  if (heredoc >= 0) command = command.slice(0, heredoc);
  return command.replace(/[\s|&;<>-]+$/, "").trim();
}

/** 一段文字里第一行有内容的（去掉缩进）：用来引"改的是哪一句"。 */
function firstLine(value, limit) {
  if (typeof value !== "string") return "";
  const line = value.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === undefined ? "" : clip(line, limit);
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

const isScalar = (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** 一个参数值在卡片上怎么写；值不能用（空、全是空白、序列化不了）就返回 null，交给下一个字段。 */
function showArgument(value, kind) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    return clip(kind === "command" ? tidyCommand(value) : value, LIMIT.target, kind === "path");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return clip(value.every(isScalar) ? value.join(", ") : JSON.stringify(value), LIMIT.target);
  }
  if (isScalar(value)) return String(value);
  if (typeof value === "object") {
    try { return clip(JSON.stringify(value), LIMIT.target); } catch { return null; }
  }
  return null;
}

/**
 * 工具调用的参数（JSON 字符串）→ 卡片上动作旁边那段短文字，以及它的种类
 * （command / path / query / url / list / text / other）。绝不抛错：参数解析不了
 * （流式调用的参数可能还没写完）就退回原文。
 */
function describeArguments(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { target: "", kind: "other" };
  let args;
  try { args = JSON.parse(raw); } catch { return { target: clip(raw, LIMIT.target), kind: "other" }; }
  if (args === null || typeof args !== "object") return { target: clip(args, LIMIT.target), kind: "other" };
  const snippet = firstLine(args.old_string, LIMIT.snippet) || firstLine(args.new_string, LIMIT.snippet)
    || firstLine(args.content, LIMIT.snippet);
  for (const { kind, names } of ARG_FIELDS) {
    for (const name of names) {
      const shown = showArgument(args[name], kind);
      if (shown !== null) return { target: shown, kind, snippet };
    }
  }
  // 一个惯例字段都没有：拿第一个参数凑合，没有参数就空着。
  const names = Object.keys(args);
  if (names.length === 0) return { target: "", kind: "other" };
  const lead = args[names[0]];
  const target = typeof lead === "string" ? clip(lead, LIMIT.target)
    : isScalar(lead) ? String(lead)
      : clip(JSON.stringify(args) ?? "", LIMIT.target);
  return { target, kind: "other", snippet };
}

/**
 * 回答预览：分条的回答要保留换行（压成一段就成了读不下去的长句），
 * 所以只压行内空白、去掉空行，再按行数和字数各卡一次。
 */
function previewText(text, limit, maxLines) {
  const lines = String(text).split(/\r\n?|\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const joined = lines.slice(0, maxLines).join("\n");
  return joined.length > limit ? joined.slice(0, limit - 1).trimEnd() + "…" : joined;
}

/**
 * 从模型自己说的话里取“这一步是为了什么”：取最后一行、最后一句，
 * 因为紧挨着工具调用的那句话通常就是它的理由。
 * @param {string} text - 当前这一步模型写下的文字。
 * @param {number} [limit] - 最长保留的字符数。
 * @returns {string} 一句理由，没有可说的就返回空串。
 */
function purposeLine(text, limit = LIMIT.why) {
  if (typeof text !== "string") return "";
  const lastLine = text.split("\n").map((line) => line.trim()).filter(Boolean).pop();
  if (lastLine === undefined) return "";
  const sentences = lastLine.split(/(?<=[。！？!?;；])\s*/).map((part) => part.trim()).filter(Boolean);
  return clip(sentences.pop() ?? lastLine, limit, true);
}

/**
 * 投影登记要一个 schema。记录是本插件自己拼的，校验不会失败，所以原样放行；这样宿主端
 * 也不用依赖第三方校验库（以目录链接安装时，模块从插件自己的目录解析，那里没装这些库）。
 */
const passThrough = Object.freeze({
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
});

/**
 * 你这一轮的要求：第一段有字的文本，压成一行再截断，卡片拿它当"这轮在干什么"的框。
 * 运行时上下文、时间、技能目录、记忆召回也都以 user/message 进来；只有
 * source.kind === "user" 才真是人打的字，其余一律不算。
 */
function promptText(data) {
  if (data?.source?.kind !== "user" || !Array.isArray(data.content)) return "";
  for (const block of data.content) {
    const line = typeof block?.text === "string" ? block.text.replace(/\s+/g, " ").trim() : "";
    if (line !== "") return line.length > LIMIT.prompt ? line.slice(0, LIMIT.prompt - 1) + "…" : line;
  }
  return "";
}

/** 会话总账的初值。 */
const EMPTY_TOTALS = Object.freeze({ turns: 0, rounds: 0, steps: 0, ops: 0, errors: 0, ctx: 0, ctxFailed: 0, modelMs: 0, toolMs: 0, wallMs: 0, activeMs: 0, pauseMs: 0, firstAt: 0, lastAt: 0 });
/** 日志里每轮目标留多长。 */
const LOG_PROMPT = 80;

/** 冻结的空列表，空记录里的各个列表共用它。 */
const NONE = Object.freeze([]);

/** 什么都还没发生的记录：这个会话还没开始过任何一轮。 */
export function emptyState() {
  const blank = {
    v: STATE_VERSION,
    turn: 0,
    step: 0,
    phase: "idle",
    /** 上一轮为什么停（`stopCause` 的结果）；没停过或日志没写就是 null。 */
    endCause: null,
    startedAt: 0,
    updatedAt: 0,
    endedAt: 0,
    /** 等人期间不算工期：已累计的挂起时长、当前这段的起点（0 表示没在等）与是谁在等。 */
    pauseMs: 0,
    pauseAt: 0,
    pauseKind: "",
    pauseOpen: NONE,
    prompt: "",
    stage: null,
    items: NONE,
    plan: NONE,
    todos: NONE,
    draft: "",
    counts: Object.freeze({ ops: 0, steps: 0, tools: 0, context: 0, errors: 0, contextErrors: 0 }),
    contextMs: 0,
    history: NONE,
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
    decisions: NONE,
    decisionCounts: Object.freeze({ decisions: 0, progress: 0, info: 0, decided: 0, pending: 0, repeat: 0, unknown: 0 }),
    decisionSeen: NONE,
    decisionStart: 0,
    decisionSaid: "",
    decisionSig: "",
    repeatRead: null,
    stall: 0,
  };
  return Object.freeze(blank);
}

/** @type {ReturnType<typeof emptyState>} */
const EMPTY = emptyState();

/** 现在开着几段挂起（等人回答、等审批）。 */
function pauseKeys(state) {
  return Array.isArray(state.pauseOpen) ? state.pauseOpen : NONE;
}

/**
 * 开始一段挂起：第一个原因打开时记下起点，后来同时开着的只登记，不重复计时。
 * @param {object} state - 当前记录。
 * @param {string} key - 挂起原因，形如 `ask|<callId>` 或 `approval|<id>`。
 * @param {number} at - 挂起的时刻。
 * @returns {object} 新记录；已经在等同一个原因时原样返回。
 */
function openPause(state, key, at) {
  const keys = pauseKeys(state);
  if (keys.includes(key)) return state;
  return {
    ...state,
    pauseOpen: Object.freeze([...keys, key]),
    pauseAt: keys.length === 0 || !(state.pauseAt > 0) ? at : state.pauseAt,
    pauseKind: key.split("|")[0],
  };
}

/**
 * 结束一段挂起：最后一个原因关掉时把这一段记进 `pauseMs`，其余情况只销账。
 * @param {object} state - 当前记录。
 * @param {string} key - 结束的挂起原因。
 * @param {number} at - 结束的时刻。
 * @returns {object} 新记录；本来没在等这个原因时原样返回。
 */
function closePause(state, key, at) {
  const keys = pauseKeys(state);
  if (!keys.includes(key)) return state;
  const next = keys.filter((entry) => entry !== key);
  const spent = next.length === 0 && state.pauseAt > 0 && at > state.pauseAt ? at - state.pauseAt : 0;
  return {
    ...state,
    pauseOpen: next.length === 0 ? NONE : Object.freeze(next),
    pauseAt: next.length === 0 ? 0 : state.pauseAt,
    pauseMs: (state.pauseMs || 0) + spent,
    pauseKind: next.length === 0 ? "" : next[next.length - 1].split("|")[0],
  };
}

/** 收尾时把还开着的挂起全部截到 `at`：轮次结束时没有「还在等」这回事。 */
function closeAllPauses(state, at) {
  const keys = pauseKeys(state);
  if (keys.length === 0) return state;
  const spent = state.pauseAt > 0 && at > state.pauseAt ? at - state.pauseAt : 0;
  return { ...state, pauseOpen: NONE, pauseAt: 0, pauseMs: (state.pauseMs || 0) + spent, pauseKind: "" };
}

/** 一轮怎么结束的 → 卡片阶段：真出错是 error，被打断或停下是 aborted，其余都算正常完成。 */
function endPhase(reason) {
  switch (typeof reason?.kind === "string" ? reason.kind : "completed") {
    case "error": return "error";
    case "aborted":
    case "interrupted": return "aborted";
    default: return "done";
  }
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
    if (line !== "") return clip(line, LIMIT.error, false);
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
  const settled = items.map((item) => {
    if (item.status !== "running" || item.id !== callId) return item;
    hit = true;
    return { ...item, status: failed ? "error" : "ok", t1: at, err: failed ? err : "" };
  });
  // 没对上任何调用就原样还回去，别让下游以为列表变了。
  return { items: hit ? settled : items, hit };
}

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
// Only explicit file reads with complete arguments can support a repetition claim.
const REPEAT_READ_TOOLS = new Set(["read", "read_file"]);
function readSignature(name, raw) {
  if (!REPEAT_READ_TOOLS.has(name) || typeof raw !== "string") return "";
  try {
    const args = JSON.parse(raw);
    const path = args && (args.file_path ?? args.path ?? args.filePath);
    if (typeof path !== "string" || !path.trim()) return "";
    return createHash("sha256").update(name + "\0" + raw).digest("hex");
  } catch { return ""; }
}
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
    return { ...state, decisionStart: 0, decisionSaid: "", decisionSig: "", repeatRead: null, stall: 0 };
  }
  if (contextOnly) {
    // 上下文维护是另一本账：不进入决策统计，但也不能卡住边界。
    return { ...state, decisionStart: 0, decisionSaid: "", decisionSig: "", repeatRead: null, stall: 0 };
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
  // Only a single completed read per step is unambiguous; parallel/mixed steps reset the chain.
  const single = items.length === 1 && items[0].status === "ok" && items[0].readSig ? items[0] : null;
  const previousRead = state.repeatRead;
  const sameRead = Boolean(single && previousRead && single.readSig === previousRead.sig);
  const repeatRead = single ? { sig: single.readSig, target: single.target, count: sameRead ? previousRead.count + 1 : 1 } : null;
  const sig = single ? single.readSig : "";
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
    reasons.push("读取了尚未记录的目标：" + fresh.slice(0, 3).join("、"));
  } else if (sig !== "" && sig === state.decisionSig) {
    outcome = "repeat";
    reasons.push("与上一步读取了相同目标；结果是否变化无法判断");
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
    repeatRead,
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
    // 上一轮真正干活的时长（等人回答的时间已经扣掉），折叠那一行用它。
    activeMs: typeof prevState.activeMs === "number" ? prevState.activeMs : 0,
    pauseMs: typeof prevState.pauseMs === "number" ? prevState.pauseMs : 0,
    items: prevItems.slice(-40),
    // 这一轮自己的上下文维护（会话账里落在本轮时间窗内的那几条），随上一轮一起折叠。
    ctx: turnOps(prevState),
  };
}

/** todo/write */
function takeTodos(state, data, at) {
  // 计划最多看前 40 条；没有文字的条目不要。
  const todos = [];
  for (const todo of (Array.isArray(data.todos) ? data.todos : []).slice(0, 40)) {
    if (todo === null || typeof todo !== "object") continue;
    const text = clip(typeof todo.content === "string" ? todo.content : "", LIMIT.task, true);
    if (text !== "") todos.push({ text, status: typeof todo.status === "string" ? todo.status : "pending" });
  }
  return { ...state, todos, updatedAt: at };
}

/** turn/start */
function startTurn(state, data, at) {
  return {
    v: STATE_VERSION,
    turn: typeof data.turn === "number" ? data.turn : state.turn + 1,
    step: 0,
    phase: "thinking",
    endCause: null,
    startedAt: at,
    updatedAt: at,
    endedAt: 0,
    pauseMs: 0,
    pauseAt: 0,
    pauseKind: "",
    pauseOpen: NONE,
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
    decisionSig: "",
    repeatRead: null,
    stall: 0,
  };
}

/** user/message */
function takeInstruction(state, data, at) {
  const prompt = promptText(data);
  // 不是人打的字、或者和现在的一样：记录不动。
  return prompt === "" || prompt === state.prompt ? state : { ...state, prompt, updatedAt: at };
}

/** step/start */
function startStep(state, data, at) {
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

/** assistant/message */
function takeReply(state, data, at) {
  // 这一步模型说的话（文字块）和它要调用的工具（tool-call 块）。
  const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
  const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  const why = purposeLine(text);
  const calls = blocks
    .filter((block) => block?.type === "tool-call" && typeof block.name === "string")
    .map((block) => ({ id: block.id, name: block.name, ...describeCall(block.arguments), why }));
  const draft = text.trim() === "" ? "" : previewText(text, LIMIT.draft, LIMIT.draftLines);
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
    whyText: why,
    whyStep: typeof data.step === "number" ? data.step : state.step,
    plan: calls.map((entry) => ({ ...entry, task: currentTask(state.todos), stage: stage ? stage.label : "" })),
    draft: draft || state.draft,
    decisionSaid: why || state.decisionSaid,
    updatedAt: at,
  };
}

/** tool/call */
function startCall(state, data, at) {
  const { callId } = data;
  const name = typeof data.name === "string" ? data.name : "tool";
  // 同一个调用又登记了一次（日志重放时会有）：已经在跑就不再加一行。
  if (state.items.find((item) => item.status === "running" && item.id === callId)) return state;
  const step = Number.isFinite(data.step) ? data.step : state.step;
  const described = describeCall(data.arguments);
  const acp = acpKindOf(name);
  const item = {
    id: callId,
    // “后来有没有同类成功”只认这个键：同工具 + 同目标；上下文维护认范围。
    key: acp === ""
      ? "tool|" + name + "|" + described.kind + "|" + described.target
      : "ctx|" + acp + "|" + acpRangeOf(data.arguments),
    name,
    readSig: readSignature(name, data.arguments),
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
  const next = {
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
    // 时间轨只留最近 LIMIT.items 条；开跑的这个调用从"接下来"里挪走。
    items: [...state.items, item].slice(-LIMIT.items),
    plan: state.plan.filter(({ id }) => id !== callId),
    updatedAt: at,
    counts: {
      ...state.counts,
      ops: state.counts.ops + 1,
      tools: state.counts.tools + 1,
      context: state.counts.context + (acp === "" ? 0 : 1),
    },
  };
  // 问用户的那一下起，到回答回来为止，都不算这一轮的工期。
  return WAIT_TOOLS.has(name) ? openPause(next, "ask|" + callId, at) : next;
}

/** tool/result */
function finishCall(state, data, at) {
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
  const settled = {
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
  // 回答回来了：问用户的那段挂起到此为止。
  return closePause(settled, "ask|" + callId, at);
}

/** turn/end */
function endTurn(state, data, at) {
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
  // 收尾时还开着的挂起（等到一半被打断）也算进等人时长，不留一段没结账的时间。
  const closed = closeAllPauses(stateAfter, at);
  const pauseMs = Math.min(wall, closed.pauseMs || 0);
  const active = Math.max(0, wall - pauseMs);
  const toolMs = (stateAfter.toolMs || 0) + (stateAfter.toolOpen > 0 && stateAfter.toolSince > 0 && at > stateAfter.toolSince ? at - stateAfter.toolSince : 0);
  const modelMs = stateAfter.modelMs || 0;
  const ctxOps = turnOps(stateAfter);
  const ctxFailed = ctxOps.filter((op) => op.status !== "ok").length;
  const record = {
    turn: stateAfter.turn,
    wallMs: wall,
    // 真正在干活的时长：墙上时间扣掉等人回答、等审批的那些段。
    activeMs: active,
    pauseMs,
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
      activeMs: (base.activeMs || 0) + active,
      pauseMs: (base.pauseMs || 0) + pauseMs,
      firstAt: base.firstAt > 0 ? base.firstAt : stateAfter.startedAt,
      lastAt: at,
    })
    : base;
  return { ...closed, activeMs: active, pauseMs, totals, toolMs, toolOpen: 0, toolSince: 0, stepModelDone: true, phase, endCause: stopCause(data.reason), items, plan: [], endedAt: at, updatedAt: at, whyText: "", whyStep: -1, history, stepStats, carried: rememberSamples(stepStats), stepStartAt: 0, stepSig: "", stepWait: false, stepChain: false, stepModelMs: 0, stepToolCat: Object.freeze({}), stepOpen: Object.freeze({}) };
}

/** approval/asked：工具要主人点头才能跑，等的这一段不算工期。 */
function takeApprovalAsked(state, data, at) {
  if (!(state.startedAt > 0) || state.phase === "idle") return state;
  const id = typeof data.id === "string" ? data.id : "";
  if (id === "") return state;
  return { ...openPause(state, "approval|" + id, at), updatedAt: at };
}

/** approval/decided：点头或拒绝，等的时间到此为止。 */
function takeApprovalDecided(state, data, at) {
  const id = typeof data.id === "string" ? data.id : "";
  if (id === "") return state;
  const closed = closePause(state, "approval|" + id, at);
  return closed === state ? state : { ...closed, updatedAt: at };
}

/** 每种事件交给谁处理；不在表里的事件与卡片无关，原样返回同一个记录。 */
const HANDLERS = Object.freeze({
  "todo/write": takeTodos,
  "turn/start": startTurn,
  "user/message": takeInstruction,
  "step/start": startStep,
  "assistant/message": takeReply,
  "tool/call": startCall,
  "tool/result": finishCall,
  "turn/end": endTurn,
  "approval/asked": takeApprovalAsked,
  "approval/decided": takeApprovalDecided,
});

/**
 * 把一条已提交的会话事件折进记录。
 *
 * 投影接口的约定：与卡片无关的事件必须返回**同一个对象**，这样没变化的折叠在下游
 * 没有任何开销，也不会触发发布。
 * @param {object} state - 当前记录（见 emptyState）。
 * @param {{ type: string, seq: number, time: number, data: any }} event - 一条日志事件。
 * @returns {object} 新记录；没变化时就是 state 本身。
 */
export function applyEvent(state, event) {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, event?.type) ? HANDLERS[event.type] : undefined;
  if (handler === undefined) return state;
  const data = event.data ? event.data : {};
  const at = typeof event.time === "number" ? event.time : state.updatedAt;
  return handler(state, data, at);
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
  const doing = Array.isArray(todos) ? todos.find((todo) => todo?.status === "in_progress") : undefined;
  return doing === undefined ? "" : clip(typeof doing.text === "string" ? doing.text : "", LIMIT.task, true);
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
 * 登记给宿主的会话投影：每个会话一条记录，从头折叠整段日志；浏览器端拿到的就是这条
 * 记录本身（只画，不再算）。
 */
export const activityProjection = {
  key: ACTIVITY_KEY,
  stateVersion: STATE_VERSION,
  stateSchema: passThrough,
  // 每次冷启动都重新读一次本机历史：同一个进程里新开的会话也能用上刚攒的样本。
  init: () => ({ ...EMPTY, carried: historyRefs(historyTable()) }),
  apply: applyEvent,
  // 线上视图就是记录本身，不另做裁剪。
  wire: { viewSchema: passThrough, view: (record) => record },
};
