/**
 * 插件发布前自检的公共工具。dsh-work-status 与 dsh-agent-menu 共用同一份（两边文件内容相同），
 * 各自的 scripts/check-manifest.mjs 只写本插件特有的检查项。
 *
 * 用法：
 *   const audit = openAudit(import.meta.url);
 *   audit.packageBasics({ name: "dsh-x" });
 *   audit.expect(条件, "说明哪里不对");
 *   audit.finish();
 *
 * 只用 Node 自带模块，离线可跑；任何一项不通过都会列出来，最后以退出码 1 结束。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

// files[] 里的通配写法转成正则：单个星号不跨目录，两个星号加斜杠可跨任意层目录。
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { source += "(?:.*/)?"; i += 2; continue; }
    if (ch === "*") { source += "[^/]*"; continue; }
    source += /[\\^$.|?+()[\]{}]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp("^" + source + "$");
}

/** 列出目录下的相对路径（正斜杠），跳过 node_modules 与 .git。 */
function listFiles(root, sub = "") {
  const here = join(root, sub);
  if (!existsSync(here)) return [];
  const out = [];
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const relative = sub ? posix.join(sub, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else out.push(relative);
  }
  return out;
}

export function openAudit(scriptUrl) {
  const root = join(dirname(fileURLToPath(scriptUrl)), "..");
  const problems = [];
  const at = (relative) => join(root, relative);
  const exists = (relative) => existsSync(at(relative));
  const text = (relative) => readFileSync(at(relative), "utf8");
  const json = (relative) => JSON.parse(text(relative));
  const pkg = json("package.json");
  const allFiles = listFiles(root);

  const expect = (ok, message) => { if (!ok) problems.push(message); return Boolean(ok); };

  /** 这个相对路径会不会被 files[] 带进发布包（! 开头的排除项优先）。 */
  function shipped(relative) {
    const entries = Array.isArray(pkg.files) ? pkg.files : [];
    const excluded = entries.filter((e) => e.startsWith("!")).some((e) => globToRegExp(e.slice(1)).test(relative));
    if (excluded) return false;
    return entries.filter((e) => !e.startsWith("!")).some((e) => (e.includes("*") ? globToRegExp(e).test(relative) : e === relative));
  }

  /** 清单的基本字段。name 必须给；其余按插件的通用约定检查。 */
  function packageBasics({ name, extra = [] }) {
    expect(pkg.name === name, `package.json 的 name 应为 ${name}`);
    expect(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version ?? ""), "version 不是 x.y.z 形式");
    expect(pkg.type === "module", "type 应为 module");
    expect(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 应指向 ./cordis.patch.yml");
    expect(pkg.dsh?.client?.platform === "web", "dsh.client.platform 应为 web");
    expect(Array.isArray(pkg.dsh?.client?.inject), "dsh.client.inject 应是数组");
    for (const [ok, message] of extra) expect(ok, message);
  }

  /** exports 里每一项都要落到真实文件上（带 * 的拿 en 代入试一下）。 */
  function exportsResolve() {
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      if (!expect(typeof target === "string", `exports["${key}"] 应映射到单个文件`)) continue;
      const probe = target.includes("*") ? target.replace("*", "en") : target;
      expect(exists(probe), `exports["${key}"] → ${target} 找不到`);
    }
  }

  /** files[] 的每一项都要命中至少一个文件；required 里的必须被带上。 */
  function filesShip(required = []) {
    for (const entry of pkg.files ?? []) {
      if (entry.startsWith("!")) continue;
      const hit = entry.includes("*") ? allFiles.some((f) => globToRegExp(entry).test(f)) : exists(entry);
      expect(hit, `files[] 里的 ${entry} 没有对应文件`);
    }
    for (const item of required) expect(shipped(item), `files[] 应带上 ${item}`);
  }

  /** cordis.patch.yml 要插入本插件那一行。 */
  function patchRow(rowId) {
    const patch = text("cordis.patch.yml");
    expect(patch.includes(`- id: ${rowId}`), `cordis.patch.yml 缺少 id: ${rowId} 这一行`);
    expect(patch.includes(`name: ${pkg.name}`), `cordis.patch.yml 那一行应写 name: ${pkg.name}`);
  }

  /** 插件页读的中英文标题与简介。 */
  function localeMeta(locales = ["zh", "en"]) {
    for (const locale of locales) {
      const meta = json(`locale/${locale}.json`).meta ?? {};
      expect(typeof meta.title === "string" && meta.title.trim() !== "", `locale/${locale}.json 缺 meta.title`);
      expect(typeof meta.description === "string" && meta.description.length > 20, `locale/${locale}.json 缺 meta.description（或太短）`);
    }
  }

  /** 图标：本地 SVG，不超过 256 KiB，不嵌位图、脚本或外链。 */
  function iconOk(relative = "icon.svg") {
    if (!expect(exists(relative), `${relative} 不存在`)) return;
    const size = statSync(at(relative)).size;
    const body = text(relative);
    expect(size <= 256 * 1024, `${relative} 有 ${size} 字节，超过 256 KiB`);
    expect(body.includes("<svg"), `${relative} 里没有 <svg> 元素`);
    expect(!/<image|<script|href="(?:https?:)?\/\//i.test(body), `${relative} 不能嵌位图、脚本或外链`);
  }

  /** tests/*.test.mjs 里以 test( 开头的行数，即 node --test 会报告的用例数。 */
  function countTests() {
    return allFiles
      .filter((f) => /^tests\/[^/]+\.test\.mjs$/.test(f))
      .reduce((sum, f) => sum + (text(f).match(/^test\(/gm) ?? []).length, 0);
  }

  /** CHANGELOG 第一个二级标题要么是「未发布」，要么就是当前版本号。 */
  function changelogHead() {
    const heading = text("CHANGELOG.md").split("\n").find((line) => line.startsWith("## ")) ?? "";
    if (heading.startsWith("## 未发布")) return;
    const version = heading.slice(3).trim().split(/\s+/)[0];
    expect(version === pkg.version, `CHANGELOG 最新一节是 ${version || "（空）"}，与 package.json 的 ${pkg.version} 不一致`);
  }

  /**
   * README 跟着代码走：写明的测试数要对、安装命令还在、引用的本地图片存在且会被发布。
   * @param {{ files: string[], tests: number, repo: string }} options
   */
  function readmesHonest({ files, tests, repo }) {
    for (const readme of files) {
      const body = text(readme);
      const stated = /#\s*(\d+)\s*(?:项，无任何依赖|tests, no dependencies)/.exec(body);
      if (expect(stated !== null, `${readme} 要在测试命令旁写明测试条数`)) {
        expect(Number(stated[1]) === tests, `${readme} 写的是 ${stated[1]} 项测试，实际声明了 ${tests} 项`);
      }
      expect(body.includes("dsh plugin --profile") && body.includes(`github:${repo}`), `${readme} 里的安装命令不见了`);
      for (const [, src] of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        if (/^(?:https?:|data:|\/)/.test(src)) continue;
        const relative = src.replace(/^\.\//, "");
        expect(exists(relative), `${readme} 引用的 ${relative} 不存在`);
        expect(shipped(relative), `${readme} 引用的 ${relative} 不在 files[] 里，发布包里会缺图`);
      }
    }
  }

  /** 收尾：有问题就全部列出并以 1 退出；否则打印一行通过信息。 */
  function finish(summary = "") {
    if (problems.length > 0) {
      console.error(`自检未通过（${problems.length} 项）：`);
      for (const problem of problems) console.error("  - " + problem);
      process.exit(1);
    }
    console.log("自检通过" + (summary ? `（${summary}）` : ""));
  }

  return {
    root, pkg, problems, exists, text, json, expect, shipped,
    packageBasics, exportsResolve, filesShip, patchRow, localeMeta, iconOk, countTests, changelogHead, readmesHonest, finish,
  };
}
