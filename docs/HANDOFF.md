# 交接：dsh-work-status 开发接手（0.4.11）

## 一、位置与安装链

- 源码：`E:/DSH/dsh-work-status`（git 仓库，分支以 `git branch` 为准）
- 包名 / 版本：`dsh-work-status` / `0.4.11`（`package.json`）
- 装机：`plugin-manager` 执行的 `install link:E:/DSH/dsh-work-status`
  - 落地路径：`C:/Users/17416/.dsh/profiles/desktop/node_modules/dsh-work-status` → 软链回源码目录，改源码即改装机
  - 加载登记：desktop profile 的 `package.json` → `dsh.profile.bundles` 含 `work-status`；`cordis.patch.yml` 含 `- id: work-status`
  - 该 profile 里 `dsh-agent-activity` 已被移出加载列表（包体仍在），同一插槽同时挂两个包会叠出两份界面
- 文档产物：`docs/RESEARCH-COMMUNITY.md`、`docs/STATS.md`、`docs/HANDOFF.md`（本文件）

## 二、运行与验证

| 用途 | 命令 |
| --- | --- |
| 语法检查 | `node --check lib/client.js`（以及 `lib/activity.js`、`lib/index.js`） |
| 全量测试 | `node --test tests/*.test.mjs`（0.4.11 上 66 项） |
| 包结构自检 | `node scripts/check-manifest.mjs`（校验 `package.json`、`dsh.client`、`cordis.patch.yml`、插槽名白名单） |
| 抓真机窗口 | `pwsh -NoProfile -File E:/DSH/patch/capture-dsh-window.ps1 -OutFile <png>`（必须 pwsh 7） |
| 重启 DSH | `pwsh -NoProfile -File E:/DSH/patch/restart-dsh.ps1` |
| 记录插件变更 | `node "C:/Users/17416/.dsh/skills/plugin-manager/dsh-plugin.cjs" note "更新" dsh-work-status "…"` |

- 客户端 JS 会热加载，样式标签同时换成新版（`installStyle` 就地替换）；CSS 简写 `font` 里不能写 `inherit`（整条失效），宿主侧 `lib/activity.js` 或 `stateVersion` 变更需要重启 DSH 才生效
- 每个发布版本留快照：`E:/DSH/patch/dsh-work-status-snapshots/<version>/{lib,tests}`

## 三、宿主侧：会话投影契约

`lib/index.js` 仅导出 `name`、`inject = ["sessionProjections"]`，在 `apply(ctx)` 里注册 `activityProjection`。

`lib/activity.js` 的导出契约：

```js
export const ACTIVITY_KEY = "workStatus";
export const activityProjection = {
  key: ACTIVITY_KEY,
  stateVersion: 17,          // 改 state 形状必须 +1，旧 checkpoint 会被丢弃重放
  stateSchema: plainSchema,  // 宽松 schema
  init: () => EMPTY,
  apply: (state, event) => applyEvent(state, event),
  wire: { viewSchema: plainSchema, view: (state) => state },  // 客户端拿到的就是整份 state
};
```

- `applyEvent(state, event)` 必须是同步纯函数，且对无关事件返回**同一个引用**（宿主据此跳过广播）；不允许读环境、写文件、发网络
- 事件来自会话日志，字段以真实日志为准（`type`、`seq`、`time`、`data`）；当前消费：`turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`user/message`、`compaction/*`
- 客户端不计算业务，只渲染：进度、耗时、失败归属都应在折叠层算好

### state 主要字段

| 字段 | 内容 |
| --- | --- |
| `turn` / `phase` / `startedAt` / `updatedAt` | 轮次与阶段 |
| `items` | 动作记录（`kind: "call"`、`name`、`target`、`status: running/ok/error`、`t0`、`t1`、`err`、`task`、`why`） |
| `counts` | `{ ops, steps, tools, errors, context }`（`steps` 只数非上下文维护的成功调用） |
| `plan` / `todos` | 计划进度与清单 |
| `stage` | `{ key, label, kind }`，由 todo `in_progress` 或消息短标题推得 |
| `acp` | `{ blocks, status, ops }`，会话级账，`turn/start` 不清零 |
| `stepStats` | 按「首个工具名」归档的步耗时样本（`model|sig`、`tool|cat|sig`，各最多 30 条） |
| `modelMs` / `stepModelDone` | 本轮模型推理合计：每步 `step/start` → 该步 `assistant/message`（真实日志里每步恰好一条，在输出完成时落地）；`stepModelDone` 标记本步已记 |
| `toolMs` / `toolOpen` / `toolSince` | 本轮工具占用合计：所有调用（含上下文维护）时间的并集，并行重叠只算一次；客户端对进行中的部分补到当前时刻 |
| `decision*` / `stall` | 决策回合统计与低收益计数 |
| `history` | 最近 24 轮（`HISTORY_TURNS`）逐轮记录：`turn`、`startedAt`、`endedAt`、`wallMs`、`rounds`（模型回合，= DSH 状态栏的“步”）、`steps`（成功工具调用）、`ops`、`errors`、`modelMs`、`toolMs`、`ctx`、`prompt`（截 80 字）、`phase`；ETA 也读它 |
| `totals` | 会话从头累计：`turns`、`rounds`、`steps`、`ops`、`errors`、`ctx`、`ctxFailed`、`modelMs`、`toolMs`、`wallMs`、`firstAt`、`lastAt`（日志视图用） |
| `prev` | 上一轮快照：`turn`、`prompt`、起止、`steps`、`errors`、`modelMs`、`toolMs`、`items`、`ctx`（那一轮的上下文维护操作） |

- `acp.ops` 是会话账（最多 16 条）；按轮显示一律用 `turnOps(state)`（完成时刻 ≥ `startedAt`），客户端同样过滤

## 四、客户端侧：插件契约

`lib/client.js` 外层是 `window.__ModuleLoader__.load({ id, factory(require) })`，宿主注入 `React`；组件通过 `ctx.slots.register` 挂到插槽：

```js
const SLOT = "conversation.input.dock";
const ENTRY_ID = "activity";
const ORDER = 40;
ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS }, ActivityBadge));
```

- 词典：`ctx.locale.register(NS, { zh, en })`，`t("key", {…})` 取值；新增文案必须中英各一条
- 数据：`useProjection(ACTIVITY_KEY)` 读宿主投影
- 样式：`installStyle(document)` 注入 `STYLE_TEXT` 一个 `<style>`，前缀 `dws-`；不写死颜色，只用宿主 CSS 变量
- 单实例闸门：热更新会重挂组件，用 `globalThis.__dwsInstanceRegistry` 只让最近挂载的实例渲染
- 桌宠入口：`MutationObserver` 在 `document.body` 找 `.dsh-claude-deepy` / `.dsh-claude-crab`；找到则不渲染标题栏徽标，右键（`contextmenu`，文档捕获阶段）开关面板，并把桌宠 `pointer-events` 置为 `auto`

### 客户端代码分区（同文件内自上而下）

1. `SLOT` / `ENTRY_ID` / `ORDER` / `NS` 等常量
2. `MESSAGES_ZH` / `MESSAGES_EN` 字典
3. 纯函数：`formatShort`、`formatTokens`、`targetLabel`、`intentOf`、`actionOf`、`todoProgress`、`estimateProgress`、`mergeSameRuns`、`groupEntries`、`failText`
4. 图形组件：`CheckGlyph`、`CrossGlyph`、`ChevronGlyph`
5. 行组件：`ActionRow`、`TaskHeader`、`SaidLine`、`NextRow`、`ProgressRow`
6. `ActivityDock`（徽标 + 面板 + 定位 `fit()`）
7. `ActivityBadge`（投影、阶段、可见性、单实例闸门）与 `apply(ctx)` 注册

### 定位与尺寸

- 面板结构：`dws-head`（固定）/ `dws-body`（唯一滚动区；日志打开时换成 `LogView`）/ `dws-foot`（固定：左「日志」「复制」，右「收起」）
- 宽 380px，右沿 = 对话滚动区内容右沿 − 8px（`scrollBoxOf()`），底沿 = 锚点上沿 − 8px
- 高度上限只取可用空间；首次定位使用 layout effect，避免动画缩放影响高度。
- 面板 `position: fixed`，打开时 `fit()` 按锚点（桌宠或徽标）的视口坐标算目标位置，再经 `fixedFrameOf()` 换算到 fixed 实际的包含块（最近的带 transform / filter / contain / container-type 等的祖先，没有就是视口）
- `maxHeight = min(自然高度, 锚点上方 8px 到对话滚动区顶边下 8px)`；自然高度 = 面板高 − `.dws-body` 可见高 + 其内容高，**不能**先设 `max-height: none` 再量（会把滚动位置归零，0.4.2 的滚轮失效即此）；面板内部滚动不触发 `fit()`
- 所有取 document 的地方用 `ownDocument()`（root / panel / chip 任一）：桌宠模式不渲染徽标，`chipRef` 为空
- 真机 DOM（2026-10-26 实测）：插件在 `composerStack` → `composerSeat`（`position: sticky; z-index: 7`）→ `scrollBody`（滚动区，顶边 y≈91）里；其上是会话标题栏，层级更高，面板伸进去会被盖住；祖先链没有 transform；输入框长高时靠 `resize` / `scroll` / `ResizeObserver` / 350ms 轮询重算
- 面板自身 `overflow: hidden`，滚动在 `.dws-body { overflow-y: auto; overscroll-behavior: contain }`

## 五、测试策略

- `tests/activity.test.mjs`：折叠层纯函数。用 `ev(type, time, data)` 造事件、`replay(events)` 折叠，断言 state 字段
- `tests/client-render.test.mjs`：真实 React + jsdom。文件顶部伪造 `window.__ModuleLoader__`、宿主 `ctx`（含 `slots.register`、`locale.register`、`effect`），挂载组件后遍历虚拟树取文本与 props
- 通用断言手段：`byClass("dws-…")`、`textOf(tree)`、`collect(tree, …)`；`props()` 生成投影状态、`activity(over)` 覆盖字段、`call(name, target, status, extra)` 造动作
- 新增形状（新的工具类别、新的 ACP 回执格式）优先在 `activity.test.mjs` 补折叠用例，再在渲染测试里断言文案

## 六、主题与样式契约

- 只用这些变量：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1|2|3`、`--dsw-alias-border-l1`、`--dsw-alias-label-primary|secondary|caption|tertiary`、`--dsw-alias-brand-primary`、`--dsw-alias-bad`
- 主题（例如 `dsh-claude-style`）通过覆写变量换肤；插件不感知具体主题名
- 字体：界面字体沿用宿主；标题可用 `--dsh-claude-font-serif`（取不到时回退系统衬线）
- 暗色模式不写单独样式，靠变量切换

## 七、本机验证过的技术约束

- 会话日志为多帧 zstd，Node `zlib.createZstdDecompress` 读多帧会报 `ZSTD_error_prefix_unknown`；用 Python `zstandard.stream_reader`（`E:/DSH/patch/eval/unzstd.py`）
- jsdom 无 `innerText`；节点必须先 `document.body.appendChild(root)` 再 `getBoundingClientRect()`，否则尺寸为 0
- 测试里的宿主 `ctx` 必须有 `locale.register`，否则组件在 `t()` 处抛错
- 宿主插槽容器带 `transform` 时，子元素 `position: fixed` 会相对该容器解析；面板定位因此按视口坐标手算
- `ctx.jobs.read()` 是单消费者游标，读一次会顶掉模型的 `job_output` 与完成通知；本插件不调用
- Windows 下进程被强制结束时 `finally` 不保证执行；依赖“结束事件”的推断需标注为推断

## 八、常见改动落点

| 需求 | 改哪里 |
| --- | --- |
| 新增/修正工具动词与对象摘要 | `lib/client.js` 的 `INTENT_BY_TOOL`、`intentOf`、`targetLabel` |
| 新增统计口径（耗时、失败、上下文） | `lib/activity.js` 的 `applyEvent` + `stateVersion` +1 |
| 改面板结构或样式 | `lib/client.js` 的 `STYLE_TEXT` 与 `ActivityDock` 渲染 |
| 改折叠/暂停判定 | `lib/activity.js` 的 `decision` / `stall` 逻辑 |
| 新增文案 | `MESSAGES_ZH` / `MESSAGES_EN` 同名键 |

## 九、已验证与未验证

本机（Windows、Electron 桌面端、dsh-claude-style 主题）已确认：右键桌宠开合面板、面板在输入框上方定位、面板内滚动不带动主窗口、溢出时顶部停在标题栏下、「收起」常驻、时间列与圆环对齐、上下文维护行并入时间轨。

边界与未覆盖项：

- 输入框被拉到很高（接近视口一半以上）时，面板顶部仍可能贴到标题栏边缘；自动化测试只覆盖了合成高度。
- 只在本机主题（dsh-claude-style，Claude / DeepSeek 两档配色）下验证；其他主题依赖同一批 `--dsw-alias-*` 令牌，但未逐一实测。
- 只在 Windows 桌面端验证；Web UI 与 macOS 未实测。
- 桌宠入口依赖主题的 `.dsh-claude-deepy` / `.dsh-claude-crab` 类名，主题改名后会自动回退到「输入框上方的徽标」。
- 真机排查方法：带 `--remote-debugging-port=9223 --remote-allow-origins=http://127.0.0.1:9223` 启动，用 CDP `Runtime.evaluate`；滚轮用 `Input.dispatchMouseEvent` 的 `mouseWheel`，先在对话区做对照。

## 十、沟通约束记录

- 用户多次要求「先分析、先不改」；排版改动前先给方案再动手
- 用户明确过「只去掉竖线，其他不变」（0.4.1 按此执行）
- 未真机确认前不宣称修好

## 0.4.10 接手状态
用户明确要求暂不重启。新版宿主字段与阶段修复待重启加载；参见 docs/VERIFICATION-0.4.10.md。动作逐条显示，不再按简写合并；命令优先显示 description，说明来自模型调用参数，不能当作成功证据。

