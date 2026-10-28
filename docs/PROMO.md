# 宣传用文案（可直接复制）

## 仓库简介（GitHub About，≤ 120 字）

> DeepSeek Harness 插件：把 Agent 的工作状态收进标题栏一行——在做什么、做到哪、失败过没有；点开是目标、当前步、最近记录与上一轮。不调模型、不写提示词，只读已发生的事件。

## 一句话（社交/群公告）

> 给你的 Agent 装一只「进度胶囊」：一眼看见它在干什么，点开才知道细节。

## 三句话

1. 长任务里最难受的不是等，是不知道在等什么。
2. 这个插件把「正在跑哪一步、本轮几步、刚才哪步失败过」收成标题栏一行。
3. 数字只说能证实的：有清单才给比例，没依据就写「未知 · 已 3m20s」。

## 一段（README 顶部或发布说明可用）

> **dsh-work-status** 是 DeepSeek Harness 的状态可视化插件。它不接管任务、不改会话，只把宿主已有的事件整理成一行状态与一个可展开的面板：谁在跑、跑了几步、哪一步失败了、上一轮做了什么。跨会话只记「工具名 + 毫秒数」用于同类步参照，可以一键清掉；结果没回来就写「结果未知」，不猜。

## 关键词 / topics

`deepseek-harness` `dsh-plugin` `agent-ui` `progress` `observability` `status-bar` `no-dependencies`

## 配图

| 文件 | 用途 |
|---|---|
| `docs/screenshots/panel-demo.gif` | 首屏动图（6 帧：思考中 → 运行测试进行中 → 失败未恢复 → 同一目标重试成功、旧行划掉转灰 → 进度推进），README 首屏与插件市场提交用 |
| `docs/screenshots/real-panel-redacted.png` | 真机截图（侧栏与对话已打码），README 与 PPT 用 |
| `docs/screenshots/panel-dark.png` | 深色档渲染图，README 第二张 |
| `docs/dsh-work-status-intro.pptx` | 7 页介绍，发版或演示用 |

## 脱敏说明

真机截图只保留插件面板；左侧会话列表、顶部标题、对话正文与输入框都做了模糊处理，面板里不出现任何会话 id 或项目路径（只有仓库内的相对路径）。
