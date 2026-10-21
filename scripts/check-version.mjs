#!/usr/bin/env node
// @ts-check
// 类型检查：tsconfig.node.json 开了 allowJs + checkJs，本文件随
// `npm run check:types` 一起检查（审查 60-build-test §2.14）。
//
// 版本号一致性检查（审查 60-build-test §2.1/§2.2）。
//
// 版本号以 package.json 为唯一来源，`npm version` 的 version 钩子会通过
// scripts/sync-version.mjs 同步到 tauri.conf.json / Cargo.toml / Cargo.lock。
// 但 npm 的 git 集成只会 `git add` package.json 与 lock 文件，Rust 侧三个文件
// 留在工作区；手工提交时漏 add 就会让「安装包版本 ≠ 源码版本」。这个脚本把
// 不一致变成构建期硬失败。
//
// 用法：
//   node scripts/check-version.mjs            # 只校验
//   node scripts/check-version.mjs --release  # 额外要求当前版本有对应 git tag

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * package.json 里本脚本真正读取的字段。JSON.parse 返回 any，这里用 JSDoc
 * 收窄：属性名写错（`packageJson.devDependencys`）会变成类型错误而不是
 * 运行时静默 `undefined`。
 * @typedef {object} PackageJson
 * @property {string} version
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 */

/** @typedef {{ version: string }} TauriConf */

/** package-lock.json 只需根级 version（npm 与清单同步）。 @typedef {{ version: string }} NpmLock */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * @param {string} rel 相对仓库根的路径
 * @returns {string}
 */
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** @type {PackageJson} */
const packageJson = JSON.parse(read("package.json"));
const expected = packageJson.version;

/** @type {Array<[file: string, version: string | undefined]>} */
const found = [];

/** @type {TauriConf} */
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));
found.push(["src-tauri/tauri.conf.json", tauriConf.version]);

const cargoToml = read("src-tauri/Cargo.toml");
const cargoVersion = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
found.push(["src-tauri/Cargo.toml", cargoVersion]);

const cargoLock = read("src-tauri/Cargo.lock");
const lockBlock = /^name\s*=\s*"lumina"\s*$/m.exec(cargoLock);
const lockVersion = lockBlock
  ? /^version\s*=\s*"([^"]+)"/m.exec(cargoLock.slice(lockBlock.index))?.[1]
  : undefined;
found.push(["src-tauri/Cargo.lock", lockVersion]);

// package-lock.json 也带项目版本。npm 自己会同步，但手改 package.json 后容易
// 忘：这里一并校验，避免 lockfile 与清单漂移（root 与 packages[""] 两处由 npm
// 保持一致，只查一处即可）。
/** @type {NpmLock} */
const npmLock = JSON.parse(read("package-lock.json"));
found.push(["package-lock.json", npmLock.version]);

let failed = false;
for (const [file, version] of found) {
  if (version === expected) continue;
  failed = true;
  console.error(`✗ 版本不一致：package.json=${expected}，${file}=${version ?? "（未找到）"}`);
}

// Tauri 的 npm 包与 Rust crate 必须 major.minor 对齐，否则 `tauri build` 直接
// abort（实测：`npm update` 把 @tauri-apps/api 升到 2.12 而 crate 停在 2.11）。
// 这是一条纯字符串检查，放在这里比等打包时才发现便宜得多。
/**
 * 从 Cargo.lock 取某个 crate 的版本。
 * @param {string} name crate 名
 * @returns {string | undefined}
 */
const crateVersion = (name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^name\\s*=\\s*"${escaped}"\\s*$`, "m").exec(cargoLock);
  return block ? /^version\s*=\s*"([^"]+)"/m.exec(cargoLock.slice(block.index))?.[1] : undefined;
};
/**
 * @param {string | undefined} v
 * @returns {string | undefined}
 */
const minor = (v) => (v ? v.split(".").slice(0, 2).join(".") : undefined);
/** @type {Array<[npmName: string, crateName: string]>} */
const tauriPairs = [
  ["@tauri-apps/api", "tauri"],
  ["@tauri-apps/cli", "tauri"],
  ["@tauri-apps/plugin-notification", "tauri-plugin-notification"],
];
for (const [npmName, crateName] of tauriPairs) {
  const npmVersion = packageJson.dependencies?.[npmName] ?? packageJson.devDependencies?.[npmName];
  // 精确版本（无 ^ ~ 之类）才能直接比较；带范围时只提示不判失败。
  const pinned = npmVersion && /^\d+\.\d+\.\d+/.test(npmVersion);
  const crate = crateVersion(crateName);
  if (!pinned || !crate) continue;
  if (minor(npmVersion) === minor(crate)) continue;
  failed = true;
  console.error(
    `✗ Tauri 版本不匹配：${npmName}=${npmVersion} 与 Rust crate ${crateName}=${crate} 的 major.minor 不一致，tauri build 会直接失败。`,
  );
}

if (!failed) {
  // 处数由实际检查清单推导，避免"写死 5 处、只列 4 个文件"这类文案漂移。
  const checked = ["package.json", ...found.map(([file]) => file)];
  console.log(
    `✓ 版本号一致：${expected}（${checked.length} 处：${checked.join(" / ")}）；Tauri npm/crate 主次版本匹配`,
  );
}

if (process.argv.includes("--release") && !failed) {
  const tag = `v${expected}`;
  let hasTag = false;
  try {
    execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      cwd: root,
      stdio: "ignore",
    });
    hasTag = true;
  } catch {
    hasTag = false;
  }
  if (!hasTag) {
    failed = true;
    console.error(
      `✗ 发布前缺少 git tag：${tag}（发布物无法溯源到提交，请先 git tag -a ${tag} -m "Lumina ${expected}"）`,
    );
  }
}

process.exit(failed ? 1 : 0);
