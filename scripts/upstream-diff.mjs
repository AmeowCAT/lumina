#!/usr/bin/env node
// @ts-check
// 类型检查：tsconfig.node.json 的 allowJs + checkJs 覆盖 scripts/*.mjs，
// 随 `npm run check:types` 一起跑（审查 60-build-test §2.14）。
//
// 上游漂移检测（审查 99-final-report §5.2）。
//
// Lumina 的维护成本几乎全部来自「跟随上游」：CLI 参数、`/sdcpp/v1` 请求体字段、
// 模型家族。上游 README 自己写着 "API and command-line option may change
// frequently"。这个脚本把「这版同步漏了什么」从靠记忆变成一条命令。
//
// 两种模式：
//   node scripts/upstream-diff.mjs                 # 漂移：README 里声明的对齐提交 → 上游 master
//   node scripts/upstream-diff.mjs --coverage      # 覆盖：上游请求体字段是否在本仓库出现过
//
// 选项：
//   --ref <sha|branch>     目标基准，默认 master
//   --since <sha|branch>   起点，默认从 README 的「当前对齐上游 master @ `<sha>`」解析
//   --upstream <dir>       读本地克隆（离线；需要该目录是 git 仓库才能取 --since）
//   --strict               发现问题时 exit 1（可挂 CI）
//
// 漂移模式的判据是**上游两个提交之间的差集**，因此不会把「sd-cli 才用的生成期
// 参数」误报成启动参数缺口；覆盖模式才逐个字段问「本仓库提过这个名字吗」。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 脚本参数（已去掉 node 与脚本路径本身） @type {string[]} */
const argv = process.argv.slice(2);
/**
 * 取 `--name value` 形式选项的值。
 * @param {string} name
 * @returns {string | undefined}
 */
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
/**
 * @param {string} name
 * @returns {boolean}
 */
const has = (name) => argv.includes(name);
const ref = flag("--ref") || "master";
const upstreamDir = flag("--upstream");
const strict = has("--strict");
const coverageOnly = has("--coverage");

const FILES = {
  common: "examples/common/common.cpp",
  runtime: "examples/server/runtime.cpp",
  cli: "examples/cli/main.cpp",
};

/**
 * 去重 + 排序（输出稳定，便于 diff 两次运行结果）。
 * @template T
 * @param {T[]} xs
 * @returns {T[]}
 */
const uniq = (xs) => [...new Set(xs)].sort();

/**
 * 已确认「上游接受但本界面故意不接」的请求体字段：覆盖模式把它们当作信息输出，
 * 不算缺口。新增条目必须写清理由，否则下一个人无法判断是漏了还是有意为之。
 * 类型显式写成 Record：脚本里以动态字段名 `k` 索引（`KNOWN_UNSUPPORTED[k]`），
 * 没有索引签名会被 TS 判为隐式 any。
 * @type {Record<string, string>}
 */
const KNOWN_UNSUPPORTED = {
  ad_model: "ADetailer 只在 sd-cli 的 -M adetailer 通道可用，/sdcpp/v1 不消费（README 已知限制）",
  ad_prompt: "同上",
  ad_negative_prompt: "同上",
  extra_ad_args: "同上",
  upscale_repeats: "img_gen 的二次放大重复次数，界面未暴露；内核默认 1",
};
/**
 * @param {string} text
 * @returns {string[]}
 */
const extractArgs = (text) =>
  uniq([...text.matchAll(/"(--[a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]));
/**
 * @param {string} text
 * @returns {string[]}
 */
const extractJsonKeys = (text) =>
  uniq([...text.matchAll(/load_if_exists\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/**
 * 读上游某个提交上的文件：本地克隆用 git show，否则走 raw.githubusercontent。
 * @param {string} path 上游仓库内的相对路径
 * @param {string} revision 提交/分支
 * @returns {Promise<string>}
 */
async function upstreamFile(path, revision) {
  if (upstreamDir) {
    return execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: upstreamDir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  const url = `https://raw.githubusercontent.com/leejet/stable-diffusion.cpp/${revision}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`拉取上游失败 ${res.status}: ${url}`);
  return res.text();
}

/**
 * README 里声明的「当前对齐上游」提交。
 * @returns {string | undefined}
 */
function syncedRef() {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  return /当前对齐上游 `master` @ \[`([0-9a-f]{7,40})`\]/.exec(readme)?.[1];
}

/**
 * 本仓库前端 + Rust 源码的合并文本，用于覆盖模式判断。
 * @returns {string}
 */
function repoTokens() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if ([".ts", ".tsx", ".rs"].includes(extname(name)))
        out.push(readFileSync(full, "utf8"));
    }
  };
  if (existsSync(join(ROOT, "src"))) walk(join(ROOT, "src"));
  if (existsSync(join(ROOT, "src-tauri/src"))) walk(join(ROOT, "src-tauri/src"));
  return out.join("\n");
}

/**
 * @param {string} title
 * @param {string[]} items
 * @param {string} [hint]
 * @returns {boolean} 是否发现条目
 */
function report(title, items, hint) {
  if (!items.length) return false;
  console.log(`\n⚠ ${title}（${items.length}）`);
  for (const item of items) console.log(`  ${item}`);
  if (hint) console.log(`  → ${hint}`);
  return true;
}

/** @returns {Promise<number>} 进程退出码 */
async function drift() {
  const since = flag("--since") || syncedRef();
  if (!since) {
    console.error("✗ 无法确定起点：README 里没有「当前对齐上游 master @ `<sha>`」，请用 --since 指定。");
    return 2;
  }
  const [oldCommon, oldRuntime, oldCli, newCommon, newRuntime, newCli] = await Promise.all([
    upstreamFile(FILES.common, since),
    upstreamFile(FILES.runtime, since),
    upstreamFile(FILES.cli, since),
    upstreamFile(FILES.common, ref),
    upstreamFile(FILES.runtime, ref),
    upstreamFile(FILES.cli, ref),
  ]);

  const oldArgs = new Set([...extractArgs(oldCommon), ...extractArgs(oldRuntime)]);
  const newArgs = new Set([...extractArgs(newCommon), ...extractArgs(newRuntime)]);
  const cliOnlyOld = new Set(extractArgs(oldCli));
  const cliOnlyNew = new Set(extractArgs(newCli));
  const addedArgs = [...newArgs].filter((a) => !oldArgs.has(a) && !cliOnlyNew.has(a));
  const removedArgs = [...oldArgs].filter((a) => !newArgs.has(a) && !cliOnlyOld.has(a));

  const oldKeys = new Set(extractJsonKeys(oldCommon));
  const newKeys = new Set(extractJsonKeys(newCommon));
  const addedKeys = [...newKeys].filter((k) => !oldKeys.has(k));
  const removedKeys = [...oldKeys].filter((k) => !newKeys.has(k));

  console.log(`上游基准：${since} → ${ref}${upstreamDir ? `（本地 ${upstreamDir}）` : ""}`);
  const findings = [
    report(
      "上游新增的启动参数",
      addedArgs,
      "逐个判断：给控件 / 写进「附加启动参数」说明 / 明确不支持（见 docs/UPSTREAM-SYNC.md）。"
    ),
    report("上游删除/改名的启动参数", removedArgs, "本仓库若还在发这些参数，需要同步改名或移除。"),
    report("上游新增的请求体字段", addedKeys, "接进 types.ts + buildRequestBody，或确认不适用于本界面。"),
    report("上游删除/改名的请求体字段", removedKeys, "检查 types.ts 是否仍在发送。"),
  ];
  const any = findings.some(Boolean);
  if (!any) console.log("\n✓ 两个提交之间没有参数/字段增删。");
  return any ? (strict ? 1 : 0) : 0;
}

/** @returns {Promise<number>} 进程退出码 */
async function coverage() {
  const common = await upstreamFile(FILES.common, ref);
  const keys = extractJsonKeys(common);
  const repo = repoTokens();
  const unreferenced = keys.filter((k) => !repo.includes(k));
  const known = unreferenced.filter((k) => k in KNOWN_UNSUPPORTED);
  const missing = unreferenced.filter((k) => !(k in KNOWN_UNSUPPORTED));
  console.log(`上游基准：${ref}；from_json_str 接受的请求体字段 ${keys.length} 个`);
  if (known.length) {
    console.log(`\nℹ 已登记为「有意不接」的字段（${known.length}）：`);
    for (const k of known) console.log(`  ${k} — ${KNOWN_UNSUPPORTED[k]}`);
  }
  const any = report(
    "上游接受、本仓库源码里完全没提到的请求体字段",
    missing,
    "出现即说明该字段在 Lumina 里没有落点（既没发也没注释）；确认后补实现或登记到 KNOWN_UNSUPPORTED。"
  );
  if (!any) console.log(`\n✓ 未覆盖字段都已登记（${keys.length} 个字段全部有落点或已说明）。`);
  return any ? (strict ? 1 : 0) : 0;
}

// 退出码只写 process.exitCode，不调 process.exit()：Windows + Node 24 上
// `process.exit()` 与 undici(fetch) 的收尾竞态会触发 libuv 断言
// `!(handle->flags & UV_HANDLE_CLOSING)`（src/win/async.c:76），进程以
// 0xC0000409 崩溃——输出已经打完了，退出码却是垃圾值，挂 --strict 的 CI 判读
// 会失真。写 exitCode 让事件循环自然收敛即可（代价是 keep-alive 连接最多多等
// 几秒）。审查 60-build-test §2.14。
(coverageOnly ? coverage() : drift())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(String(e?.message || e));
    console.error("提示：离线环境用 --upstream <本地 stable-diffusion.cpp 克隆路径>；漂移模式需要该克隆有 --since 对应的提交。");
    process.exitCode = 2;
  });
