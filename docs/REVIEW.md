# dsh-work-status 审阅说明

> 说明：这是 **0.4.18 时期**的快照，数字（版本、测试数、是否已推送）都已过期；当前状态见 `README.md` 与 `CHANGELOG.md`（0.8.1，98 项测试，已开源在 `xsllo425/dsh-work-status`）。以下内容保留作为那次外部审阅的上下文。

给外部审阅者的一页纸：这是什么、现在什么状态、怎么跑、希望你重点看什么。

- 仓库：`E:/DSH/dsh-work-status`（本地 git，已提交 0.4.18，**尚未推送**）
- 版本：`0.4.18`，MIT，零运行时依赖
- 测试：`node --test tests/*.test.mjs` → 69 项全过；`node scripts/check-manifest.mjs` → 通过
- 截图：`docs/screenshots/panel-light.png`、`panel-dark.png`

## 一句话

一个 DeepSeek Harness 的客户端插件：把会话事件投影成一张安静的状态卡片，让人在不打断工作的情况下看出「这一轮在做什么、做到哪、有没有卡住」。

## 它做什么

- 常驻标题栏（或桌宠）的一个小徽标：进行中显示动作用时，结束时显示完成步数。
- 点开是一张浮层：本轮目标、三项指标（模型推理 / 工具调用 / 上下文压缩次数与失败数）、一条时间轨（最近若干步，进行中的一步在最上面）。
- 时间轨里每行说人话：动作（跑测试 / 改文件 / 读文件 / 找代码 / 跑脚本 / 压缩上下文…）+ 对象（按目录职责与扩展名归类，如「界面代码」「依赖清单」）+ 用时。
- 失败分两种：真失败挂「未恢复」；被后续成功接替的划掉转灰，不制造焦虑。
- 底栏「日志」可切到会话总计与逐轮记录，上一轮单独成块。
- 上下文压缩/恢复作为普通记录留在时间轨里，不单开一栏。

## 它不做什么

- 不调模型、不写提示词、不联网。
- 不读会话日志文件；只消费宿主已经折好的会话投影（`sessionProjections`）。
- 唯一会落盘的东西：`~/.dsh/work-status/step-stats.json`，只存「工具归类键 + 毫秒数」，不含路径/命令/提示词/会话 id；有上限（每类 30 个、最多 48 类），**随时可删**，删了等于冷启动；`DSH_WORK_STATUS_NO_HISTORY=1` 可彻底关闭。
- 不做整轮 ETA：全量语料实测过（见 `docs/STATS.md`），长轮次基本是乱猜，所以只做「当前这一步 vs 同类步」的参照。
- 不评价模型思考质量，不判定「停滞」以外的语义结论。

## 怎么跑起来

```bash
cd E:/DSH/dsh-work-status
node --test tests/*.test.mjs        # 68 项
node scripts/check-manifest.mjs     # 插件清单自检
npm pack                            # 打包 dsh-work-status-0.4.18.tgz
```

装到宿主：

```bash
# 方式一：本地 link（开发）
node "%USERPROFILE%\.dsh\skills\plugin-manager\dsh-plugin.cjs" install "link:E:/DSH/dsh-work-status"
# 方式二：tarball
npm install dsh-work-status-0.4.18.tgz      # 在 profile 的 node_modules 里
```

宿主是 `%USERPROFILE%\.dsh\profiles\desktop`；改完客户端代码要重启宿主才生效。

## 关键取舍（想被质疑的地方）

1. **投影只折 15 种事件**（`STATE_VERSION = 17`），不认识的直接忽略；怀疑有事件漏折导致状态不准。
2. **状态措辞**只写能证实的档位（「工具执行中」而不是「运行中」），宁可含糊不撒谎。
3. **Eager 分析**：`tool/call` 时就置 running，`tool/result` 再补结局；中断靠 `turn/end` 收尾为 unknown。
4. **失败划掉转灰**：同一动作后来成功，就把之前那条划掉——不确定这是否会被误读成「没发生」。
5. **角色映射是启发式**：目录 + 扩展名 + 文件名词表；可能把陌生路径归错类，认不出时保留原文件名。
6. **单实例闸门**挂在 `globalThis`，防止热更新后出现两个卡片。

## 已知局限（诚实清单）

- 面板贴右边缘，会压住部分滚动条；要彻底解决得让面板可拖动或左移，属于版式改动，暂未做。
- 只在 Windows + desktop profile + `dsh-claude-style` 主题下验证过；其它主题只保证「用宿主令牌、不写死颜色」。
- 桌宠入口依赖 `dsh-claude-style` 的 `.dsh-claude-deepy/.dsh-claude-crab`，没有桌宠时自动退回标题栏徽标。
- 跨会话参照在面板上标「据历史」，本会话样本够了会自动切换，这一步的切换肉眼可见。
- 截图是用插件自己的 `STYLE_TEXT` 渲染的静态预览，不是真机截屏，字形/阴影会有细微差别。
- `docs/RELEASE.md` 里的发布清单是草案，尚未实际推送 GitHub。

## 希望重点审什么

1. `lib/activity.js` 的事件折叠是否有漏折/重复折叠的路径（尤其 `tool/call` 无 `tool/result`、并行工具、`turn/end`）。
2. 客户端 `useProjection` 的取值与渲染是否有不必要的全量重算（每次状态变化都重排整棵时间轨）。
3. 失败划掉转灰的语义是否会造成误读。
4. 角色映射（`targetRoleOf`/`humanizeName`）的启发式是否过度推断。
5. README 的安装说明在干净环境下是否能照着跑通。
6. MIT + NOTICE 的归属写法是否合规。

## 材料索引

| 文件 | 作用 |
| --- | --- |
| `README.md` / `README.en.md` | 项目主说明（中/英），安装、用法、截图 |
| `CHANGELOG.md` | 0.1.0 → 0.4.18 的完整改动记录 |
| `docs/HANDOFF.md` | 接手开发用：投影契约、state 字段、代码地图、测试策略 |
| `docs/STATS.md` | 统计口径与全量评测结论（为什么不做整轮 ETA） |
| `docs/RESEARCH-COMMUNITY.md` | 社区 9 个同类插件的机制、坑与许可证对比 |
| `docs/RELEASE.md` | 发布清单草案 |
| `docs/VERIFICATION-0.4.10.md` | 一次改动级别的验证记录示例 |
| `docs/screenshots/` | 浅色/深色面板截图 |
| `tests/*.test.mjs` | 5 个套件，69 项 |
