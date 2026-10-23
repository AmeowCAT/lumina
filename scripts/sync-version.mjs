#!/usr/bin/env node
// @ts-check
// 类型检查：tsconfig.node.json 的 allowJs + checkJs 覆盖 scripts/*.mjs，
// 随 `npm run check:types` 一起跑（审查 60-build-test §2.14）。
//
// 版本单一来源：package.json。
// `npm version <patch|minor|major|版本号>` 修改 package.json /
// package-lock.json 后、提交前会自动执行 package.json 的 "version" 钩子
// （本脚本），把新版本同步到：
//   - src-tauri/tauri.conf.json
//   - src-tauri/Cargo.toml
//   - src-tauri/Cargo.lock
// 脚本只替换锚点处的版本号字符串，不动其余字节（保留原换行与编码），
// 因此不会产生全文重写式的 diff 噪音。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * @param {string} rel 相对仓库根的路径
 * @returns {string}
 */
const read = (rel) => readFileSync(join(root, rel), "utf8");
/**
 * @param {string} rel 相对仓库根的路径
 * @param {string} text 完整文件内容
 * @returns {void}
 */
const write = (rel, text) => writeFileSync(join(root, rel), text, "utf8");

/** @type {{ version: string }} */
const pkg = JSON.parse(read("package.json"));
const { version } = pkg;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-version: package.json 版本号非法: "${version}"`);
  process.exit(1);
}

// 每个目标都用"锚点 + 任意旧版本号"的写法，只改 lumina 自己的版本字段，
// 绝不触碰依赖的版本号。
/**
 * @typedef {object} SyncTarget
 * @property {string} file 相对仓库根的文件路径
 * @property {RegExp} re 锚点 + 旧版本号的匹配式（不要求全局标记）
 */
/** @type {SyncTarget[]} */
const targets = [
  {
    file: "package-lock.json",
    // 根对象与 packages[""] 两处（name = "lumina" 紧邻 version）。
    re: /("name": "lumina",\s*"version": ")[^"]+"/g,
  },
  {
    file: "src-tauri/tauri.conf.json",
    // 该文件只有顶层一个 version 字段。
    re: /("version": ")[^"]+"/g,
  },
  {
    file: "src-tauri/Cargo.toml",
    re: /(\[package\]\r?\nname = "lumina"\r?\nversion = ")[^"]+"/,
  },
  {
    file: "src-tauri/Cargo.lock",
    re: /(name = "lumina"\r?\nversion = ")[^"]+"/,
  },
];

// 先全部校验、再统一写入：任一文件找不到锚点就整体失败，避免半同步。
/** @type {Array<SyncTarget & { text: string }>} */
const pending = [];
for (const t of targets) {
  const text = read(t.file);
  if (!t.re.test(text)) {
    console.error(`sync-version: ${t.file} 中找不到 lumina 版本锚点，已中止`);
    process.exit(1);
  }
  pending.push({ ...t, text });
}

for (const { file, re, text } of pending) {
  const next = text.replace(new RegExp(re.source, re.flags), `$1${version}"`);
  if (next !== text) {
    write(file, next);
    console.log(`sync-version: ${file} -> ${version}`);
  } else {
    console.log(`sync-version: ${file} 已是 ${version}`);
  }
}
