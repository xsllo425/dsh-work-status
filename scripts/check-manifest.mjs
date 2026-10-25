/**
 * Pre-install self-check for this bundle.
 *
 * Verifies what the install and the Plugin Manager will actually read: the
 * manifest and its export map, the patch row, the translatable display
 * metadata, the icon's format/size, and the browser artifact's registration id.
 * Run with `node scripts/check-manifest.mjs` from the package root.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), "utf8"));

const manifest = readJson("package.json");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(manifest.name === "dsh-work-status", "name must be dsh-work-status");
check(/^\d+\.\d+\.\d+/.test(manifest.version), "version must be semver");
check(manifest.type === "module", "type must be module");
check(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch must point at cordis.patch.yml");
check(manifest.dsh?.client?.platform === "web", "dsh.client.platform must be web");
check(manifest.dsh?.client?.immediately === true, "dsh.client.immediately must be true");
check(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0, "dsh.client.inject must list the conversation package");

for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key.includes("*")) {
    check(existsSync(join(root, target.replace("*", "en"))), `export ${key} does not resolve`);
    continue;
  }
  check(existsSync(join(root, target)), `export ${key} -> ${target} does not exist`);
}

for (const entry of manifest.files ?? []) {
  if (entry.includes("*")) {
    const dir = dirname(entry);
    check(entry.endsWith("*.json") ? existsSync(join(root, dir, "en.json")) : true, `files entry ${entry} has no match`);
    continue;
  }
  check(existsSync(join(root, entry)), `files entry ${entry} does not exist`);
}

const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
check(patch.includes("- id: work-status"), "patch must insert the work-status row");
check(patch.includes("name: dsh-work-status"), "patch row must name the package");

for (const locale of ["en", "zh"]) {
  const dictionary = readJson(`locale/${locale}.json`);
  check(typeof dictionary.meta?.title === "string" && dictionary.meta.title.length > 0, `locale/${locale}.json meta.title missing`);
  check(typeof dictionary.meta?.description === "string" && dictionary.meta.description.length > 20, `locale/${locale}.json meta.description missing`);
}

const iconPath = join(root, "icon.svg");
check(existsSync(iconPath), "icon.svg is missing");
if (existsSync(iconPath)) {
  const icon = readFileSync(iconPath);
  const size = statSync(iconPath).size;
  check(size <= 256 * 1024, `icon is ${size} bytes, over the 256 KiB limit`);
  check(icon.subarray(0, 400).toString("utf8").includes("<svg"), "icon.svg does not start with an <svg> element");
  check(!/<image|<script|href="(?:https?:)?\/\//i.test(icon.toString("utf8")), "icon.svg must not embed raster images, scripts or remote URLs");
}

const client = readFileSync(join(root, "lib", "client.js"), "utf8");
check(client.includes('id: "dsh-work-status"'), "client.js must register the factory under the package name");
check(client.includes("__ModuleLoader__.load"), "client.js must use the module loader");
check(!/require\(["']@deepseek-ai\//.test(client), "client.js must not import Harness Client packages");
check(!/document\.body|createPortal/.test(client), "client.js must not render outside its own subtree");
check(/conversation\.input\.dock/.test(client), "client.js must target the input dock slot");

const host = readFileSync(join(root, "lib", "index.js"), "utf8");
check(/export function apply\(/.test(host), "host half must export an apply function");
check(/export const inject = \["sessionProjections"\]/.test(host), "host half must inject sessionProjections");
check(!/export default/.test(host), "host half must not mix export forms");

if (failures.length > 0) {
  console.error(`manifest check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("manifest check passed");
