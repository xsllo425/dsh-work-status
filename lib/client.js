/**
 * dsh-work-status — the browser half.
 *
 * Renders one compact card in the conversation input dock ("conversation.input.dock",
 * the full-width strip right above the composer card), so the card is on screen
 * exactly while the agent works and the answer is still being produced.
 *
 * The card answers two questions, continuously:
 *   · 已经干了什么 — the tool calls of this turn in order, each with its target
 *     (a file, a command, a pattern …) and how long it took;
 *   · 接下来准备干什么 — the calls the model has just declared for the next
 *     step, plus the first open item of the agent's own plan (the `todos`
 *     projection), plus a one-line preview of the text it is writing.
 *
 * Data comes from the Host half: it folds the session log into the `activity`
 * projection and the projection seam delivers the finished value. This file
 * never subscribes to session events, replays a log or mutates the DOM outside
 * its own component tree.
 */
window.__ModuleLoader__.load({
  id: "dsh-work-status",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-work-status";
    const SLOT = "conversation.input.dock";
    const ENTRY_ID = "activity";
    const ORDER = 40;

    /** Keep the finished summary on screen briefly, then let the card go. */
    /** Entries rendered at once: enough to read a step, short enough to stay a card. */
    const RECENT_ITEMS = 5;
    const TOP_EVENTS = 4;
    /** 宿主 history 保留的轮数（lib/activity.js 的 HISTORY_TURNS）。 */
    const LOG_TURNS = 24;
    const HISTORY_LIMIT = 60;
    /** 多久没有新事件就写一句“已经 N 秒没有新动静”：卡住时这是唯一可确认的事实。 */
    const STALL_SECONDS = 45;
    /** Collapse-state preference survives reloads; a broken storage is not an error. */
    const PREF_KEY = "dsh-work-status:collapsed";

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 宿主 locale 的插值语法是 {name}；未注入 t 时用 fallbackT 兜底。

    const MESSAGES_ZH = {
      "title": "本轮工作状态",
      "petHint": "右键查看本轮工作状态",
      "dismiss": "本轮不再显示",
      "tag.recovered": "已恢复",
      "row.kind.context": "上下文维护",
      "row.kind.tool": "工具调用",
      "row.start": "开始 {time}",
      "row.span": "{from} → {to}",
    "row.took": "用时 {time}",
    "prev.label": "上一轮 · 第 {turn} 轮",
    "prev.steps": "{steps} 步",
    "prev.goal": "当时的目标",
    "prev.sep": "以上本轮 · 以下上一轮",
    "prev.metrics": "推理 {model} · 工具 {tool}",
    "now.think": "模型思考中",
    "now.tool": "工具执行中",
    "now.write": "写回答",
    "prev.fail": "{n} 次失败",
      "tag.pending": "未恢复",
      "plan.progress": "计划 {done}/{total}",
      "chip.live": "{action}，已用时 {time}",
      "chip.steps": "{steps} 步",
      "chip.fail": "{n} 个失败",
      "fail.pending": "{n} 项失败未处理",
      "fail.title": "异常",
      "head.done": "本轮完成 {steps} 步",
      "head.turn": "本轮 {steps} 步",
      "head.direct": "本轮 · 直接回答",
      "chip.direct": "直接回答",
      "noEvents": "还没有动作",
      "log.open": "日志",
      "log.back": "返回",
      "log.copy": "复制",
      "log.copied": "已复制",
      "log.title": "会话日志",
      "log.sum": "共 {turns} 轮 · {rounds} 步 · {ops} 次调用",
      "log.time": "推理 {model} · 工具 {tool} · 合计 {wall}",
      "log.ctx": "上下文压缩 {n} 次",
      "log.ctxFail": "失败 {n}",
      "log.turn": "第 {turn} 轮",
      "log.row": "{rounds} 步 · {ops} 次调用",
      "log.split": "推理 {model} · 工具 {tool}",
      "log.total": "合计 {wall}",
      "log.live": "进行中",
      "log.recent": "逐轮记录只保留最近 {n} 轮；总计从会话开始累计",
      "log.empty": "这个会话还没有结束的轮次",
      "log.fail": "{n} 次失败",
      "log.aborted": "已中断",
      "log.error": "出错结束",
      "sub.finished": "共 {tools} 次工具调用",
      "sub.ops": "{ops} 次操作 · 其中上下文维护 {ctx} 次",
      "goal.label": "目标",
      "stage.label": "当前问题",
      "ctx.summary": "上下文维护 · {n} 次",
      "metric.model": "模型推理",
      "metric.tool": "工具调用",
      "metric.ctx": "上下文压缩",
      "metric.ctxTimes": "{n} 次",
      "metric.ctxFail": "失败 {n}",
      "metric.ctxTitle": "累计省下 {saved}",
      "goalShow": "展开",
      "goalHide": "收起",
      "ctx.compress": "压缩上下文",
      "ctx.decompress": "恢复上下文",
      "ctx.search_context": "检索历史",
      "ctx.acp_status": "查看上下文状态",
      "ctx.other": "上下文操作",
      "ctx.saved": "省 ~{saved}",
      "ctx.active": "{n} 块仍在",
      "ctx.degraded": "统计不可用",
      "ctx.failed": "{n} 次失败",
      "ctx.keepAll": "全部保持压缩",
      "ctx.allRestored": "已全部恢复",
      "ctx.effect.unknown": "回执未写明块号",
      "ctx.fail.stale": "没压成：范围已失效，本次没有新增压缩块",
      "ctx.redeemed": "这次没压成，后面同类操作已经成功，不影响结果",
      "row.settled": "这次没成功，后面同类操作已经成功，没有留下影响",
      "ctx.restoredCount": "已恢复 {n} 次",
      "ctx.official": "官方统计：原文 {original} → 摘要 {summary}（省 {percent}%），{active} 块",
      "ctx.blockMsgs": "{n} 条消息",
      "ctx.state.compressed": "保持压缩",
      "ctx.state.restored": "已恢复",
      "ctx.state.failed": "失败",
      "ctx.state.unknown": "结果未知",
      "ctx.state.reported": "读到统计",
      "ctx.state.searched": "检索",
      "ctx.effect.saved": "省 ~{saved}",
      "ctx.effect.compressed": "已压缩",
      "ctx.effect.restored": "已恢复 {block}",
      "ctx.effect.restored.bare": "已恢复",
      "mode.determined": "确定 {done}/{total} · {percent}%（按当前清单）",
      "step.facts": "本步 {elapsed} · 模型 {model} · 工具 {tool}",
      "step.bare": "未知 · 已 {elapsed}",
      "intent.think": "想事情",
      "mode.unknown": "未知 · 已 {time}",
      "rawTitle": "完整记录",
      "phase.idle": "空闲",
      "phase.thinking": "正在想",
      "phase.tool": "正在干活",
      "phase.writing": "正在写回答",
      "phase.done": "已完成",
      "phase.error": "出错了",
      "phase.aborted": "已停下",
      "step": "第 {step} 步",
      "counts": "已做 {tools} 件事",
      "countsWithErrors": "已做 {tools} 件事 · {errors} 件失败",
      "tool.other": "操作",
      "tool.mcp": "外部工具",
      "tool.read": "读文件",
      "tool.write": "写文件",
      "tool.edit": "改文件",
      "tool.grep": "搜索代码",
      "tool.glob": "找文件",
      "tool.ls": "看目录",
      "tool.ops_bash": "运行命令",
      "tool.bash": "运行命令",
      "tool.pwsh": "运行命令",
      "tool.shell": "运行命令",
      "tool.terminal": "用终端",
      "tool.web_search": "上网搜索",
      "tool.web_fetch": "打开网页",
      "tool.read_image": "看图片",
      "tool.todo_write": "更新计划",
      "tool.skill": "加载技能",
      "tool.subagent": "派给帮手",
      "tool.subagent_fork": "派给帮手",
      "tool.spawn_teammate": "派出帮手",
      "tool.send_message": "给帮手发消息",
      "tool.list_agents": "查看帮手",
      "tool.create_goal": "设定目标",
      "tool.update_goal": "更新目标",
      "tool.present": "交付文件",
      "tool.session_search": "翻找历史",
      "tool.job_output": "看后台任务",
      "tool.job_list": "看后台任务",
      "tool.cordis_inspect_query": "查接口",
      "tool.ask_user_question": "向你提问",
      "intent.read": "读文件",
      "intent.write": "写文件",
      "intent.edit": "改文件",
      "intent.search": "找代码",
      "intent.find": "找文件",
      "intent.look": "看目录",
      "intent.web": "上网搜",
      "intent.page": "打开网页",
      "intent.plan": "更新任务清单",
      "intent.skill": "查技能说明",
      "intent.delegate": "交给帮手",
      "intent.present": "交付文件",
      "intent.ask": "问你一句",
      "intent.history": "翻聊天记录",
      "intent.image": "看图",
      "intent.goal": "定个目标",
      "intent.job": "看后台任务",
      "intent.inspect": "查内部接口",
      "intent.test": "跑测试",
      "intent.ship": "提交代码",
      "intent.vcs": "看仓库状态",
      "intent.install": "装依赖",
      "intent.network": "访问网络",
      "intent.files": "整理文件",
      "intent.script": "跑脚本",
      "intent.publish": "发布上线",
      "intent.check": "检查语法",
      "intent.update": "拉取最新代码",
      "intent.pip": "装 Python 包",
      "intent.api": "调接口",
      "intent.download": "下载文件",
      "intent.fetch": "下载网页",
      "intent.text": "改文本",
      "intent.mkdir": "建目录",
      "intent.remove": "删文件",
      "intent.move": "复制/移动文件",
      "intent.archive": "打包/解包",
      "intent.process": "看进程",
      "intent.python": "跑 Python 脚本",
      "intent.node": "跑 Node 脚本",
      "intent.clock": "看当前时间",
      "intent.run": "执行命令",
      "intent.external": "用外部工具",
      "intent.other": "做了一件小事",
      "editSnippet": "改「{snippet}」",
      "createFile": "写 {name}",
      "doing": "正在{text}",
      "seconds": "{seconds}秒",
      "minutes": "{minutes}分{seconds}秒",
      "done": "已完成",
      "next": "接下来",
      "running": "进行中",
      "queued": "即将运行",
      "earlier": "…之前的 {count} 步",
      "planProgress": "{done}/{total} 项计划",
      "myPlan": "这轮要做的事",
      "todoDone": "{count} 已完成",
      "todoRunning": "{count} 正在做",
      "todoPending": "{count} 待处理",
      "actionsHead": "具体动作",
      "didWhat": "我做了什么",
      "why": "为了",
      "itsWords": "它的原话",
      "failTag": "失败",
      "failCount": "{count} 次失败",
      "stall": "{time}没动静",
      "unknownTag": "结果未知",
      "todoNow": "正在做「{text}」",
      "todoNext": "下一项「{text}」",
      "noAction": "等待下一步",
      "hideRound": "收起这一轮",
      "showAgain": "活动",
      "showAgainTitle": "把这一轮的动作再展开",
      "planEmpty": "等待下一步",
      "draft": "正在写回答",
      "collapse": "收起",
      "expand": "展开 Agent 动态",
      "statusOk": "成功",
      "statusError": "失败",
      "statusRunning": "运行中",
      "statusQueued": "排队中",
      "toolsLabel": "工具",
      "turnDone": "本轮完成 {count} 步",
      "turnFailed": "本轮结束 · {count} 个操作失败",
      "failPending": "{count} 个待处理",
      "failRecovered": "{count} 个已恢复",
      "failPendingTag": "失败 {count} · 待处理",
      "failRecoveredTag": "失败 {count} · 已恢复",
      "recovered": "已恢复",
      "failed": "失败",
      "nextPlan": "下一步「{text}」",
      "planCount": "计划 {done}/{total}",
      "recap": "完成 {parts}",
      "dot": "·",
      "stepCount": "{count} 步",
      "andMore": "另 {count} 类",
      "recent": "最近操作",
      "rawShow": "原始记录（{count} 条）",
      "historyShow": "展开本轮历史 · {count} 步",
      "historyHide": "收起历史",
      "rawHide": "收起原始记录",
      "kind.tool": "操作",
      "kind.read": "读",
      "kind.write": "写",
      "kind.edit": "改",
      "kind.search": "查",
      "kind.web": "上网",
      "kind.plan": "计划",
      "kind.delegate": "派活",
      "kind.image": "看图",
      "kind.ask": "提问",
      "kind.present": "交付",
      "kind.test": "测试",
      "kind.git": "仓库",
      "kind.exec": "跑命令",
    };

    const MESSAGES_EN = {
      "title": "This turn's work status",
      "petHint": "Right-click for this turn's work status",
      "dismiss": "Hide for this turn",
      "tag.recovered": "recovered",
      "row.kind.context": "context maintenance",
      "row.kind.tool": "tool call",
      "row.start": "started {time}",
      "row.span": "{from} → {to}",
    "row.took": "took {time}",
    "prev.label": "Previous · turn {turn}",
    "prev.steps": "{steps} steps",
    "prev.goal": "Its goal",
    "prev.sep": "this turn above · previous below",
    "prev.metrics": "model {model} · tools {tool}",
    "now.think": "Model thinking",
    "now.tool": "Tool running",
    "now.write": "Writing the answer",
    "prev.fail": "{n} failed",
      "tag.pending": "open",
      "plan.progress": "Plan {done}/{total}",
      "chip.live": "{action}, {time} elapsed",
      "chip.steps": "{steps} steps",
      "chip.fail": "{n} failed",
      "fail.pending": "{n} unresolved failures",
      "fail.title": "Problems",
      "head.done": "Turn finished, {steps} steps",
      "head.turn": "This turn · {steps} steps",
      "head.direct": "This turn · answered directly",
      "chip.direct": "answered",
      "noEvents": "No actions yet",
      "log.open": "Log",
      "log.back": "Back",
      "log.copy": "Copy",
      "log.copied": "Copied",
      "log.title": "Session log",
      "log.sum": "{turns} turns · {rounds} steps · {ops} calls",
      "log.time": "model {model} · tools {tool} · total {wall}",
      "log.ctx": "context compressed {n}×",
      "log.ctxFail": "{n} failed",
      "log.turn": "Turn {turn}",
      "log.row": "{rounds} steps · {ops} calls",
      "log.split": "model {model} · tools {tool}",
      "log.total": "total {wall}",
      "log.live": "running",
      "log.recent": "Per-turn rows keep the last {n} turns; totals cover the whole session",
      "log.empty": "No finished turns in this session yet",
      "log.fail": "{n} failed",
      "log.aborted": "aborted",
      "log.error": "ended with error",
      "sub.finished": "{tools} tool calls",
      "sub.ops": "{ops} operations · {ctx} of them context upkeep",
      "goal.label": "Goal",
      "stage.label": "Working on",
      "ctx.summary": "Context upkeep · {n}",
      "metric.model": "Model",
      "metric.tool": "Tools",
      "metric.ctx": "Context",
      "metric.ctxTimes": "{n}×",
      "metric.ctxFail": "{n} failed",
      "metric.ctxTitle": "saved {saved} in total",
      "goalShow": "more",
      "goalHide": "less",
      "ctx.compress": "Compressed context",
      "ctx.decompress": "Restored context",
      "ctx.search_context": "Searched history",
      "ctx.acp_status": "Checked context status",
      "ctx.other": "Context operation",
      "ctx.saved": "saved ~{saved}",
      "ctx.active": "{n} block(s) still compressed",
      "ctx.degraded": "stats unavailable",
      "ctx.failed": "{n} failed",
      "ctx.keepAll": "all still compressed",
      "ctx.allRestored": "all restored",
      "ctx.effect.unknown": "receipt did not name a block",
      "ctx.fail.stale": "not compressed: range went stale, nothing new was compressed",
      "ctx.redeemed": "Failed this time; a later attempt of the same kind succeeded, so nothing was lost",
      "row.settled": "Failed this time; a later attempt of the same kind succeeded, so nothing was lost",
      "ctx.restoredCount": "{n} restored",
      "ctx.official": "Official: {original} original → {summary} summary (−{percent}%), {active} block(s)",
      "ctx.blockMsgs": "{n} msgs",
      "ctx.state.compressed": "compressed",
      "ctx.state.restored": "restored",
      "ctx.state.failed": "failed",
      "ctx.state.unknown": "unknown",
      "ctx.state.reported": "reported",
      "ctx.state.searched": "searched",
      "ctx.effect.saved": "saved ~{saved}",
      "ctx.effect.compressed": "compressed",
      "ctx.effect.restored": "restored {block}",
      "ctx.effect.restored.bare": "restored",
      "mode.determined": "Confirmed {done}/{total} · {percent}% (current list)",
      "step.facts": "This step {elapsed} · model {model} · tools {tool}",
      "step.bare": "Unknown · {elapsed} elapsed",
      "mode.unknown": "Unknown · {time} elapsed",
      "rawTitle": "Full record",
      "phase.idle": "Idle",
      "phase.thinking": "Thinking",
      "phase.tool": "Working",
      "phase.writing": "Writing",
      "phase.done": "Done",
      "phase.error": "Failed",
      "phase.aborted": "Stopped",
      "step": "step {step}",
      "counts": "{tools} things done",
      "countsWithErrors": "{tools} done · {errors} failed",
      "tool.other": "Action",
      "tool.mcp": "External tool",
      "tool.read": "Read file",
      "tool.write": "Write file",
      "tool.edit": "Edit file",
      "tool.grep": "Search code",
      "tool.glob": "Find files",
      "tool.ls": "Look in folder",
      "tool.ops_bash": "Run command",
      "tool.bash": "Run command",
      "tool.pwsh": "Run command",
      "tool.shell": "Run command",
      "tool.terminal": "Use terminal",
      "tool.web_search": "Search the web",
      "tool.web_fetch": "Open page",
      "tool.read_image": "View image",
      "tool.todo_write": "Update plan",
      "tool.skill": "Load skill",
      "tool.subagent": "Delegate",
      "tool.subagent_fork": "Delegate",
      "tool.spawn_teammate": "Spawn helper",
      "tool.send_message": "Message helper",
      "tool.list_agents": "List helpers",
      "tool.create_goal": "Set goal",
      "tool.update_goal": "Update goal",
      "tool.present": "Present files",
      "tool.session_search": "Search history",
      "tool.job_output": "Check background job",
      "tool.job_list": "Check background jobs",
      "tool.cordis_inspect_query": "Inspect API",
      "tool.ask_user_question": "Ask you",
      "intent.think": "think",
      "intent.read": "read a file",
      "intent.write": "write a file",
      "intent.edit": "edit a file",
      "intent.search": "find the code",
      "intent.find": "find files",
      "intent.look": "look in a folder",
      "intent.web": "search the web",
      "intent.page": "open a page",
      "intent.plan": "update the task list",
      "intent.skill": "read a skill",
      "intent.delegate": "hand it to a helper",
      "intent.present": "hand over files",
      "intent.ask": "ask you",
      "intent.history": "search past chats",
      "intent.image": "look at an image",
      "intent.goal": "set a goal",
      "intent.job": "check a background job",
      "intent.inspect": "inspect an internal API",
      "intent.test": "run the tests",
      "intent.ship": "commit the work",
      "intent.vcs": "check the repository",
      "intent.install": "install dependencies",
      "intent.network": "call the network",
      "intent.files": "move files around",
      "intent.script": "run a script",
      "intent.publish": "publish a release",
      "intent.check": "check the syntax",
      "intent.update": "pull the latest code",
      "intent.pip": "install a Python package",
      "intent.api": "call an API",
      "intent.download": "download a file",
      "intent.fetch": "download a webpage",
      "intent.text": "edit text",
      "intent.mkdir": "create a folder",
      "intent.remove": "delete files",
      "intent.move": "copy or move files",
      "intent.archive": "pack or unpack",
      "intent.process": "look at processes",
      "intent.python": "run a Python script",
      "intent.node": "run a Node script",
      "intent.clock": "check the clock",
      "intent.run": "run a command",
      "intent.external": "use an external tool",
      "intent.other": "did a small step",
      "editSnippet": "edit “{snippet}”",
      "createFile": "write {name}",
      "doing": "{text}",
      "seconds": "{seconds}s",
      "minutes": "{minutes}m {seconds}s",
      "done": "Done",
      "next": "Up next",
      "running": "Running",
      "queued": "Queued",
      "earlier": "…{count} earlier steps",
      "planProgress": "{done}/{total} planned",
      "myPlan": "This turn",
      "todoDone": "{count} done",
      "todoRunning": "{count} now",
      "todoPending": "{count} to go",
      "actionsHead": "What I ran",
      "didWhat": "What I did",
      "why": "for",
      "itsWords": "its own words",
      "failTag": "failed",
      "failCount": "{count} failed",
      "stall": "{time} quiet",
      "unknownTag": "Result unknown",
      "todoNow": "doing “{text}”",
      "todoNext": "next “{text}”",
      "noAction": "Waiting for the next step",
      "hideRound": "Hide this turn",
      "showAgain": "Activity",
      "showAgainTitle": "Show this turn again",
      "planEmpty": "Waiting for the next step",
      "draft": "Writing the answer",
      "collapse": "Collapse",
      "expand": "Expand agent activity",
      "statusOk": "succeeded",
      "statusError": "failed",
      "statusRunning": "running",
      "statusQueued": "queued",
      "toolsLabel": "tools",
      "turnDone": "Done · {count} steps",
      "turnFailed": "Turn ended · {count} failed",
      "failPending": "{count} unresolved",
      "failRecovered": "{count} recovered",
      "failPendingTag": "{count} failed",
      "failRecoveredTag": "{count} failed, recovered",
      "recovered": "recovered",
      "failed": "failed",
      "nextPlan": "next: {text}",
      "planCount": "{done}/{total} planned",
      "recap": "{parts}",
      "dot": "·",
      "stepCount": "{count} steps",
      "andMore": "{count} more kinds",
      "recent": "Recent",
      "rawShow": "Raw log ({count})",
      "historyShow": "Show this turn · {count} steps",
      "historyHide": "Hide history",
      "rawHide": "Hide raw log",
      "kind.tool": "actions",
      "kind.read": "reads",
      "kind.write": "writes",
      "kind.edit": "edits",
      "kind.search": "searches",
      "kind.web": "web",
      "kind.plan": "plan",
      "kind.delegate": "delegation",
      "kind.image": "images",
      "kind.ask": "questions",
      "kind.present": "deliveries",
      "kind.test": "tests",
      "kind.git": "git",
      "kind.exec": "commands",
    };

    function interpolate(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ));
    }

    function makeDictionary(dictionary) {
      return function t(key, params) {
        const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
        return interpolate(template, params);
      };
    }

    const fallbackT = makeDictionary(MESSAGES_ZH);

    // ── 时间与状态 ──────────────────────────────────────────────────────────

    const LIVE_PHASES = new Set(["thinking", "tool", "writing"]);
    const FINISHED_PHASES = new Set(["done", "error", "aborted"]);
    /** 认识的全部阶段；未知值按 idle 处理，绝不把原始 key 画到界面上。 */
    const PHASES = new Set(["idle", ...LIVE_PHASES, ...FINISHED_PHASES]);

    /** 「12秒」/「2分03秒」——秒级读数，超过一分钟才进位。 */
    function formatDuration(ms, t) {
      const total = Math.max(0, Math.round(ms / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60);
      if (minutes === 0) return t("seconds", { seconds });
      return t("minutes", { minutes, seconds: String(seconds).padStart(2, "0") });
    }

    /** 右对齐的毫秒读数：1.2s / 12s / 1m03s —— 取的是这个数本身，不用 t。 */
    function formatTokens(n) {
      if (!n || n < 0) return "0";
      if (n < 1000) return String(Math.round(n));
      return Math.round(n / 1000) + "K";
    }

    function formatShort(ms) {
      if (!Number.isFinite(ms) || ms < 0) return "";
      if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
      const seconds = ms / 1000;
      if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
      const whole = Math.round(seconds);
      if (whole < 60) return `${whole}s`;
      if (whole < 3600) return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
      return `${Math.floor(whole / 3600)}h${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}m`;
    }

    /**
     * 分位数：历史样本很少时只做“粗略区间”，不假装精确。
     * @param {number[]} sorted - 已排序的样本。
     * @param {number} fraction - 0..1。
     * @returns {number} 该分位的值。
     */
    function quantile(sorted, fraction) {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
      return sorted[index];
    }

    /**
     * 进度与步骤参照：真实 todo 给完成比例；当前这一步给同类步的历史分位数。
     * 不预测“整轮还要多久”——评测显示轮级 ETA 与最笨的基线持平（平均误差 87s vs 78s），
     * 而步级参照的误差只有 5 秒。样本不足就只说这一步已经用了多久。
     * @param {object | undefined} activity - 投影记录。
     * @param {readonly object[]} todos - 宿主待办（真实完成量）。
     * @param {number} now - 当前时间（epoch ms）。
     * @returns {object} 模式与当前步的参照区间。
     */
    const MIN_REF_SAMPLES = 5;

    /** 取某一键的样本：过滤脏值、升序、去重不做（重复出现是真实重复）。 */
    function samplesOf(stats, key) {
      const raw = stats && typeof stats === "object" && Array.isArray(stats[key]) ? stats[key] : [];
      return raw.filter((ms) => Number.isFinite(ms) && ms > 0).slice().sort((left, right) => left - right);
    }

    /** 样本够了才给分位数；不够就说“没参照”，不硬凑区间。 */
    function referenceOf(samples) {
      if (samples.length < MIN_REF_SAMPLES) {
        return { n: samples.length, ready: false, p25: 0, med: 0, p75: 0, over: false };
      }
      return {
        n: samples.length,
        ready: true,
        p25: quantile(samples, 0.25),
        med: quantile(samples, 0.5),
        p75: quantile(samples, 0.75),
        over: false,
      };
    }

    /**
     * 当前这一步的耗时事实：模型推理、各类工具分开算，绝不合并成一个“步耗时”。
     * 有 todo 时给确定比例（注明只是当前清单）；没有 todo 时只给这一步的参照；
     * 参照样本不足就退到“未知 + 已耗时”，不猜百分比、不预测整轮。
     * @param {object} activity - workStatus 投影值。
     * @param {object[] | null} todos - todos 投影值。
     * @param {number} now - 当前时刻（毫秒）。
     * @returns {object} { mode, wall, step, steps, done?, total?, percent? }
     */
    function estimateProgress(activity, todos, now) {
      const startedAt = activity && typeof activity.startedAt === "number" ? activity.startedAt : 0;
      const wall = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
      const plan = todoProgress(todos) || { done: 0, total: 0, next: "" };
      const stats = activity && activity.stepStats && typeof activity.stepStats === "object" ? activity.stepStats : {};
      const sig = activity && typeof activity.stepSig === "string" ? activity.stepSig : "";
      const stepStart = activity && typeof activity.stepStartAt === "number" ? activity.stepStartAt : 0;
      const elapsed = stepStart > 0 && now > stepStart ? now - stepStart : 0;
      const modelMs = activity && typeof activity.stepModelMs === "number" && activity.stepModelMs > 0
        ? activity.stepModelMs
        : elapsed;
      const cats = activity && activity.stepToolCat && typeof activity.stepToolCat === "object" ? activity.stepToolCat : {};
      const toolMs = Object.keys(cats).reduce((sum, key) => sum + (Number.isFinite(cats[key]) ? cats[key] : 0), 0);
      const model = referenceOf(samplesOf(stats, sig === "" ? "model|（无工具）" : "model|" + sig));
      model.over = model.ready && modelMs > model.p75;
      const tools = Object.keys(cats).map((category) => {
        const ref = referenceOf(samplesOf(stats, "tool|" + category + "|" + sig));
        const ms = Number.isFinite(cats[category]) ? cats[category] : 0;
        ref.over = ref.ready && ms > ref.p75;
        return { category, ms, ref };
      });
      const step = { sig, elapsed, modelMs, toolMs, model, tools };
      const base = {
        wall,
        step,
        steps: activity && activity.counts && typeof activity.counts.steps === "number" ? activity.counts.steps : 0,
      };
      if (plan.total > 0) {
        return {
          ...base,
          mode: "determined",
          percent: Math.round(Math.min(1, plan.done / plan.total) * 100),
          done: plan.done,
          total: plan.total,
        };
      }
      const ready = model.ready || tools.some((entry) => entry.ref.ready);
      return { ...base, mode: ready ? "step" : "unknown" };
    }

    function readCollapsedPreference() {
      try {
        const stored = globalThis.localStorage?.getItem(PREF_KEY);
        return stored === null || stored === undefined ? true : stored === "1";
      } catch {
        return true;
      }
    }

    function writeCollapsedPreference(collapsed) {
      try {
        globalThis.localStorage?.setItem(PREF_KEY, collapsed ? "1" : "0");
      } catch {
        /* private mode / quota: the card still works, it just forgets */
      }
    }

    // ── 视图内容推导 ────────────────────────────────────────────────────────

    /**
     * 已完成的条目里只画最后几条；更早的折成一行计数，保持卡片高度稳定。
     * @param {readonly object[]} items - activity.items
     * @returns {{ listed: object[], hidden: number }} 可见条目与被折叠的数量
     */
    function listedItems(items, room) {
      if (items.length <= room) return { listed: items, hidden: 0 };
      return { listed: items.slice(items.length - room), hidden: items.length - room };
    }

    /**
     * 「接下来准备干什么」：先是模型刚刚声明的待执行调用（最临近），
     * 再是计划里的第一条未完成项（走向，而不是下一步）。
     * @param {object} activity - the activity projection value.
     * @param {object[] | null} todos - the `todos` projection value.
     * @returns {object[]} up to three entries: {kind:'call'|'todo', ...}
     */
    function nextUp(activity, todos) {
      const result = [];
      const plan = Array.isArray(activity.plan) ? activity.plan : [];
      for (const entry of plan.slice(0, 2)) {
        result.push({ kind: "call", name: entry.name, target: entry.target, targetKind: entry.kind });
      }
      const open = Array.isArray(todos) ? todos.filter((todo) => todo && todo.status !== "completed") : [];
      const first = open[0];
      if (first && typeof first.content === "string") result.push({ kind: "todo", text: first.content });
      return result.slice(0, 3);
    }

    /** 计划进度：已完成 / 总数，以及下一项未完成的内容（计划这一步的走向）。 */
    function todoProgress(todos) {
      if (!Array.isArray(todos) || todos.length === 0) return null;
      const done = todos.filter((todo) => todo && todo.status === "completed").length;
      const open = todos.find((todo) => todo && todo.status !== "completed");
      return { done, total: todos.length, next: open && typeof open.content === "string" ? open.content : "" };
    }

    /**
     * 把工具名翻成人能读的动作：`ops_bash` → “运行命令”，`edit` → “改文件”。
     * 只用来给完全不认识的工具兜底；认识的工具都走下面的“意图”表。
     */
    function toolLabel(name, t) {
      const raw = String(name);
      const key = `tool.${raw}`;
      const translated = t(key);
      if (translated !== key) return translated;
      if (raw.startsWith("mcp__")) return t("tool.mcp");
      return t("tool.other");
    }

    // ── 意图：卡片上要读到的不是“调用了什么工具”，而是“想干什么” ──────────
    /** 工具名直接就能对上意图的那些。 */
    const INTENT_BY_TOOL = {
      read: "read",
      write: "write",
      edit: "edit",
      grep: "search",
      glob: "find",
      ls: "look",
      read_files: "read",
      read_file: "read",
      write_file: "write",
      edit_file: "edit",
      list_files: "look",
      grep_files: "search",
      glob_files: "find",
      run_command: "run",
      shell_command: "run",
      web_search: "web",
      web_fetch: "page",
      read_page: "page",
      todo_write: "plan",
      skill: "skill",
      subagent: "delegate",
      subagent_fork: "delegate",
      spawn_teammate: "delegate",
      send_message: "delegate",
      list_agents: "delegate",
      present: "present",
      ask_user_question: "ask",
      session_search: "history",
      read_image: "image",
      create_goal: "goal",
      update_goal: "goal",
      job_output: "job",
      job_list: "job",
      cordis_inspect_query: "inspect",
      cordis_inspect_list: "inspect",
    };

    /**
     * 命令行到底在做什么：读得出来就给出具体意图 + 一个提示（文件名 / 域名 / 子命令），
     * 读不出来就老实退回“执行命令”，并把原命令当提示显示——宁可给原文，也不给空话。
     * @param {string} command - the raw command line.
     * @returns {{ key: string, hint: string }} intent key and its short hint.
     */
    /** 原命令最多显示这么长，够看出在干什么。 */
    const RUN_HINT_LIMIT = 48;

    /** 把一条 shell 命令拆成人能认的几个片段：正文、引号里的内容、非旗标词。 */
    function commandPieces(command) {
      const stripped = String(command)
        .replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, " ")                       // 去掉 heredoc 正文
        // 去掉内联脚本正文（node -e "…"、python -c '…'）：正文里的 const、require、copy 不是命令
        .replace(/(\b(?:node|python3?|deno|bun)(?:\.exe)?\s+(?:-e|--eval|-p|--print|-c|eval)\s+)(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|["'][\s\S]*$)/gi, "$1 ")
        .replace(/^\s*(?:cd|pushd|Set-Location)\s+[^&;|]+(?:&&|;|\|)\s*/i, "") // 去掉“先切目录”
        .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)\s+/g, ""); // 去掉 VAR=… 前缀
      const quoted = [...stripped.matchAll(/"([^"]{1,80})"|'([^']{1,80})'/g)].map((m) => m[1] ?? m[2]).filter(Boolean);
      const words = stripped
        .split(/[\s;|&()<>]+/)
        .filter(Boolean)
        .map((word) => word.replace(/^["']|["']$/g, ""))
        .filter((word) => !word.startsWith("-") && !/^\d+(?:ms|s)?$/.test(word))
        .filter((word) => !/(?:^|[\\/])dev[\\/]null$|^(?:true|false|null)$/i.test(word));
      return { stripped, quoted, words };
    }

    /** 命令里第一个“像文件”的参数：前面的通常是解释器路径。 */
    function fileOperand(text) {
      const files = [...String(text).matchAll(/[\w.-]+\.(?:mjs|cjs|jsx?|tsx?|json|md|py|ps1|sh|tgz|zip)\b/gi)];
      return files.length === 0 ? "" : files[files.length - 1][0].split(/[\\/]/).pop();
    }

    /** 取 flag 后面的值，例如 find . -name "*.mjs" 里的 *.mjs。 */
    function flagValue(text, flags) {
      for (const flag of flags) {
        // 先试带引号的完整值（`-m "feat: 改文案"`），再退回单个词。
        const quoted = text.match(new RegExp(`(?:^|\\s)(?:${flag})\\s+["']([^"']+)["']`, "i"));
        if (quoted !== null) return quoted[1];
        const bare = text.match(new RegExp(`(?:^|\\s)(?:${flag})\\s+([^"'\\s]+)`, "i"));
        if (bare !== null) return bare[1];
      }
      return "";
    }

    /** 动词之外的“对象”：git 的子命令、第一个操作数，或引号里的内容。 */
    function subjectOf(pieces, verbPattern, pickQuoted) {
      const { stripped, quoted, words } = pieces;
      if (pickQuoted && quoted.length > 0) return quoted[0];
      const verbIndex = words.findIndex((word) => verbPattern.test(word));
      const candidates = verbIndex >= 0 ? words.slice(verbIndex + 1) : words.slice(1);
      const subject = candidates.find((word) => !/^(?:\/|[A-Za-z]:\\|\$)/.test(word) && !/^[\w-]+=/i.test(word)) ?? "";
      if (subject !== "") return subject;
      return candidates[1] ?? candidates[0] ?? "";
    }

    function commandPlan(command) {
      const text = String(command);
      const pieces = commandPieces(text);
      const flat = pieces.stripped;
      const url = flat.match(/https?:\/\/([^\s"'<>]+)/i);
      const host = url === null ? "" : url[1].replace(/^(?:www|api)\./i, "").split(/[/?#]/)[0];
      const base = fileOperand(flat);
      // 兜底：没有更好说法时，就显示命令本身的一小段，绝不返回空对象。
      const fallback = base || clipCommand(text);

      if (/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|--test\b|\bpytest\b|\bvitest\b|\bjest\b/i.test(flat)) {
        return { key: "test", hint: base || commandPieces(flat).quoted[0] || "" };
      }
      if (/--check\b|\btsc\b/i.test(flat)) return { key: "check", hint: base };

      const gitIndexes = pieces.words.reduce((list, word, index) => (/^git$/i.test(word) ? [...list, index] : list), []);
      if (gitIndexes.length > 0) {
        const last = gitIndexes[gitIndexes.length - 1];
        const sub = pieces.words[last + 1] ?? "";
        const subject = pieces.words[last + 2] ?? "";
        if (/^(?:commit|push|tag|merge|rebase)$/i.test(sub)) {
          // 提交说明比分支名更能说明这次干了什么。
          const message = flagValue(flat, ["-m", "--message"]);
          return { key: "ship", hint: [sub, message || subject].filter(Boolean).join(" ") };
        }
        if (/^(?:clone|pull|fetch)$/i.test(sub)) return { key: "update", hint: subject || sub };
        return { key: "vcs", hint: [sub, subject].filter(Boolean).join(" ") || "status" };
      }

      if (/\b(?:npm|pnpm|yarn)\s+(?:install|add|i)\b/i.test(flat)) {
        return { key: "install", hint: subjectOf(pieces, /^(?:install|add|i)$/i, false) };
      }
      if (/\bpip3?\s+install\b/i.test(flat)) return { key: "pip", hint: subjectOf(pieces, /^install$/i, false) };

      if (/\b(?:curl|wget|Invoke-WebRequest)\b/i.test(flat)) {
        if (/(?:^|\s)-o\s|\bOutFile\b/i.test(flat)) return { key: "download", hint: base || host };
        if (/\bapi\.|github\.com\/(?:repos|user|search)/i.test(flat)) return { key: "api", hint: host || fallback };
        return { key: "fetch", hint: host || base };
      }

      const program = (flat.trim().split(/[\s;|&()]+/)[0] ?? "").toLowerCase();
      if (/^(?:tasklist|taskkill|get-process|kill|ps)(?:\.exe)?$/.test(program)) {
        // `tasklist | grep node`：真正想知道的是“哪个进程”。
        const piped = flat.match(/\|\s*(?:grep|rg|Select-String)\s+["']?([^"'\s|]+)/i);
        return { key: "process", hint: piped !== null ? piped[1] : subjectOf(pieces, /^(?:tasklist|taskkill|Get-Process|kill|ps)$/i, false) };
      }

      if (/\b(?:ls|dir|tree)\b/i.test(flat)) return { key: "look", hint: subjectOf(pieces, /^(?:ls|dir|tree)$/i, false) || "当前目录" };
      if (/\b(?:find|glob)\b/i.test(flat)) {
        return { key: "find", hint: flagValue(flat, ["-name", "-iname", "-path"]) || subjectOf(pieces, /^(?:find|glob)$/i, false) };
      }
      if (/\b(?:grep|rg|Select-String)\b/i.test(flat)) {
        // 搜什么：引号里的关键词最准确，没有就取第一个操作数。
        // 带正则/格式符的片段（%-14s、[^x]* 这类）当提示反而像乱码，宁可不写。
        const wanted = pieces.quoted[0] || subjectOf(pieces, /^(?:grep|rg|Select-String)$/i, false) || "";
        const readable = /[%^$[\]()*+?|\\]/.test(wanted) ? base : wanted;
        return { key: "search", hint: readable };
      }
      if (/\b(?:cat|head|tail|less|type|Get-Content)\b/i.test(flat)) return { key: "read", hint: base || subjectOf(pieces, /^(?:cat|head|tail|less|type|Get-Content)$/i, false) };
      if (/\b(?:sed|awk|tr|cut|perl)\b/i.test(flat)) return { key: "text", hint: base || subjectOf(pieces, /^(?:sed|awk|tr|cut|perl)$/i, false) };
      if (/\b(?:mkdir|md)\b/i.test(flat)) return { key: "mkdir", hint: subjectOf(pieces, /^(?:mkdir|md)$/i, false) };
      if (/\b(?:rm|del|rmdir)\b/i.test(flat)) return { key: "remove", hint: subjectOf(pieces, /^(?:rm|del|rmdir)$/i, false) || fallback };
      if (/\b(?:cp|mv|copy|move|robocopy)\b/i.test(flat)) {
        const verbIndex = pieces.words.findIndex((word) => /^(?:cp|mv|copy|move|robocopy)$/i.test(word));
        const operands = pieces.words.slice(verbIndex + 1).filter((word) => word !== "");
        const pair = operands.length >= 2 ? `${operands[0]} → ${operands[1]}` : (operands[0] ?? base);
        return { key: "move", hint: pair };
      }
      if (/\b(?:tar|zip|unzip|7z|Expand-Archive|Compress-Archive)\b/i.test(flat)) return { key: "archive", hint: base || subjectOf(pieces, /^(?:tar|zip|unzip|7z|Expand-Archive|Compress-Archive)$/i, false) };
      if (/\b(?:tasklist|taskkill|Get-Process|kill)\b/i.test(flat)) return { key: "process", hint: subjectOf(pieces, /^(?:tasklist|taskkill|Get-Process|kill)$/i, false) };
      if (/\bpython3?\b/i.test(flat)) return { key: "python", hint: base || subjectOf(pieces, /^python3?$/i, false) || "内联脚本" };
      if (/\b(?:node|\$NODE)\b/i.test(flat)) return { key: "node", hint: base || subjectOf(pieces, /^(?:node|\$NODE)$/i, false) || "内联脚本" };
      if (/\b(?:pwsh|powershell|bash|sh)\b/i.test(flat)) return { key: "script", hint: base || subjectOf(pieces, /^(?:pwsh|powershell|bash|sh)$/i, false) || "内联脚本" };
      if (/^\s*date\b/i.test(flat)) return { key: "clock", hint: "" };

      // 认不出来的命令：动词用命令名本身（比“执行命令”更具体），对象用参数。
      return {
        key: "run",
        hint: program === ""
          ? clipCommand(text)
          : `${program}${pieces.words[1] ? ` ${pieces.words[1]}` : ""}`.slice(0, RUN_HINT_LIMIT),
      };
    }

    /** 副标题只留能认出对象的那一小段：路径取末两段，其余截断。 */
    function shortDetail(text) {
      if (typeof text !== "string") return "";
      const trimmed = text.trim();
      if (trimmed === "") return "";
      if (/[\\/]/.test(trimmed) && /\.[A-Za-z0-9]{1,6}$/.test(trimmed)) {
        const parts = trimmed.split(/[\\/]+/).filter(Boolean);
        const tail = parts.slice(-2).join("/");
        return tail.length <= 48 ? tail : `${tail.slice(0, 45)}…`;
      }
      return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 45)}…`;
    }

    function clipCommand(text) {
      const flat = String(text).replace(/\s+/g, " ").trim();
      return flat.length <= RUN_HINT_LIMIT ? flat : flat.slice(0, RUN_HINT_LIMIT - 1) + "…";
    }

    /** 每次实际调用独立保留，不能凭简写后的标题把不同脚本合并。 */
    function mergeSameRuns(entries, t) {
      return entries.map((entry) => ({ repeat: 1, entry }));
    }

    /** 时间轨排序：正在跑的在最上，其余按完成时刻从新到旧。 */
    function byRecent(left, right) {
      const key = (row) => (row.entry.status === "running" ? Infinity : (row.entry.t1 || row.entry.at || row.entry.t0 || 0));
      return key(right) - key(left);
    }

    /**
     * 一轮的时间轨：工具动作（连做同一件事合并）加上这一轮的上下文维护操作。
     * @param {readonly object[]} evidence - 本轮非上下文维护的动作。
     * @param {readonly object[]} ops - 本轮的上下文维护操作（会话账里落在本轮的那几条）。
     */
    function turnFeed(evidence, ops, t) {
      const toolRows = mergeSameRuns(evidence, t).map((row) => ({ entry: row.entry, count: row.repeat }));
      const ctxRows = ops.map((op) => ({
        entry: {
          kind: "context", key: "ctx:" + op.id,
          status: op.status === "ok" ? "ok" : "error",
          acp: op.acp, range: op.range, saved: op.saved, block: op.block,
          at: op.at, ms: op.ms, error: op.error, detail: op.detail,
          t0: op.at && op.ms ? op.at - op.ms : op.at, t1: op.at,
        },
        count: 1,
      }));
      return toolRows.concat(ctxRows).sort(byRecent);
    }

    const SHELL_TOOLS = new Set(["ops_bash", "bash", "pwsh", "shell", "terminal", "run"]);

    /** 意图词：字典里找不到就退回“做一步”。 */
    function intentLabel(key, t) {
      const dictKey = `intent.${key}`;
      const translated = t(dictKey);
      return translated === dictKey ? t("intent.other") : translated;
    }

    /** 目标串看起来像不像一个文件路径（有分隔符、无空格、不是网址）。 */
    function looksLikePath(text) {
      return /[\\/]/.test(text) && !/\s/.test(text) && !/^[a-z]+:\/\//i.test(text);
    }

    /** 长路径只留最后两段，卡片里读作 “…/lib/client.js”。 */
    function shortPath(text) {
      const cleaned = text.replace(/^…/, "");
      const parts = cleaned.split(/[\\/]+/).filter((part) => part !== "");
      if (parts.length <= 2) return text;
      return "…/" + parts.slice(-2).join("/");
    }

    /** 条目该显示的目标：文件只留文件名，搜索词加引号，命令原样。 */
    function targetLabel(entry) {
      const text = typeof entry.target === "string" ? entry.target : "";
      if (text === "") return "";
      const kind = entry.kind ?? (looksLikePath(text) ? "path" : "other");
      if (kind === "path") return shortPath(text);
      if (kind === "query") return `“${text}”`;
      return text;
    }

    /**
     * 一条条目的“人话意图”：{ key, detail }。
     * key 决定动词（跑测试 / 改文件 / 搜代码…），detail 是具体对象。
     */
    /** 未知工具也要给人看得懂的名字：ops_read_files → read files。 */
    function prettyToolName(name) {
      const raw = String(name);
      const bare = raw.startsWith("mcp__") ? raw.split("__").slice(2).join("/") : raw;
      return bare.replace(/_/g, " ").trim() || bare;
    }

    function intentOf(entry, t) {
      const name = typeof entry.name === "string" ? entry.name : "";
      const lowered = name.toLowerCase();
      // 已发生的条目把“目标种类”放在 kind 上；排队中的调用放在 targetKind 上。
      const kind = entry.targetKind ?? (entry.kind === "call" ? undefined : entry.kind);
      const role = targetRoleOf(entry.target);
      const detail = role !== "" ? role : targetLabel({ target: entry.target, kind });
      if (SHELL_TOOLS.has(lowered)) {
        // 先给能看出差别的动作（跑测试 / 跑脚本 / 执行命令），宿主说明只进悬停与展开：
        // 一律用说明会让历史变成一屏相同的「执行命令」。
        const plan = commandPlan(typeof entry.target === "string" ? entry.target : "");
        return { key: plan.key, detail: plan.hint };
      }
      const known = INTENT_BY_TOOL[lowered];
      if (known !== undefined) return { key: known, detail };
      // ops_ 前缀的工具按去掉前缀后再认一次（ops_read_files → read_files）。
      if (lowered.startsWith("ops_")) {
        const stripped = INTENT_BY_TOOL[lowered.slice(4)];
        if (stripped !== undefined) return { key: stripped, detail };
      }
      if (lowered.startsWith("mcp__")) return { key: "external", detail: prettyToolName(name) };
      // 认不出来就老实写工具自己的名字，绝不写“做一步”。
      return { key: "other", detail: [detail, prettyToolName(name)].filter(Boolean).join(" · ") };
    }

    /**
     * 文件在项目里是干什么的。只认这个仓库里常见的几类动作对象，
     * 认不出就退回文件名——宁可留路径，也不猜一个假解释。
     * @type {Readonly<Record<string, string>>}
     */
    const FILE_ROLES = Object.freeze({
      "tests/client-render.test.mjs": "界面渲染测试",
      "tests/activity.test.mjs": "数据折叠测试",
      "tests/acp-shapes.test.mjs": "上下文维护测试",
      "tests/semantics.test.mjs": "决策意图测试",
      "tests/progress.test.mjs": "进度估算测试",
      "lib/client.js": "界面代码",
      "lib/activity.js": "数据代码",
      "lib/index.js": "插件入口",
      "scripts/check-manifest.mjs": "插件自检",
      "package.json": "插件清单",
      "package-lock.json": "依赖锁定",
      "CHANGELOG.md": "更新日志",
      "README.md": "说明文档",
      "README.zh.md": "中文说明",
      "NOTICE": "开源归属",
      "LICENSE": "许可证",
      "docs/STATS.md": "统计说明",
      "docs/HANDOFF.md": "交接文档",
      "docs/RELEASE.md": "发布清单",
    });

    /** 一条动作的对象该写什么：有角色写角色（悬停仍是原路径），否则留短路径。 */
    function targetRoleOf(target) {
      if (typeof target !== "string" || target === "") return "";
      const normalized = target.replace(/^(?:\.\.?[\\/])+/, "");
      const direct = FILE_ROLES[normalized];
      if (direct !== undefined) return direct;
      const file = normalized.split(/[\\/]/).pop();
      const byName = FILE_ROLES[file];
      if (byName !== undefined) return byName;
      return "";
    }

    /** 一条动作在卡片上的说法：动词（跑测试）+ 对象（package.json）。 */
    function actionOf(entry, t) {
      const intent = intentOf(entry, t);
      return { verb: intentLabel(intent.key, t), detail: shortDetail(intent.detail) };
    }

    /**
     * 同一件待办下连着的几次调用归成一组：组标题（那件待办）只出现一次，
     * 每行只写这一次具体做了什么。五个不同的调用于是是五行不同的动作，
     * 而不是五条一模一样的主标题。
     * @param {readonly object[]} entries - 按发生顺序排好的动作记录。
     * @returns {{ task: string, entries: object[] }[]} 连续的组。
     */
    function groupEntries(entries) {
      const groups = [];
      for (const entry of entries) {
        const task = typeof entry.task === "string" ? entry.task.trim() : "";
        const last = groups[groups.length - 1];
        if (last !== undefined && last.task === task) {
          last.entries.push(entry);
          continue;
        }
        groups.push({ task, entries: [entry] });
      }
      return groups;
    }

    // ── 图形 ────────────────────────────────────────────────────────────────

    function CheckGlyph() {
      return h("svg", {
        className: "dws-glyph", width: 11, height: 11, viewBox: "0 0 12 12",
        "aria-hidden": true, focusable: "false",
      }, h("path", {
        d: "M2.4 6.2 4.8 8.6 9.6 3.4", fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
      }));
    }

    function CrossGlyph() {
      return h("svg", {
        className: "dws-glyph", width: 11, height: 11, viewBox: "0 0 12 12",
        "aria-hidden": true, focusable: "false",
      }, h("path", {
        d: "M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8", fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round",
      }));
    }

    function SpinnerGlyph() {
      return h("svg", {
        className: "dws-glyph dws-glyph-spin", width: 11, height: 11, viewBox: "0 0 12 12",
        "aria-hidden": true, focusable: "false",
      }, h("circle", {
        cx: 6, cy: 6, r: 4.2, fill: "none", stroke: "currentColor", strokeWidth: 1.4,
        strokeLinecap: "round", strokeDasharray: "6 20",
      }));
    }

    function ChevronGlyph({ collapsed }) {
      return h("svg", {
        className: "dws-chevron-glyph", width: 12, height: 12, viewBox: "0 0 16 16",
        "aria-hidden": true, focusable: "false", style: { transform: collapsed ? "none" : "rotate(180deg)" },
      }, h("path", {
        d: "M4 6 8 10 12 6", fill: "none", stroke: "currentColor", strokeWidth: 1.5,
        strokeLinecap: "round", strokeLinejoin: "round",
      }));
    }

    // 视觉：一条和宿主输入框同宽的细边条，展开时只在条内向上长，不盖住输入框和消息。
    const STYLE_TEXT = `
.dsh-claude-deepy[data-dws-pet="running"], .dsh-claude-crab[data-dws-pet="running"] { filter: drop-shadow(0 0 2px var(--dsw-alias-brand-primary, #d97757)); }
.dws-root { display: flex; justify-content: flex-end; align-items: flex-end; position: relative; width: 100%; }
.dws-chip {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: 11.5px/1 inherit; cursor: pointer; white-space: nowrap;
  max-width: 220px;
}
.dws-chip:hover { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); }
.dws-chip[data-live="true"] { color: var(--dsw-alias-label-primary, #1f2329); }
.dws-chip[data-fail="true"] { border-color: var(--dsw-alias-danger, #dc2626); color: var(--dsw-alias-danger, #dc2626); }
.dws-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.dws-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dws-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: currentColor; }
.dws-chip[data-live="true"] .dws-dot { background: var(--dsw-alias-brand-primary, #3b82f6); animation: dws-breathe 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .dws-chip[data-live="true"] .dws-dot { animation: none; } }
@keyframes dws-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

.dws-panel {
  position: fixed; z-index: 60;
  display: flex; flex-direction: column;
  box-sizing: border-box; padding: 13px 14px 10px;
  max-height: min(70vh, 460px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3, #fff);
  box-shadow: 0 12px 32px -26px rgba(0,0,0,.5);
  color: var(--dsw-alias-label-primary, #1f2329);
  font: 12px/1.55 inherit;
  font-family: inherit;
  letter-spacing: normal;
  overflow: hidden;
}
.dws-panel > .dws-head, .dws-panel > .dws-foot { flex: none; }
.dws-body {
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  /* 滚动条位置常驻：展开后才出现滚动条会把右侧的时间、分割线整体往左挤。
     右内边距减去滚动条宽（thin = 10px），右沿仍与标题栏对齐。 */
  scrollbar-gutter: stable;
  margin: 0 -14px; padding: 0 4px 0 14px;
}
.dws-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dws-head-text { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dws-head-time { color: var(--dsw-alias-label-tertiary, #8b919a); font-size: 11px; flex: none; font-variant-numeric: tabular-nums; }
.dws-close {
  border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #8b919a);
  font: 13px/1 inherit; cursor: pointer; padding: 2px 3px; border-radius: 4px; flex: none;
}
.dws-close:hover { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.1)); color: var(--dsw-alias-label-primary, #1f2329); }
.dws-goal, .dws-stage-line { display: flex; gap: 6px; align-items: baseline; margin-top: 6px; min-width: 0; font-size: 11.5px; }
.dws-goal-label, .dws-stage-label { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-goal-text, .dws-stage-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-stage { margin: 8px 0 2px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dws-ctx { margin-top: 6px; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-top: 4px; }
.dws-ctx-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 2px 0 2px 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-ctx-label { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-ctx-effect { color: var(--dsw-alias-label-secondary, #4b5563); font-variant-numeric: tabular-nums; }
.dws-tag[data-kind="compressed"] { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-tag[data-kind="restored"] { color: var(--dsw-alias-good, #1a7f37); }
.dws-tag[data-kind="failed"] { color: var(--dsw-alias-bad, #b42318); }
.dws-ctx-range { font-variant-numeric: tabular-nums; }
.dws-progress { display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #4b5563); min-width: 0; }
.dws-progress-bar { height: 3px; opacity: .55; border-radius: 2px; overflow: hidden; }
.dws-progress-fill { display: block; height: 100%; background: currentColor; opacity: .55; }
.dws-progress[data-mode="estimated"] .dws-progress-fill { opacity: .35; }
.dws-progress[data-mode="unknown"] { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-progress-text { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.dws-sub { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11.5px; margin-top: 1px; }
.dws-plan { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11.5px; min-width: 0; }
.dws-plan-bar { position: relative; width: 46px; height: 2px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.2)); flex: none; overflow: hidden; }
.dws-plan-fill { position: absolute; inset: 0 auto 0 0; background: var(--dsw-alias-brand-primary, #3b82f6); }
.dws-plan-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dws-row { display: flex; align-items: center; gap: 6px; min-height: 20px; min-width: 0; color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-row[data-status="error"] { color: var(--dsw-alias-danger, #dc2626); }
.dws-row .verb { flex: none; }
.dws-row .target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #1f2329); }
.dws-row[data-status="error"] .target { color: inherit; }
.dws-row .spacer { flex: 1 1 auto; }
.dws-row .dur { flex: none; color: var(--dsw-alias-label-tertiary, #8b919a); font-size: 11px; font-variant-numeric: tabular-nums; }
.dws-tag { flex: none; font-size: 10.5px; padding: 0 4px; border-radius: 4px; color: var(--dsw-alias-label-tertiary, #8b919a); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.1)); }
.dws-tag[data-kind="recovered"] { color: var(--dsw-alias-success, #16a34a); }
.dws-tag[data-kind="pending"] { color: var(--dsw-alias-danger, #dc2626); background: transparent; border: 1px solid currentColor; }
.dws-err { margin: 1px 0 3px 15px; color: var(--dsw-alias-danger, #dc2626); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.dws-history {
  display: flex; align-items: center; gap: 4px; align-self: flex-end;
  margin: 2px 0 0 auto; padding: 2px 0; border: 0; background: none; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #8a919e);
  /* 简写里不能写 inherit，否则整条失效、按钮退回浏览器默认 13.3px；拆开写。 */
  font-family: inherit; font-size: 11px; line-height: 1.5;
}
.dws-history:hover { color: var(--dsw-alias-label-secondary, #5b6370); }
.dws-history:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; border-radius: 4px; }
.dws-foot { display: flex; align-items: center; gap: 10px; margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.dws-foot-spacer { flex: 1 1 auto; }
.dws-link { border: 0; background: transparent; padding: 0; color: var(--dsw-alias-label-secondary, #6b7280); font: 11.5px/1.4 inherit; cursor: pointer; }
.dws-link:hover { color: var(--dsw-alias-label-primary, #1f2329); text-decoration: underline; }

/* C′ 时间轨 */
.dws-title {
  font-family: var(--dsh-claude-font-serif, Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif);
  font-size: 14px; font-weight: 600; letter-spacing: -.005em;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dws-metrics {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  margin-top: 9px; padding-top: 7px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dws-metric { display: inline-flex; align-items: baseline; gap: 4px; }
.dws-metric-label { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-metric-value { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); font-variant-numeric: tabular-nums; }
.dws-metrics > * + * { margin-left: 0; }
.dws-metrics > .dws-metric + .dws-metric::before {
  content: "·"; color: var(--dsw-alias-label-tertiary, #8a8f98); opacity: .45; margin-right: 6px;
}
.dws-metrics .dws-ctx-head { flex: 1 0 100%; margin-top: 2px; }
.dws-metric-warn { color: var(--dsw-alias-danger, #c0392b); font-size: 10.5px; }
.dws-metrics .dws-ctx-head {
  width: auto; padding: 0; gap: 4px; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dws-metrics .dws-ctx-head:hover .dws-metric-label { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-rail { position: relative; margin: 8px 0 2px; }
.dws-rail::before {
  content: ""; position: absolute; left: 48.5px; top: 6px; bottom: 6px; width: 1px;
  background: var(--dsw-alias-border-l1, rgba(127,127,127,.45));
}
.dws-node { flex: none; width: 15px; display: inline-flex; align-items: center; justify-content: center; }
.dws-item .dws-row { gap: 7px; min-height: 21px; }
.dws-item[data-status="error"] .dws-row { color: var(--dsw-alias-danger, #c0392b); }
.dws-item[data-status="error"] .target { color: inherit; }
.dws-item[data-status="ok"] .verb { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-item[data-status="ok"] .target { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-item[data-status="ok"] .dws-node { opacity: .5; }
.dws-item[data-status="ok"] .dur, .dws-item[data-status="ok"] .dws-when { color: var(--dsw-alias-label-tertiary, #9aa0a8); }
.dws-item[data-status="running"] .verb { color: var(--dsw-alias-label-primary, #1f2329); }
/* 失败但后来同类操作成功：留着这行，划掉转灰，不再当成异常 */
.dws-item[data-settled="true"] .dws-row { cursor: default; }
.dws-item[data-settled="true"] .verb,
.dws-item[data-settled="true"] .target,
.dws-item[data-settled="true"] .dur {
  text-decoration: line-through;
  color: var(--dsw-alias-label-tertiary, #9aa0a8);
}
.dws-item[data-settled="true"] .dws-node { opacity: .4; }
.dws-ctx { border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }

/* C′ 定稿：固定宽、右下浮窗、圆环节点、行内展开 */
.dws-panel {
  position: absolute; right: 14px; bottom: calc(100% + 8px); left: auto; top: auto;
  width: 380px; max-width: calc(100vw - 48px);
  max-height: min(70vh, 640px);
  overscroll-behavior: contain;
  animation: dws-pop 160ms ease-out;
}
.dws-panel[data-closing="true"] { animation: dws-pop-out 120ms ease-in forwards; }
@keyframes dws-pop {
  from { opacity: 0; transform: translateY(6px) scale(.965); }
  to { opacity: 1; transform: none; }
}
@keyframes dws-pop-out {
  from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translateY(6px) scale(.965); }
}
@media (prefers-reduced-motion: reduce) {
  .dws-panel, .dws-panel[data-closing="true"] { animation: none; }
}
/* 和宿主一致的字体渲染：主窗口字缘更柔和，面板照抄 */
.dws-panel, .dws-chip { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
.dws-title { font-size: 15px; }
.dws-metrics { margin-top: 10px; font-size: 11.5px; gap: 5px 11px; }
.dws-metric-value { font-size: 12.5px; color: var(--dsw-alias-brand-primary, #d97757); font-weight: 600; }
.dws-metric-warn { font-size: 11px; }
.dws-rail { margin: 10px 0 2px; padding-left: 0; }
.dws-current-rail { min-height: 108px; }
.dws-rail::before {
  content: ""; position: absolute; left: 37.5px; top: 9px; bottom: 9px; width: 1px;
  background: var(--dsw-alias-border-l1, rgba(127,127,127,.45));
}
.dws-item[data-status="running"] .dws-node { background: var(--dsw-alias-bg-layer-3, #fff); border-radius: 50%; }
.dws-node {
  position: relative; z-index: 1; flex: none; display: block;
  width: 8px; height: 8px; margin: 0 9px 0 0;
  color: var(--dsw-alias-label-tertiary, #9aa0a8);
  overflow: visible;
}
.dws-node circle {
  fill: var(--dsw-alias-bg-layer-3, #fff);
  stroke: currentColor; stroke-width: 1.25;
}
.dws-item[data-status="ok"] .dws-node { color: var(--dsw-alias-label-tertiary, #9aa0a8); }
.dws-item[data-status="error"] .dws-node { color: var(--dsw-alias-bad, #c0392b); }
.dws-item[data-status="running"] .dws-node {
  color: var(--dsw-alias-brand-primary, #d97757);
  animation: dws-spin 1s linear infinite;
}
.dws-item[data-status="running"] .dws-node circle { stroke-dasharray: 13 8; }
.dws-item-now .verb { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; }
.dws-item-now .dws-row:hover { background: transparent; }
@keyframes dws-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dws-item[data-status="running"] .dws-node { animation: none; }
}
.dws-item .dws-row {
  gap: 0; min-height: 27px; width: 100%; padding: 0 2px;
  border: 0; background: transparent; text-align: left; font: inherit; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.dws-item .dws-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06)); border-radius: 5px; }
.dws-item .dws-row .verb { flex: none; font-size: 13px; font-weight: 500; letter-spacing: -.005em; }
.dws-item .dws-row .target {
  flex: 1 1 auto; min-width: 0; margin-left: 7px;
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dws-item .dws-row .dur { flex: none; margin-left: 10px; font-size: 11.5px; }
.dws-item[data-status="ok"] .verb { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-item[data-status="ok"] .target { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-item[data-status="error"] .verb, .dws-item[data-status="error"] .target { color: var(--dsw-alias-bad, #c0392b); }
.dws-item[data-status="running"] .verb { color: var(--dsw-alias-label-primary, #1f2329); }
.dws-item[data-status="running"] .target { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-err { margin: 1px 0 5px 20px; font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; color: var(--dsw-alias-bad, #c0392b); }
.dws-detail {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 10px; line-height: 14px;
  margin: 0 0 3px 20px; padding: 2px 8px;
  border-radius: 6px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07));
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-variant-numeric: tabular-nums;
}
.dws-detail > span { line-height: 14px; white-space: nowrap; }
.dws-panel .dws-detail { font-size: 10.5px; }
.dws-span-arrow { font-family: inherit; font-size: 10px; margin: 0 3px; }
.dws-log { padding: 2px 0 4px; }
.dws-log-sum { padding: 6px 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.dws-log-sum-main { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); font-variant-numeric: tabular-nums; }
.dws-log-sum-sub { display: flex; flex-wrap: wrap; gap: 0 4px; margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dws-log-row { padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.1)); }
.dws-log-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 12px; }
.dws-log-turn { flex: none; font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-log-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dws-log-dur { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dws-log-row[data-live="true"] .dws-log-meta, .dws-log-row[data-live="true"] .dws-log-dur { color: var(--dsw-alias-brand-primary, #d97757); }
.dws-log-sub { display: flex; gap: 8px; min-width: 0; margin-top: 1px; font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #9aa0a8); }
.dws-log-sum-sub > span { white-space: nowrap; }
.dws-log-sum-sub > span + span::before { content: "· "; }
.dws-log-split { flex: none; font-variant-numeric: tabular-nums; }
.dws-log-goal { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dws-log-note { padding-top: 6px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #9aa0a8); }
.dws-log-toggle[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #1f2329); }
.dws-prev-sep {
  display: flex; align-items: center; gap: 8px; margin: 9px 0 6px;
  font-size: 10.5px; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary, #9aa0a8);
}
.dws-prev-sep::before, .dws-prev-sep::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--dsw-alias-border-l1, rgba(127,127,127,.3)); }
.dws-prev {
  padding: 6px 10px 4px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07));
  color: var(--dsw-alias-label-tertiary, #9aa0a8);
}
.dws-panel .dws-prev .dws-item .verb, .dws-panel .dws-prev .dws-item .target, .dws-panel .dws-prev .dws-item .dur { color: var(--dsw-alias-label-tertiary, #9aa0a8); }
.dws-prev-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dws-prev-goal { display: flex; gap: 6px; margin-top: 3px; font-size: 11px; min-width: 0; }
.dws-prev-goal-label { flex: none; }
.dws-prev-goal-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #6b7280); }
.dws-prev-metrics { margin-top: 3px; font-size: 10.5px; font-variant-numeric: tabular-nums; }
/* 上一轮整体比本轮小一号：动作 12px、对象/用时 11px、头部 11px。 */
.dws-panel .dws-prev .dws-item .dws-row { min-height: 23px; }
.dws-panel .dws-prev .dws-item .dws-row .verb { font-size: 12px; }
.dws-panel .dws-prev .dws-item .dws-row .target { font-size: 11px; }
.dws-panel .dws-prev .dws-item .dws-row .dur { font-size: 10.5px; }
.dws-panel .dws-prev-head { font-size: 11px; gap: 6px; }
.dws-panel .dws-prev-head .dws-tag { flex: none; }
.dws-panel .dws-prev-meta { flex: 1 1 auto; }
.dws-prev-head {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 1px 0;
  border: 0; background: transparent; font: inherit; font-size: 11.5px; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dws-prev-head:hover { color: var(--dsw-alias-label-secondary, #4b5563); }
.dws-prev-label { flex: none; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280); }
.dws-prev-time { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
.dws-prev .dws-rail { margin-top: 6px; }
/* 只去掉时间轴的竖线，圆环、时间列、进度、历史都保留 */
.dws-rail::before { display: none; }
.dws-goal { align-items: flex-start; }
.dws-goal-body { flex: 1 1 auto; min-width: 0; }
.dws-goal-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: normal; overflow: hidden; }
.dws-goal-text[data-open="true"] { display: block; -webkit-line-clamp: unset; }
.dws-goal-toggle { display: block; border: 0; background: transparent; padding: 0; margin-top: 2px; font: inherit; font-size: 11px; cursor: pointer; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dws-goal-toggle:hover { color: var(--dsw-alias-label-secondary, #4b5563); text-decoration: underline; }

`;

    function installStyle(document) {
      const id = NS + ":styles";
      // 热加载后标签还在，但内容是旧版本的：就地换成本版样式，不必重启 DSH 才生效。
      const existing = document.getElementById(id);
      if (existing) {
        if (existing.textContent !== STYLE_TEXT) existing.textContent = STYLE_TEXT;
        return;
      }
      const style = document.createElement("style");
      style.id = id;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
    }

    /** Re-render once a second only while something is actually moving. */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [active]);
      return now;
    }

    function ActionRow({ entry, repeat, recovered, redeemed, t, now }) {
      const [rowOpen, setRowOpen] = React.useState(false);
      const isCtx = entry.kind === "context";
      // 失败被后来同一类操作接替：这一行仍然留着（看得见曾经出错），但划掉转灰，不再算异常。
      // 失败后同类操作成功了：不管工具调用还是上下文维护，都划掉转灰，不再当异常。
      const settled = entry.status === "error" && (recovered === true || (isCtx && redeemed === true));
      const action = isCtx ? null : actionOf(entry, t);
      const verb = isCtx ? t("ctx." + (entry.acp || "other")) : action.verb;
      const saved = isCtx && typeof entry.saved === "number" && entry.saved > 0 ? t("ctx.saved", { saved: tokenText(entry.saved) }) : "";
      const detail = isCtx
        ? [entry.range, saved].filter(Boolean).join(" · ")
        : action.detail;
      const durMs = entry.t0 && entry.t1 ? Math.max(0, entry.t1 - entry.t0) : 0;
      const state = entry.status === "error" ? "error" : entry.status === "running" ? "running" : "ok";
      const errText = settled
        ? ""
        : (!isCtx || entry.status !== "error"
          ? entry.err
          : (/anchored|DEAD|Range/i.test(String(entry.error || "")) ? t("ctx.fail.stale") : (entry.error || t("ctx.state.failed"))));
      return h("div", {
        className: "dws-item",
        "data-status": settled ? "ok" : state,
        "data-kind": isCtx ? "context" : "tool",
        "data-settled": settled ? "true" : undefined,
        title: settled ? t("row.settled") : undefined,
      },
        h("button", {
          type: "button",
          className: "dws-row",
          "data-open": String(rowOpen),
          title: entry.description || detail || undefined,
          onClick: () => setRowOpen((value) => !value),
        },
        h("svg", { className: "dws-node", width: 8, height: 8, viewBox: "0 0 8 8", "aria-hidden": "true" },
          h("circle", { cx: 4, cy: 4, r: 3.25, "vector-effect": "non-scaling-stroke" })),
        h("span", { className: "verb" }, verb),
        h("span", { className: "target" }, detail),
        repeat > 1 ? h("span", { className: "dws-tag", "data-kind": "repeat" }, "×" + repeat) : null,
        entry.status === "error" && !settled
          ? h("span", { className: "dws-tag", "data-kind": recovered ? "recovered" : "pending" }, recovered ? t("tag.recovered") : t("tag.pending"))
          : null,
        durMs > 0 ? h("span", { className: "dur" }, formatShort(durMs)) : null),
        state === "error" && errText ? h("div", { className: "dws-err" }, errText) : null,
        rowOpen
          ? h("div", { className: "dws-detail" },
            h("span", null, t(isCtx ? "row.kind.context" : "row.kind.tool")),
            !isCtx && entry.name ? h("span", null, entry.name) : null,
            !isCtx && entry.description ? h("span", null, entry.description) : null,
            entry.t0 && entry.t1 && entry.t1 >= entry.t0
              ? h("span", { className: "dws-span" }, formatClock(entry.t0), h("span", { className: "dws-span-arrow" }, "→"), formatClock(entry.t1))
              : entry.t0 ? h("span", null, t("row.start", { time: formatClock(entry.t0) })) : null,
            durMs > 0 ? h("span", null, t("row.took", { time: formatShort(durMs) })) : null,
            isCtx && entry.range ? h("span", null, entry.range) : null)
          : null);
    }

    /**
     * position: fixed 实际相对谁定位：最近一个建立包含块的祖先（transform、filter、
     * contain、container-type 等），没有就是视口。返回它内边距盒的右、下沿（视口坐标）。
     */
    function fixedFrameOf(node, view) {
      const root = node.ownerDocument ? node.ownerDocument.documentElement : null;
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        const cs = view.getComputedStyle ? view.getComputedStyle(el) : null;
        if (!cs) break;
        const set = (value) => typeof value === "string" && value !== "" && value !== "none" && value !== "normal";
        const contains = set(cs.transform) || set(cs.filter) || set(cs.perspective) || set(cs.backdropFilter)
          || /transform|filter|perspective/.test(cs.willChange || "")
          || /paint|layout|strict|content/.test(cs.contain || "")
          || set(cs.containerType);
        if (!contains) continue;
        const box = el.getBoundingClientRect();
        return {
          right: box.right - (parseFloat(cs.borderRightWidth) || 0),
          bottom: box.bottom - (parseFloat(cs.borderBottomWidth) || 0),
        };
      }
      return { right: view.innerWidth, bottom: view.innerHeight };
    }

    /** 最近一个纵向可滚动祖先（对话区）的顶边与内容右沿（视口坐标，不含滚动条）；没有就是 null。 */
    function scrollBoxOf(node, view) {
      for (let el = node ? node.parentElement : null; el; el = el.parentElement) {
        const cs = view.getComputedStyle ? view.getComputedStyle(el) : null;
        if (!cs || !/auto|scroll/.test(cs.overflowY || "")) continue;
        const box = el.getBoundingClientRect();
        return { top: Math.max(0, box.top), right: box.left + (el.clientWidth || box.width) };
      }
      return null;
    }

    /** 12:25:03（本地时区），只用于行展开后的“什么时候发生的”。 */
    function formatClock(ts) {
      if (typeof ts !== "number" || ts <= 0) return "";
      const date = new Date(ts);
      const pad = (value) => String(value).padStart(2, "0");
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /** 12345 → “12.3K”；数字来自事件原文，不做任何反推。 */
    function clipText(text, max) {
      const value = String(text || "");
      return value.length > max ? value.slice(0, max - 1) + "…" : value;
    }

    function tokenText(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
      if (value >= 1000000) return (value / 1000000).toFixed(1) + "M";
      if (value >= 10000) return Math.round(value / 1000) + "K";
      if (value >= 1000) return (value / 1000).toFixed(1) + "K";
      return String(value);
    }

    /**
     * 上下文维护的汇总量：次数、省下的 token（只加“事件里写了数字”的那些）、
     * 仍保持压缩的块数。官方统计在场时用它，缺席时用事件推得的块数。
     */
    function contextDigest(activity) {
      const acp = activity && activity.acp && typeof activity.acp === "object" ? activity.acp : { blocks: {}, status: null, ops: [] };
      const ops = Array.isArray(acp.ops) ? acp.ops : [];
      const blocks = acp.blocks && typeof acp.blocks === "object" ? acp.blocks : {};
      const compressions = ops.filter((op) => op.acp === "compress");
      const savedOps = compressions.filter((op) => typeof op.saved === "number" && op.saved > 0);
      const savedTotal = savedOps.reduce((sum, op) => sum + op.saved, 0);
      const ids = Object.keys(blocks);
      const restoredIds = ids.filter((id) => blocks[id] && blocks[id].restoredAt > 0);
      const active = acp.status && typeof acp.status.active === "number"
        ? acp.status.active
        : Math.max(0, ids.length - restoredIds.length);
      return {
        ops,
        blocks,
        ids,
        restoredIds,
        compressions: compressions.length,
        restores: ops.filter((op) => op.acp === "decompress" && op.status === "ok").length,
        savedTotal,
        savedKnown: savedOps.length,
        failed: ops.filter((op) => op.status === "failed").length,
        active,
        status: acp.status,
      };
    }

    /**
     * 一条上下文维护操作怎么说：动作 + 范围 + 效果 + 状态。
     * 效果只来自事件原文：compress 写着“~N tokens saved”才说省了多少。
     */
    function contextOpRow(op, t) {
      const effect = (() => {
        if (op.status === "failed") {
          const firstLine = (op.error || "").split("\n").find((line) => line.trim() !== "") || "";
          const raw = firstLine.replace(/^Error:\s*\[?/, "");
          // 常见的“范围已失效”是工具在动手前就拒了：这次没压进任何内容，原消息原样留着。
          if (/cannot be anchored|DEAD|unknown ranges/i.test(firstLine)) return t("ctx.fail.stale");
          return clipText(raw, 64);
        }
        if (op.acp === "compress") {
          return typeof op.saved === "number" && op.saved > 0
            ? t("ctx.effect.saved", { saved: tokenText(op.saved) })
            : t("ctx.effect.compressed");
        }
        if (op.acp === "decompress") {
          if (op.block !== "") return t("ctx.effect.restored", { block: op.block });
          return op.reason === "回执未匹配" ? t("ctx.effect.unknown") : t("ctx.effect.restored.bare");
        }
        return "";
      })();
      const stateKey = op.status === "failed"
        ? "failed"
        : op.acp === "compress"
          ? (typeof op.saved === "number" ? "compressed" : "unknown")
          : op.acp === "decompress"
            ? (op.block === "" ? "unknown" : "restored")
            : op.acp === "acp_status" ? "reported" : "searched";
      // 可核对：悬停给出这次调用的参数、回执原文与解析失败原因（都来自事件本身）。
      const provenance = [op.args, op.detail, op.error, op.reason].filter((part) => typeof part === "string" && part !== "").join(" / ");
      return h("div", { className: "dws-ctx-row", key: "ctx:" + op.id, "data-status": op.status, title: provenance === "" ? undefined : provenance },
        h("span", { className: "dws-ctx-label" }, t("ctx." + (op.acp || "other"))),
        op.range ? h("span", { className: "dws-ctx-range" }, op.range) : null,
        effect ? h("span", { className: "dws-ctx-effect" }, effect) : null,
        h("span", { className: "spacer" }),
        stateKey === "compressed" ? null : h("span", { className: "dws-tag", "data-kind": stateKey }, t("ctx.state." + stateKey)),
        op.ms > 0 ? h("span", { className: "dur" }, formatShort(op.ms)) : null);
    }

    /**
     * 进度行：有真实 todo 就报完成比例；没有就给“当前这一步”的同类参照。
     * 超出同类 75 分位只说事实（比 75% 的步更久），不预测还要多久。
     */
    function ProgressRow({ estimate, t }) {
      if (!estimate || estimate.wall < 1500) return null;
      const step = estimate.step || { sig: "", elapsed: 0, modelMs: 0, toolMs: 0, model: { ready: false }, tools: [] };
      // 进行中的一步已经在时间轴上有一行，这里不再单独复述一行。
      if (estimate.mode === "step") return null;
      const bar = estimate.mode === "determined"
        ? h("span", { className: "dws-progress-bar", "aria-hidden": "true" },
          h("span", { className: "dws-progress-fill", style: { width: estimate.percent + "%" } }))
        : null;
      let text;
      if (estimate.mode === "determined") {
        text = t("mode.determined", { done: estimate.done, total: estimate.total, percent: estimate.percent });
      } else if (step.elapsed >= 1000) {
        text = t("step.bare", { elapsed: formatShort(step.elapsed) });
      } else {
        text = t("mode.unknown", { time: formatShort(estimate.wall) });
      }
      return h("div", { className: "dws-progress", "data-mode": estimate.mode },
        bar,
        h("span", { className: "dws-progress-text" }, text));
    }

    function PlanLine({ done, total, current, t }) {
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      return h("div", { className: "dws-plan" },
        h("span", { className: "dws-plan-bar" },
          h("span", { className: "dws-plan-fill", style: { width: percent + "%" } })),
        h("span", { className: "dws-plan-text" },
          t("plan.progress", { done, total }) + (current ? " · " + current : "")));
    }

    // 宿主热更新会重新挂载组件：只让最近挂载的那一份显示，旧实例自动让位。
    const instanceRegistry = (() => {
      const existing = globalThis.__dwsInstanceRegistry;
      if (existing && existing.listeners instanceof Set) return existing;
      const registry = { current: null, listeners: new Set() };
      registry.notify = () => registry.listeners.forEach((listener) => { try { listener(); } catch (error) { /* 单个订阅出错不影响其他实例 */ } });
      registry.claim = (id) => { registry.current = id; registry.notify(); };
      registry.release = (id) => { if (registry.current !== id) return; registry.current = null; registry.notify(); };
      globalThis.__dwsInstanceRegistry = registry;
      return registry;
    })();

    /** 日志里每一轮的状态词：只有中断或出错才写，正常结束不写。 */
    function endWord(phase, t) {
      if (phase === "aborted") return t("log.aborted");
      if (phase === "error") return t("log.error");
      return "";
    }

    /** 会话日志的数据：总计 + 逐轮（新的在前）。渲染和复制共用，口径一致。 */
    function sessionLog(activity) {
      const totals = activity && activity.totals && typeof activity.totals === "object" ? activity.totals : null;
      const history = activity && Array.isArray(activity.history) ? activity.history : [];
      const turns = history.filter((row) => row && typeof row.turn === "number").slice().reverse();
      return { totals, turns };
    }

    function totalTime(totals, t) {
      return t("log.time", { model: formatShort(totals.modelMs || 0), tool: formatShort(totals.toolMs || 0), wall: formatShort(totals.wallMs || 0) });
    }

    function turnSpan(row) {
      return row.startedAt > 0 && row.endedAt > 0 ? formatMinute(row.startedAt) + " → " + formatMinute(row.endedAt) : "";
    }

    /** 复制用的纯文本，一轮一行。 */
    function logText(activity, t) {
      const { totals, turns } = sessionLog(activity);
      const lines = [t("log.title")];
      if (totals) {
        lines.push(t("log.sum", { turns: totals.turns, rounds: totals.rounds || 0, ops: totals.ops }));
        lines.push(totalTime(totals, t)
          + (totals.ctx > 0 ? " · " + t("log.ctx", { n: totals.ctx }) : "")
          + (totals.ctxFailed > 0 ? "（" + t("log.ctxFail", { n: totals.ctxFailed }) + "）" : ""));
      }
      for (const row of turns) {
        lines.push([
          t("log.turn", { turn: row.turn }),
          turnSpan(row),
          formatShort(row.wallMs || 0),
          t("log.row", { rounds: row.rounds || 0, ops: row.ops || 0 }),
          t("log.split", { model: formatShort(row.modelMs || 0), tool: formatShort(row.toolMs || 0) }),
          row.ctx > 0 ? t("log.ctx", { n: row.ctx }) : "",
          row.errors > 0 ? t("log.fail", { n: row.errors }) : "",
          endWord(row.phase, t),
          row.prompt || "",
        ].filter(Boolean).join(" · "));
      }
      return lines.join("\n");
    }

    /** 日志视图：会话总计在上，逐轮记录（新的在前）在下；进行中的这一轮单列一行。 */
    function LogView({ activity, live, now, t }) {
      const { totals, turns } = sessionLog(activity);
      const current = live && activity && activity.turn > 0
        ? h("div", { className: "dws-log-row", "data-live": "true" },
          h("div", { className: "dws-log-line" },
            h("span", { className: "dws-log-turn" }, t("log.turn", { turn: activity.turn })),
            h("span", { className: "dws-log-meta" }, t("log.live")),
            h("span", { className: "dws-log-dur" }, formatShort(Math.max(0, now - (activity.startedAt || now))))))
        : null;
      return h("div", { className: "dws-log" },
        h("div", { className: "dws-log-sum" },
          totals && totals.turns > 0
            ? h(React.Fragment, null,
              h("div", { className: "dws-log-sum-main" }, t("log.sum", { turns: totals.turns, rounds: totals.rounds || 0, ops: totals.ops })),
              // 每组整体换行，不把“失败 1”拆成两行。
              h("div", { className: "dws-log-sum-sub" },
                h("span", null, t("log.split", { model: formatShort(totals.modelMs || 0), tool: formatShort(totals.toolMs || 0) })),
                h("span", null, t("log.total", { wall: formatShort(totals.wallMs || 0) })),
                totals.ctx > 0
                  ? h("span", null, t("log.ctx", { n: totals.ctx }),
                    totals.ctxFailed > 0 ? h("span", { className: "dws-metric-warn" }, " " + t("log.ctxFail", { n: totals.ctxFailed })) : null)
                  : null))
            : h("div", { className: "dws-sub" }, t("log.empty"))),
        current,
        turns.map((row) => h("div", { className: "dws-log-row", key: "log:" + row.turn + ":" + (row.endedAt || 0) },
          h("div", { className: "dws-log-line" },
            h("span", { className: "dws-log-turn" }, t("log.turn", { turn: row.turn })),
            h("span", { className: "dws-log-meta" },
              [turnSpan(row), t("log.row", { rounds: row.rounds || 0, ops: row.ops || 0 })].filter(Boolean).join(" · ")),
            row.errors > 0 ? h("span", { className: "dws-tag", "data-kind": "pending" }, t("log.fail", { n: row.errors })) : null,
            endWord(row.phase, t) ? h("span", { className: "dws-tag", "data-kind": "pending" }, endWord(row.phase, t)) : null,
            h("span", { className: "dws-log-dur" }, formatShort(row.wallMs || 0))),
          h("div", { className: "dws-log-sub" },
            h("span", { className: "dws-log-split" },
              t("log.split", { model: formatShort(row.modelMs || 0), tool: formatShort(row.toolMs || 0) })
              + (row.ctx > 0 ? " · " + t("log.ctx", { n: row.ctx }) : "")),
            row.prompt ? h("span", { className: "dws-log-goal", title: row.prompt }, row.prompt) : null))),
        turns.length > 0 ? h("div", { className: "dws-log-note" }, t("log.recent", { n: LOG_TURNS })) : null);
    }

    /** 14:05（本地时区），上一轮的起止只要到分钟。 */
    function formatMinute(ts) {
      return formatClock(ts).slice(0, 5);
    }

    /**
     * 上一轮：整块换底色、字色调淡，标题写明是第几轮、几点到几点、当时的目标；
     * 展开后是那一轮自己的时间轨（工具动作 + 那一轮的上下文维护）。
     */
    function PrevTurn({ prev, open, onToggle, t, now }) {
      const prevItems = Array.isArray(prev.items) ? prev.items : [];
      const feed = Array.isArray(prev.ctx)
        ? turnFeed(prevItems.filter((item) => item.kind !== "context"), prev.ctx, t)
        : turnFeed(prevItems, [], t);
      const span = prev.startedAt > 0 && prev.endedAt > 0
        ? t("row.span", { from: formatMinute(prev.startedAt), to: formatMinute(prev.endedAt) })
        : "";
      const meta = [span, t("prev.steps", { steps: prev.steps })].filter(Boolean).join(" · ");
      const goal = typeof prev.prompt === "string" ? prev.prompt : "";
      const timed = (prev.modelMs || 0) > 0 || (prev.toolMs || 0) > 0;
      return h(React.Fragment, null,
        h("div", { className: "dws-prev-sep", role: "separator" }, t("prev.sep")),
        h("div", { className: "dws-prev", "data-open": String(open) },
        h("button", { type: "button", className: "dws-prev-head", "aria-expanded": open, onClick: onToggle },
          h("span", { className: "dws-prev-label" }, t("prev.label", { turn: prev.turn })),
          h("span", { className: "dws-prev-meta" }, meta),
          prev.errors > 0 ? h("span", { className: "dws-tag", "data-kind": "pending" }, t("prev.fail", { n: prev.errors })) : null,
          h("span", { className: "dws-prev-time" }, formatShort(Math.max(0, prev.endedAt - prev.startedAt))),
          h(ChevronGlyph, { collapsed: !open })),
        goal !== ""
          ? h("div", { className: "dws-prev-goal", title: goal },
            h("span", { className: "dws-prev-goal-label" }, t("prev.goal")),
            h("span", { className: "dws-prev-goal-text" }, goal))
          : null,
        open && timed
          ? h("div", { className: "dws-prev-metrics" }, t("prev.metrics", { model: formatShort(prev.modelMs || 0), tool: formatShort(prev.toolMs || 0) }))
          : null,
        open
          ? h("div", { className: "dws-rail" },
            feed.slice(0, 12).map((row, index) => h(ActionRow, {
              key: "prev:" + index + ":" + (row.entry.key || row.entry.id || index),
              entry: row.entry, repeat: row.count,
              recovered: row.entry.status !== "error",
              t, now: prev.endedAt || now,
            })))
          : null));
    }

    /**
     * 会话标题栏上的工作状态徽标 + 下拉面板。
     * 层级：徽标（一行）→ 面板（当前动作/计划/最近/异常）→ 完整记录（原始流水）。
     */
    function ActivityBadge({ useProjection, t = fallbackT }) {
      const read = typeof useProjection === "function" ? useProjection : () => undefined;
      const activity = read("workStatus");
      const todos = read("todos");

      const phase = activity && typeof activity.phase === "string" ? activity.phase : "idle";
      const live = LIVE_PHASES.has(phase);
      const finished = FINISHED_PHASES.has(phase);
      const turn = activity && typeof activity.turn === "number" ? activity.turn : 0;
      const visible = turn > 0 && (live || finished);

      const now = useNow(visible && live);
      const [open, setOpen] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);
      const [goalOpen, setGoalOpen] = React.useState(false);
      const [prevOpen, setPrevOpen] = React.useState(false);
      const [logOpen, setLogOpen] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [dismissedTurn, setDismissedTurn] = React.useState(0);
      const chipRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const petRef = React.useRef(null);
      const [petFound, setPetFound] = React.useState(false);

      // 桌宠联动：主题插件把吉祥物画在输入框上沿，找到它就接管入口。
      React.useEffect(() => {
        const doc = (rootRef.current && rootRef.current.ownerDocument) || (typeof document !== "undefined" ? document : null);
        const view = doc && doc.defaultView;
        if (!doc || !view || typeof view.MutationObserver !== "function") return undefined;
        const find = () => doc.querySelector(".dsh-claude-deepy, .dsh-claude-crab");
        const sync = () => {
          const next = find();
          if (next !== petRef.current) {
            const previous = petRef.current;
            if (previous) {
              previous.style.pointerEvents = "";
              previous.style.cursor = "";
              previous.removeAttribute("title");
            }
            petRef.current = next;
            if (next) {
              // 主题默认把吉祥物设成 pointer-events:none，这里把它变成可点
              next.style.pointerEvents = "auto";
              next.style.cursor = "pointer";
              next.setAttribute("title", t("petHint"));
            }
            setPetFound(Boolean(next));
          }
        };
        sync();
        const mo = new view.MutationObserver(sync);
        mo.observe(doc.body, { childList: true, subtree: true });
        return () => {
          mo.disconnect();
          const pet = petRef.current;
          if (pet) {
            pet.style.pointerEvents = "";
            pet.style.cursor = "";
            pet.removeAttribute("title");
          }
        };
      }, []);

      // 桌宠就是入口：右键开关。监听常驻（不受面板开合影响），元素被主题重绘也不会丢。
      React.useEffect(() => {
        const doc = (rootRef.current && rootRef.current.ownerDocument) || (typeof document !== "undefined" ? document : null);
        if (!doc || typeof doc.addEventListener !== "function") return undefined;
        const onMenu = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== "function") return;
          const pet = target.closest(".dsh-claude-deepy, .dsh-claude-crab");
          if (!pet) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        };
        doc.addEventListener("contextmenu", onMenu, true);
        return () => doc.removeEventListener("contextmenu", onMenu, true);
      }, []);

      // 状态直接映在桌宠上：运行中一圈主题色光
      React.useEffect(() => {
        const pet = petRef.current;
        if (!pet) return;
        pet.setAttribute("data-dws-pet", live ? "running" : "idle");
      }, [petFound, live]);

      // 单实例闸门：热更新留下的旧实例一律不渲染。
      const instanceRef = React.useRef("");
      if (!instanceRef.current) instanceRef.current = "dws-" + Math.random().toString(36).slice(2, 10);
      const [isActive, setIsActive] = React.useState(true);
      React.useEffect(() => {
        const id = instanceRef.current;
        let mounted = true;
        const listener = () => { if (mounted) setIsActive(instanceRegistry.current === id); };
        instanceRegistry.listeners.add(listener);
        instanceRegistry.claim(id);
        return () => {
          mounted = false;
          instanceRegistry.listeners.delete(listener);
          instanceRegistry.release(id);
        };
      }, []);

      // 换轮或本轮结束时收起，不留悬空浮层。
      React.useEffect(() => { setOpen(false); setExpanded(false); setPrevOpen(false); }, [turn]);
      React.useEffect(() => { if (finished) setExpanded(false); }, [finished]);
      React.useEffect(() => { if (!open) { setExpanded(false); setLogOpen(false); setCopied(false); } }, [open]);

      // 桌宠模式下不渲染徽标，chipRef 为空；文档要从自己任何一个已挂载的节点取。
      const ownDocument = () => {
        const node = rootRef.current || panelRef.current || chipRef.current;
        if (node && node.ownerDocument) return node.ownerDocument;
        return typeof document === "undefined" ? null : document;
      };

      (React.useLayoutEffect || React.useEffect)(() => {
        if (!open) return undefined;
        const doc = ownDocument();
        const view = doc && doc.defaultView;
        const fit = () => {
          const panel = panelRef.current;
          const anchor = petRef.current || rootRef.current;
          if (!panel || !anchor || !view) return;
          const rect = anchor.getBoundingClientRect();
          // 目标位置按视口算：右沿贴对话区右边缘内 8px（不压在对话正中），底沿在锚点上方 8px。
          // 祖先带 transform 等属性时 fixed 会改为相对那个祖先定位，这里换算到它的坐标系。
          const frame = fixedFrameOf(panel, view);
          const scroller = scrollBoxOf(rootRef.current, view);
          // 右侧要让开对话区那条细滚动条：无论锚点在哪儿，右沿都不越过窗口右侧 30px。
          // 找到滚动容器时再按它的内容右沿收 12px（clientWidth 本身已排除滚动条宽度）。
          const limit = view.innerWidth - 30;
          const edgeRight = Math.min(scroller ? scroller.right - 12 : rect.right - 12, limit);
          const edgeBottom = rect.top - 8;
          panel.style.position = "fixed";
          panel.style.left = "auto";
          panel.style.top = "auto";
          panel.style.right = Math.round(frame.right - edgeRight) + "px";
          panel.style.bottom = Math.round(frame.bottom - edgeBottom) + "px";
          // 只限制可用空间，短内容由 flex 自然撑高。不要把动画缩放后的 rect
          // 与未缩放的 scrollHeight 混算，否则刚打开时上限偏小，滚动条闪现。
          // 上限是锚点上方、对话滚动区顶边以下的高度：滚动区上面是会话标题栏，
          // 输入框所在层级低于它，面板伸进去就会被盖住。
          const ceiling = (scroller ? scroller.top : 0) + 8;
          const room = Math.max(48, Math.floor(edgeBottom - ceiling));
          const value = room + "px";
          if (panel.style.maxHeight !== value) panel.style.maxHeight = value;
        };
        // 面板自己滚动时不用重新定位（它不影响锚点）；只跟着外面的滚动走。
        const onScroll = (event) => {
          const panel = panelRef.current;
          if (panel && event && event.target && typeof panel.contains === "function" && panel.contains(event.target)) return;
          fit();
        };
        fit();
        if (view) {
          view.addEventListener("resize", fit);
          view.addEventListener("scroll", onScroll, true);
        }
        const timer = view && view.setInterval ? view.setInterval(fit, 350) : null;
        const RO = view && view.ResizeObserver;
        const ro = RO && rootRef.current ? new RO(fit) : null;
        if (ro && rootRef.current) {
          ro.observe(rootRef.current);
          if (rootRef.current.parentElement) ro.observe(rootRef.current.parentElement);
        }
        return () => {
          if (timer) view.clearInterval(timer);
          if (view) {
            view.removeEventListener("resize", fit);
            view.removeEventListener("scroll", onScroll, true);
          }
          if (ro) ro.disconnect();
        };
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const doc = ownDocument();
        const view = doc && doc.defaultView;
        if (!view) return undefined;
        const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
        view.addEventListener("keydown", onKey);
        return () => view.removeEventListener("keydown", onKey);
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const doc = ownDocument();
        if (!doc) return undefined;
        const inComposer = (node) => {
          if (!node || typeof node.closest !== "function") return false;
          return Boolean(node.closest('textarea, input, [contenteditable="true"], [role="textbox"]'));
        };
        const onDown = (event) => {
          const target = event.target;
          if (panelRef.current && panelRef.current.contains(target)) return;
          if (chipRef.current && chipRef.current.contains(target)) return;
          if (inComposer(target)) return;
          setOpen(false);
        };
        doc.addEventListener("mousedown", onDown, true);
        return () => doc.removeEventListener("mousedown", onDown, true);
      }, [open]);

      if (!isActive) return null;
      if (!visible || (dismissedTurn !== 0 && dismissedTurn === turn)) return null;

      const items = activity && Array.isArray(activity.items) ? activity.items : [];
      // 失败后重试成功的上下文维护：按发生顺序找“后面有没有同类成功”，有就划掉前面那次。
      const evidence = items.filter((item) => item.kind !== "context");
      const contextOps = items.filter((item) => item.kind === "context");
      const rows = mergeSameRuns(evidence, t);
      const running = rows.filter((row) => row.entry.status === "running");
      const current = running.length > 0 ? running[running.length - 1].entry : null;
      const last = rows.length > 0 ? rows[rows.length - 1].entry : null;
      const focus = current || last;
      const focusAction = focus ? actionOf(focus, t) : null;

      // 失败项：同一目标之后有成功，就算已恢复。上下文维护单独记账，不混进任务失败。
      const errors = items.filter((item) => item.status === "error" && item.kind !== "context");
      const successKeys = new Set();
      for (const item of items) if (item.status !== "error") successKeys.add(item.key);
      const pendingFails = errors.filter((item) => !successKeys.has(item.key));

      // 已结束的轮次用结束时刻：面板打开时的 now 可能是很久以后，会把时长算得离谱。
      const endedAt = activity && activity.endedAt > 0 ? activity.endedAt : 0;
      const elapsed = activity && activity.startedAt
        ? Math.max(0, (!live && endedAt >= activity.startedAt ? endedAt : now) - activity.startedAt)
        : 0;
      // 简单对话：一轮结束、从头到尾没调用任何工具，就是“直接回答”。
      const direct = !live && items.length === 0;
      const counts = activity && activity.counts ? activity.counts : {};
      const stepsDone = typeof counts.steps === "number" ? counts.steps : 0;
      const opsDone = typeof counts.ops === "number" ? counts.ops : 0;
      // 上下文维护的账是会话级的：只取完成时刻落在本轮之内的那几条，旧轮的随“上一轮”折叠。
      const turnStart = activity && activity.startedAt > 0 ? activity.startedAt : 0;
      const ctxOps = (activity && activity.acp && Array.isArray(activity.acp.ops) ? activity.acp.ops : [])
        .filter((op) => typeof op.at === "number" && op.at >= turnStart);
      // 失败后同类操作成功了：前面那次失败划掉转灰，不再算异常。
      const redeemedCtx = new Set();
      {
        const ordered = [...ctxOps].sort((left, right) => (left.at || 0) - (right.at || 0));
        const okAfter = new Set();
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
          const op = ordered[index];
          if (op.status === "ok" && op.acp) okAfter.add(op.acp);
          if (op.status === "error" && op.acp && okAfter.has(op.acp)) redeemedCtx.add("ctx:" + op.id);
        }
      }
      const ctxDone = ctxOps.length;
      const plan = todoProgress(todos) || { done: 0, total: 0, next: "" };
      const estimate = estimateProgress(activity, todos, now);
      const goal = activity && typeof activity.prompt === "string" ? activity.prompt : "";
      const prevTurn = activity && activity.prev && typeof activity.prev.turn === "number" && activity.prev.turn !== turn
        ? activity.prev
        : null;
      const stageLabel = activity && activity.stage && typeof activity.stage.label === "string" ? activity.stage.label : "";

      const chipText = live
        ? (focusAction ? focusAction.verb + " " + focusAction.detail : formatShort(elapsed))
        : direct ? t("chip.direct") : t("head.done", { steps: stepsDone });
      const chipLabel = live
        ? t("chip.live", { action: chipText, time: formatShort(elapsed) })
        : chipText + (pendingFails.length > 0 ? "，" + t("fail.pending", { n: pendingFails.length }) : "");

      const chip = h("button", {
        type: "button",
        ref: chipRef,
        className: "dws-chip",
        "data-live": String(live),
        "data-fail": String(pendingFails.length > 0),
        "aria-expanded": open,
        "aria-label": chipLabel,
        title: chipLabel,
        onClick: () => setOpen((value) => !value),
      },
      h("span", { className: "dws-dot" }),
      h("span", { className: "dws-chip-text" }, live ? (focusAction ? focusAction.verb + " " : "") + formatShort(elapsed) : direct ? t("chip.direct") : t("chip.steps", { steps: stepsDone })),
      pendingFails.length > 0 ? h("span", { className: "dws-chip-text" }, "· " + t("chip.fail", { n: pendingFails.length })) : null);

      if (!open) return h("div", { className: "dws-root", ref: rootRef }, petFound ? null : chip);

      // C′：时间轨。最新在上，更早的收进“本轮历史”。正在跑的上下文维护也算进行中。
      const runningCtx = contextOps.filter((item) => item.status === "running").map((item) => ({ entry: item, count: 1 }));
      const feed = turnFeed(evidence, ctxOps, t).concat(runningCtx).sort(byRecent);
      const hasRunningRow = feed.some((row) => row.entry.status === "running");
      // 思考/写回答也是一条：切到工具执行时总行数不变，避免底部锚定的面板跳高。
      const visibleFeedCount = TOP_EVENTS - (live && !hasRunningRow ? 1 : 0);
      const headRows = feed.slice(0, visibleFeedCount);
      const restRows = feed.slice(visibleFeedCount);
      // 没有工具在跑时，这一行只写模型在做什么（思考 / 写回答），不借用上一个已完成的动作。
      const stepAt = activity && activity.stepStartAt > 0 ? activity.stepStartAt : 0;
      const toolOpen = activity && activity.toolOpen > 0;
      const liveVerb = phase === "writing" ? t("now.write") : (toolOpen && !hasRunningRow ? t("now.tool") : t("now.think"));
      const liveRow = live && !hasRunningRow
        ? h("div", { className: "dws-item dws-item-now", "data-status": "running" },
          h("div", { className: "dws-row", style: { cursor: "default" } },
            h("svg", { className: "dws-node", width: 8, height: 8, viewBox: "0 0 8 8", "aria-hidden": "true" },
              h("circle", { cx: 4, cy: 4, r: 3.25, "vector-effect": "non-scaling-stroke" })),
            h("span", { className: "verb" }, liveVerb),
            h("span", { className: "target" }, ""),
            h("span", { className: "dur", style: { color: "var(--dsw-alias-brand-primary, #d97757)", fontWeight: 600 } }, formatShort(stepAt > 0 ? Math.max(0, now - stepAt) : elapsed))))
        : null;

      const feedNodes = (list, prefix) => list.map((row, index) => h(ActionRow, {
        entry: row.entry, repeat: row.count, now,
        recovered: successKeys.has(row.entry.key) || row.entry.status !== "error",
        redeemed: redeemedCtx.has(row.entry.key),
        t, key: prefix + index + ":" + row.entry.key,
      }));

      const ctxSaved = ctxOps.reduce((sum, op) => sum + (typeof op.saved === "number" ? op.saved : 0), 0);
      const ctxFails = ctxOps.filter((op) => op.status !== "ok").length;
      // 模型推理：每步从开始到模型输出完成；本步还没输出完就把进行中的这段加上。
      const modelLive = live && activity && !activity.stepModelDone && stepAt > 0 ? Math.max(0, now - stepAt) : 0;
      const modelMs = (activity && typeof activity.modelMs === "number" ? activity.modelMs : 0) + modelLive;
      // 工具调用：本轮所有调用（含上下文维护）占用时间的并集，正在跑的算到此刻。
      const toolMs = activity && typeof activity.toolMs === "number"
        ? activity.toolMs + (live && activity.toolOpen > 0 && activity.toolSince > 0 ? Math.max(0, now - activity.toolSince) : 0)
        : items.reduce((sum, item) => sum + (item.t0 && item.t1 ? Math.max(0, item.t1 - item.t0) : 0), 0);
      const metrics = h("div", { className: "dws-metrics" },
        h("span", { className: "dws-metric" },
          h("span", { className: "dws-metric-label" }, t("metric.model")),
          h("b", { className: "dws-metric-value" }, modelMs > 0 ? formatShort(modelMs) : "—")),
        direct ? null : h("span", { className: "dws-metric" },
          h("span", { className: "dws-metric-label" }, t("metric.tool")),
          h("b", { className: "dws-metric-value" }, formatShort(toolMs))),
        ctxDone > 0
          ? h("span", { className: "dws-metric", title: t("metric.ctxTitle", { saved: formatTokens(ctxSaved) }) },
            h("span", { className: "dws-metric-label" }, t("metric.ctx")),
            h("b", { className: "dws-metric-value" }, t("metric.ctxTimes", { n: ctxDone })),
            ctxFails > 0 ? h("span", { className: "dws-metric-warn" }, t("metric.ctxFail", { n: ctxFails })) : null)
          : null);

      const copyLog = () => {
        const doc = ownDocument();
        const board = doc && doc.defaultView && doc.defaultView.navigator ? doc.defaultView.navigator.clipboard : null;
        if (!board || typeof board.writeText !== "function") return;
        board.writeText(logText(activity, t)).then(() => setCopied(true), () => setCopied(false));
      };

      const panel = h("div", {
        className: "dws-panel",
        ref: panelRef,
        role: "dialog",
        "aria-label": t("title"),
      },
      h("div", { className: "dws-head" },
        h("span", { className: "dws-title dws-head-text", title: t("head.done", { steps: stepsDone }) }, direct ? t("head.direct") : t("head.turn", { steps: stepsDone })),
        h("span", { style: { flex: "1 1 auto" } }),
        h("span", { className: "dws-head-time" }, formatShort(elapsed)),
        h("button", {
          type: "button", className: "dws-close", title: t("dismiss"), "aria-label": t("dismiss"),
          onClick: () => { setOpen(false); setDismissedTurn(turn); },
        }, "×")),
      // 头尾固定，中间这一段自己滚动：展开再长，“收起”也一直在底部。
      h("div", { className: "dws-body" }, logOpen ? h(LogView, { activity, live, now, t }) : h(React.Fragment, null,
      goal !== ""
        ? h("div", { className: "dws-goal" },
          h("span", { className: "dws-goal-label" }, t("goal.label")),
          h("div", { className: "dws-goal-body" },
            h("span", { className: "dws-goal-text", "data-open": goalOpen ? "true" : "false", title: goalOpen ? null : goal }, goal),
            goal.length > 56
              ? h("button", {
                type: "button", className: "dws-goal-toggle",
                onClick: () => setGoalOpen((value) => !value),
              }, goalOpen ? t("goalHide") : t("goalShow"))
              : null))
        : null,
      stageLabel !== "" && stageLabel !== goal
        ? h("div", { className: "dws-stage-line" },
          h("span", { className: "dws-stage-label" }, t("stage.label")),
          h("span", { className: "dws-stage-text", title: stageLabel }, stageLabel))
        : null,
      metrics,
      // 直接回答没有进度、也没有动作可列，只留目标和推理用时。
      direct ? null : h(ProgressRow, { estimate, t }),
      direct ? null : h("div", { className: "dws-rail dws-current-rail" },
        liveRow,
        headRows.length > 0 ? feedNodes(headRows, "new:") : (liveRow ? null : h("div", { className: "dws-sub" }, t("noEvents"))),
        expanded ? feedNodes(restRows.slice(0, HISTORY_LIMIT), "old:") : null),
      restRows.length > 0
        ? h("button", {
          type: "button", className: "dws-history", "aria-expanded": expanded,
          onClick: () => setExpanded((value) => !value),
        },
        h("span", { className: "dws-history-text" },
          expanded ? t("historyHide") : t("historyShow", { count: restRows.length })),
        h(ChevronGlyph, { collapsed: !expanded }))
        : null,
      prevTurn ? h(PrevTurn, { prev: prevTurn, open: prevOpen, onToggle: () => setPrevOpen((value) => !value), t, now }) : null)),
      h("div", { className: "dws-foot" },
        h("button", {
          type: "button", className: "dws-link dws-log-toggle", "aria-pressed": logOpen,
          onClick: () => { setLogOpen((value) => !value); setCopied(false); },
        }, logOpen ? t("log.back") : t("log.open")),
        logOpen
          ? h("button", { type: "button", className: "dws-link dws-log-copy", onClick: () => copyLog() }, copied ? t("log.copied") : t("log.copy"))
          : null,
        h("span", { className: "dws-foot-spacer" }),
        h("button", { type: "button", className: "dws-link", onClick: () => setOpen(false) }, t("collapse"))));

      return h("div", { className: "dws-root", ref: rootRef }, petFound ? null : chip, panel);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => installStyle(document), "dsh-work-status: styles");
        ctx.effect(
          () => ctx.locale.register(NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }),
          "dsh-work-status: dictionaries",
        );
        ctx.slots.inject(SLOT, () => ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS },
          ActivityBadge,
        ));
      },
    };
  },
});
