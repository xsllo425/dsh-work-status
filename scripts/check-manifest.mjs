/**
 * dsh-work-status 发布前自检：node scripts/check-manifest.mjs
 *
 * 公共部分（清单字段、exports、files[]、patch 行、双语简介、图标、CHANGELOG、README）在
 * plugin-audit.mjs；这里只写本插件自己的约定：客户端挂在输入框上方的插槽里、不往页面别处画，
 * 宿主端只读会话投影。
 */
import { openAudit } from "./plugin-audit.mjs";

const audit = openAudit(import.meta.url);
const { pkg, expect, text } = audit;

audit.packageBasics({
  name: "dsh-work-status",
  extra: [
    [pkg.dsh?.client?.immediately === true, "dsh.client.immediately 应为 true（卡片要随页面一起出现）"],
    [Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, "dsh.client.inject 至少要列出对话包"],
  ],
});
audit.exportsResolve();
audit.filesShip(["icon.svg", "NOTICE", "CHANGELOG.md"]);
audit.patchRow("work-status");
audit.localeMeta();
audit.iconOk();

// 客户端：只通过模块加载器注册，只画在自己的插槽里。
const client = text("lib/client.js");
expect(client.includes('id: "dsh-work-status"'), "client.js 注册的 id 应与包名一致");
expect(client.includes("__ModuleLoader__.load"), "client.js 应通过 __ModuleLoader__.load 注册");
expect(!/require\(["']@deepseek-ai\//.test(client), "client.js 不能 require 宿主的 @deepseek-ai 包");
expect(!/document\.body|createPortal/.test(client), "client.js 只能画在自己的子树里（不碰 document.body、不用 portal）");
expect(client.includes("conversation.input.dock"), "client.js 应挂在 conversation.input.dock 插槽");

// 宿主端：只导出 apply，只读会话投影。
const host = text("lib/index.js");
expect(/export function apply\(/.test(host), "lib/index.js 应导出 apply 函数");
expect(/export const inject = \[[^\]]*"sessionProjections"/.test(host), "lib/index.js 应注入 sessionProjections");
expect(!/export default/.test(host), "lib/index.js 不要混用 export default");

audit.changelogHead();
const tests = audit.countTests();
audit.readmesHonest({ files: ["README.md", "README.en.md"], tests, repo: "xsllo425/dsh-work-status" });
audit.finish(`声明测试 ${tests} 项`);
