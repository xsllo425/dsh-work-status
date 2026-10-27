# 发版清单

照着做，每一步都能验证。命令在仓库根目录执行。

## 1. 先确认代码是绿的

```bash
node --check lib/client.js && node --check lib/activity.js && node --check lib/index.js
node --test tests/*.test.mjs        # 全绿，条数与 README 写的一致
node scripts/check-manifest.mjs     # 清单 / 导出 / patch 行 / 图标 / 双语文案 / 文档一致性
npm pack --dry-run                  # 看包里有没有 README 引用的截图、docs/HANDOFF.md 之类
```

这几步在 CI 里跑（`.github/workflows/ci.yml`，Node 24，ubuntu + windows）。

`check-manifest` 会顺带核对那些以前靠人记的事：README 里的测试数、安装命令、README 里出现的截图是否都进了 `files[]`、CHANGELOG 头部版本与 `package.json` 是否一致。数字对不上会直接报错，别把手改到它闭嘴，改成真实值。

## 2. 定版本号

- 只改显示、文案、内部实现：补丁号（0.9.0 → 0.9.1）
- 加了用户能看见的新东西：次版本号（0.9.0 → 0.10.0）
- 换事件契约、改了别人依赖的导出：主版本号，并在 CHANGELOG 写清怎么迁移
- `lib/activity.js` 里的 `stateVersion`：投影状态结构一变就要加一，旧检查点必须从日志重建

## 3. 改三处

1. `package.json` 的 `version`
2. `CHANGELOG.md`：把 `## 未发布` 改成 `## X.Y.Z — YYYY-MM-DD`（没有「未发布」段就先补条目）
3. `README.md` / `README.en.md` 的测试数，改成实际条数

## 4. 提交、推送、等 CI

```bash
git add -A && git commit -m "X.Y.Z：一句话说清这版改了什么"
git push origin main
```

CI 三个 step（语法、测试、清单）都要绿。

## 5. 打 tag

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

tag 也会触发一次 CI，等它绿。

## 6. 建 Release

说明先写成文件（仓库外，例如 `E:/Work/patch/release-X.Y.Z.md`），包含这版改了什么、安装命令（带 tag）、已知限制。

```bash
E:/Work/patch/gh.sh release create vX.Y.Z --title vX.Y.Z --notes-file E:/Work/patch/release-X.Y.Z.md
```

`gh.sh` 从 `git credential` 现取 token，不在磁盘留凭据。建完确认 `draft=false`。

## 7. 发 npm（插件中心只认 npm 安装）

`dsh-plugin-hub` 的目录里，只有能从 npm 安装的插件才显示「一键安装」。发布走官方源：`package.json` 的 `publishConfig` 已经固定成 `https://registry.npmjs.org/` + `access: public`，本机 registry 指到镜像是另一回事，不影响发布。

```bash
npm whoami --registry=https://registry.npmjs.org/   # 没登录先登录（浏览器授权一次即可）
npm login --registry=https://registry.npmjs.org/
npm publish                                          # publishConfig 会把源和可见性定死
```

- 登录的是 npm 官方站，不是国内镜像（镜像那条链只能读、发不了包）。
- 包名一旦发布就永久占用；同一个版本号不能重发，发错了只能 `npm deprecate`。
- 发完核对：`npm view dsh-work-status version`，再在目录里搜一眼是否已能直接装。

## 8. 市场索引（不用手动更新，等一天）

市场是**拉**的模式，不是我们推。`2BingLing/dsh-market` 的采集器每天 UTC 19:00（北京 03:00，22:00 兜底）从 GitHub topic 扫描一遍，拿仓库的 `pushed_at` 跟缓存比：变了就重读 README、重解析安装命令、重抓简介。所以发版只需要「README 在 main 上 + npm 已发」，次日照常同步。

- 提交 issue（#294）是**一次性**的收录入口：收到 → 自动回复 → 收录 → 自动关闭，之后与日常更新无关，不用管它开着还是关着。
- 市场数据里没有版本号字段，详情页显示的是「更新时间」（= 仓库 `pushed_at`）。「有新版本」是市场插件在本机实时查 `registry/<包名>/latest` 比出来的，发到 npm 就有了。
- issue 正文只影响三样：作者自述、中文简介、安装命令。改版本号、测试数写进正文**没有作用**。真要改这三样，开一条 `[数据修正]` issue（次日 06:00 自动应用）。
- **安装命令必须放在 `bash` 代码块里**（或以 `$` 开头的行）。采集器只认这两种，表格里的命令不会被解析，详情页就没有可复制的安装命令。发版前顺手确认安装章节里有这样的块：

```bash
awk '/^## 安装/,/^## 更新/' README.md | grep -A3 '^```bash'
```

## 9. 本机实际看一眼

插件是通过软链接装进 profile 的（`~/.dsh/profiles/desktop/node_modules/dsh-work-status` → 这个仓库），重启 DSH 窗口就是最新代码。加「整轮」级别的功能时，建议再走一遍干净安装：`npm pack` 出 tarball，插件页按 `file:` 装上，确认行会出现、展开、日志、复制、收起都正常，卸载后不留东西。

## 10. 仓库元数据（偶尔核对）

- `package.json`：`author`、`repository`、`homepage`、`bugs`、`keywords`、`license: MIT`
- `LICENSE`（MIT）与 `NOTICE`（源自 `dsh-agent-activity` 0.9.0）都在
- GitHub topics：`dsh-plugin`、`deepseek-harness`、`dsh`、`plugin`
- npm 上有正式版本（插件中心可直接装）；GitHub / 本地目录 / tarball 三种装法照旧可用

## 记录

发完在 CHANGELOG 顶部留日期段；这次踩到的坑补进本文。
