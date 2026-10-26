import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** 从源码里截出 `<name> = { ... }` 的对象字面量（只用于字典，不解析嵌套结构）。 */
function objectBody(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start > 0, `${name} 应该在 client.js 里`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 没有闭合`);
}

function entries(body) {
  const map = new Map();
  const pattern = /"([a-zA-Z][\w.]*)":\s*("(?:[^"\\]|\\.)*")/g;
  let hit = pattern.exec(body);
  while (hit) {
    map.set(hit[1], JSON.parse(hit[2]));
    hit = pattern.exec(body);
  }
  return map;
}

const zh = entries(objectBody("MESSAGES_ZH"));
const en = entries(objectBody("MESSAGES_EN"));

test("中英文字典键集合一致：少了哪条，哪边就会露出键名", () => {
  const missingInEn = [...zh.keys()].filter((key) => !en.has(key));
  const missingInZh = [...en.keys()].filter((key) => !zh.has(key));
  assert.deepEqual(missingInEn, [], "英文缺这些键：" + missingInEn.join(", "));
  assert.deepEqual(missingInZh, [], "中文缺这些键：" + missingInZh.join(", "));
});

test("没有空文案，也没有把 undefined 写进界面", () => {
  for (const [side, map] of [["zh", zh], ["en", en]]) {
    for (const [key, value] of map) {
      assert.ok(value.trim() !== "", `${side}.${key} 是空的`);
      assert.doesNotMatch(value, /undefined|null/, `${side}.${key} 写进了空值占位`);
    }
  }
});

test("中文文案里不夹着成句的英文", () => {
  const suspicious = [...zh.entries()].filter(([, value]) => /[A-Za-z]{4,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(value));
  assert.deepEqual(suspicious.map(([key]) => key), [], "这些中文键是英文句子：" + suspicious.map(([key]) => key).join(", "));
});
