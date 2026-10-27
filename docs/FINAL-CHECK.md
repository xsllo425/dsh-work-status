# 交付前总检（范围级）

日期：2026-10-26 ／ 版本：0.7.0 ／ 结论：可以告一段落

这次不抠样式细节，只回答一个问题：**它够不够格作为一个开源插件交出去。**

## 一、交付物

| 东西 | 位置 |
|---|---|
| 仓库 | https://github.com/xsllo425/dsh-work-status |
| 版本与说明 | `README.md`（默认中文）、`README.en.md`、`CHANGELOG.md`（48 个版本段） |
| 发布 | tag 与 Release `v0.7.0`（Latest，非草稿、非预发布） |
| 安装 | `install github:xsllo425/dsh-work-status#v0.7.0`，或本地 `link:` |
| 截图 | `docs/screenshots/`（渲染图 ×2 + 真机脱敏图） |
| 介绍 | `docs/dsh-work-status-intro.pptx`（7 页） |
| 交接与依据 | `docs/HANDOFF.md`、`docs/STATS.md`、`docs/RESEARCH-COMMUNITY.md`、`docs/AUDIT.md`、`docs/RELEASE.md` |
| 宣传文案 | `docs/PROMO.md` |

## 二、通过项

| 检查 | 结果 |
|---|---|
| 仓库卫生 | 38 个受管文件；无 `node_modules`、无 tgz、无临时补丁目录；`git status` 干净 |
| 凭据 | 代码与文档里无 token / key / 密码；跨会话统计只存「工具名 + 毫秒数」 |
| 许可与归属 | 主体 MIT；`NOTICE` 保留 dsh-agent-activity 0.9.0 归属，并声明不含 dsh-claude-style 的任何美术资产 |
| 文档一致性 | 版本 0.7.0、测试 84 项、`stateVersion 18` 三处对齐；`docs/REVIEW.md` 旧快照已标注过期 |
| 代码约束 | 无网络调用、无 `eval`/`new Function`、无 `child_process`；零运行时依赖、零开发依赖 |
| 资源回收 | 计时器 2 处 set / 2 处 clear；监听器与 MutationObserver 均随卸载清理 |
| 测试 | 7 个套件 84 项全过（含 3 项中英文案一致性、2 项 ACP 回执形状） |
| 清单自检 | `node scripts/check-manifest.mjs` 通过（字段、导出、补丁行、图标、语言包） |
| CI | `ubuntu-latest` + `windows-latest`，Node 24：三处 `--check`、全量测试、清单自检 |
| 发布包 | `npm pack` 28 个文件、468 KB；包含全部测试套件与 `README.en.md` |
| 安装状态 | 本机 profile 以 `link:E:/Work/dsh-work-status` 装入，版本 0.7.0，与仓库一致 |
| 仓库元数据 | Public、MIT、默认分支 `main`、Topics 7 个、Website 指向介绍 PPT |

## 三、已知限制（写清楚，不假装没有）

1. **桌宠联动是 best-effort**：它依赖 `dsh-claude-style` 的内部类名，主题一改就可能失效；`<html data-dws-pet="off">` 可停用。
2. **决策回合模块目前没有渲染入口**：数据有、测试有，但界面没展示；文案已按「降级口径」写过，恢复展示前不需要再改判定。
3. **单轮 ETA 故意不做**：14,418 轮真实日志的对照结论是它不可靠（`docs/STATS.md`），只保留「当前步 vs 同类步」参照。
4. **真机验证只覆盖 Windows**：CI 跑 Ubuntu + Windows，但视觉只在 Windows 桌面应用里核对过；其他平台主题差异未逐一截图。
5. **GitHub Topics 索引有延迟**：打上 `dsh-plugin` 后出现在话题页通常要几分钟到几小时。

## 四、复核命令

```bash
node --check lib/client.js && node --check lib/activity.js && node --check lib/index.js
node --test tests/*.test.mjs      # 84 项
node scripts/check-manifest.mjs
npm pack --dry-run
```
