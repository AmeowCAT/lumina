# 构建 / 依赖 / 测试 / 发布 / 文档治理 审查报告

> 审查对象：`D:\Project\AmeowCAT\lumina`（git `master`，HEAD `d442371`，`0.8.6`）
> 审查节点：2026-10-18，Node `v24.13.0` / npm `11.6.2`
> 原则：只读源码与配置；所有命令为只读或仅写 `dist/`（已 gitignore）。未修改任何源码、配置、`package.json`。

## 0. 结论摘要

1. **P0/P1 = 0**：`npx tsc --noEmit` 零输出零错误，`npm test` 34 文件 363 用例全通过（21.98s），`npm run build` 成功（2357 模块 / 1.23s）。构建与测试链路本身是健康的。
2. **P2**：`.npmrc` 建议的 `npm version --git-tag-version` 会让 tag 只覆盖 `package.json`（npm 内部行为，见 2.1），从 tag 构建的安装包版本号会回退——这是唯一可自动化的版本同步路径上的陷阱。
3. **P2**：当前 `0.8.6` **没有 git tag**（`v0.7.19`…`v0.8.5` 都有），`git describe` 仍是 `v0.8.5-3-gd442371`，发布的 MSI/NSIS 无法溯源到提交。
4. **P2**：`npm ls --all` 实测 1 个 `UNMET DEPENDENCY @emnapi/runtime@^1.7.1` + 4 个 `extraneous`；`package-lock.json` 有手工补写历史（`ab2d5ea`），说明「干净环境 `npm ci`」从未被验证。
5. **P2**：`src/api.ts` 的 23 个 `invoke("命令名")` 与 Rust 侧命令签名是纯手写字符串，7 个测试文件把整个 `api` 模块 mock 掉 → TS↔Rust 接缝零覆盖。
6. **P2**：发布链路无代码签名、无 updater 插件、安装包内无任何 `LICENSE`/归属文件（字体是 OFL-1.1）。
7. **P3**：`codeSplitting.groups` **确认生效**（三个 vendor chunk 按配置名产出），最大 chunk 145.72 kB，远低于 500 kB 警告线；首屏预加载 566 kB raw / 181 kB gzip。
8. **P3**：25 个直接依赖**全部**真被 import，无未使用项；`clsx`+`tailwind-merge` 职责不重；只用了统一的 `radix-ui`，无 `@radix-ui/*` 混用。
9. **P3**：4 个已知漏洞（2 high / 2 moderate）全部落在 dev/build 链，`npm audit --omit=dev` 为 0；均在声明范围内可直接修。
10. **P3**：文档抽查 10 条具体论断，9 条完全一致、1 条不一致（家族数 `58` vs 实际 `60`，且 README 家族清单漏 `LLaDA-Image` 与 `SenseNova U1.5`）。

## 1. 审查范围与方法

**静态阅读**：`package.json`、`package-lock.json`（`lockfileVersion: 3`，277 个包）、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`scripts/sync-version.mjs`、`.npmrc`、`.nvmrc`、`.gitignore`、`.gitattributes`、`build-release.log`、`src-tauri/tauri.conf.json`、`src-tauri/build.rs`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/capabilities/default.json`、`README.md`、`index.html`、`src/test/setup.ts`、`src/api.ts`、`src/main.tsx`。

**实测命令**（npm/npx/vitest/vite 归本组独享）：`npx tsc --noEmit`、`npm test`、`npm run build`、`npm ls --depth=0`、`npm ls --all`、`npm outdated`、`npm audit --json`、`npm audit --omit=dev --json`、`node scripts/sync-version.mjs`（幂等验证，前后哈希比对）、两个只读探针脚本（家族计数、许可统计，见 §5）。

**刻意未执行**：`cargo` 系列（归 backend-rust）、`npm run tauri build`（按要求，耗时且写 `src-tauri/target`）、`npm update` / `npm audit fix`（按要求不修）、`npm ci`（会删改 `node_modules`，可能影响并行小组；改为用 `npm ls --all` 推断一致性）。

**证据规则**：每条结论给出 `文件:行号` 或命令输出；无法实测的放 §3「待验证假设」。

## 2. 问题清单

### 2.1 `.npmrc` 建议的 `--git-tag-version` 会打出「版本脱同步」的 tag

- 级别：**P2**
- 位置：`.npmrc:1-3`、`package.json:15`、`scripts/sync-version.mjs:27-46`
- 现状：

  ```ini
  # .npmrc:1-3
  # npm version 默认只改版本文件，不自动 commit / 打 tag。
  # 需要自动提交时可用 `npm version patch --git-tag-version` 覆盖。
  git-tag-version=false
  ```

  ```json
  // package.json:15
  "version": "node scripts/sync-version.mjs",
  ```

- 问题：`sync-version.mjs` 在 `version` 生命周期里同步 `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`（`sync-version.mjs:29-45`），但 npm 自己的 git 集成**只 add 两个文件**。实测本机 npm 11.6.2 的内部实现：

  ```
  C:\Program Files\nodejs\node_modules\npm\node_modules\libnpmversion\lib\version.js
  :59   const doGit = gitTagVersion && isGitDir && await enforceClean(opts)
  :97   await runScript({ ... event: 'version' ... })        // ← 这里跑 sync-version
  :110  // - git add, git commit, git tag
  :112  await git.spawn(['add', `${path}/package.json`], opts)
  :114  for (const lock of haveLocks) { await git.spawn(['add', lock], opts) }
  :116  await commit(newV, opts)
  :117  await tag(newV, opts)
  ```

  即：一旦开发者照 `.npmrc:2` 的建议加 `--git-tag-version`，`v0.8.7` 这个 tag 指向的提交里 `tauri.conf.json:4`、`Cargo.toml:3`、`Cargo.lock:2257` **仍是 0.8.6**（它们被脚本改过但没被 `git add`）。用该 tag 出包时，`productName`/安装包文件名/「关于」显示的版本会全部回退到旧值，且 `src-tauri` 的 crate 版本与 `package.json` 不一致。
  另一条脱同步路径更常见：`git-tag-version=false` 时 npm **不做 commit 也不做 tag**，三个 Rust 文件留在工作区；若开发者用 `git commit -m ...`（不带 `-a`、不逐文件 add），版本文件只提交一半。

- 上游/对照依据：npm 官方 `npm-version` 文档「The commit contains only `package.json`, `package-lock.json`, and `npm-shrinkwrap.json`」；实现见上引 `libnpmversion/lib/version.js:110-117`。
- 建议（最小改动，不需要碰 Rust）：
  1. 把 `.npmrc:2` 那句建议删掉，换成「`npm version` 之后必须 `git add -A` 或逐文件 add 这 5 个文件，再手工 `git tag v<ver>`」；
  2. 增加 `"postversion": "git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock"`——在 `git-tag-version=false` 下这是无害的（npm 不 commit），但能让随后的 `git commit -m …` 顺带带上三个文件；
  3. 新增 `scripts/check-version.mjs`（比对 5 处版本号，不等则 `exit 1`），挂到 `"build"` 前面：`"build": "node scripts/check-version.mjs && tsc && vite build"`。这样即使有人手改 `tauri.conf.json` 也会在构建时立刻失败。

### 2.2 当前版本 `0.8.6` 没有 tag，发布物不可溯源

- 级别：**P2**
- 位置：git refs；`README.md:17`、`README.md:124`
- 现状（实测）：

  ```
  $ git tag -l
  v0.7.19 v0.7.20 v0.8.0 v0.8.1 v0.8.2 v0.8.3 v0.8.4 v0.8.5
  $ git describe --tags --always
  v0.8.5-3-gd442371
  ```

- 问题：`README.md:17` 让用户「从 Releases 下载 MSI 或 NSIS」，但 0.8.6 没有对应 tag。后果具体：用户报 bug 时无法说清跑的是哪份代码；`git checkout v0.8.6` 复现不了；`v0.8.5-3-gd442371` 这种描述对用户无意义。历史上 tag 总打在「把版本号 bump 上去」的那个提交上（实测 `v0.8.1→a11576b`、`v0.8.2→ccc5e83`、`v0.8.3→7435ed1` 是纯 bump 提交，`v0.8.4→4abe86a`、`v0.8.5→bdf7e8e` 是「功能 + (v0.8.x)」的合并提交），而 `d442371 feat: 同步上游 f0aac52 的 GUI 适配并升级到 v0.8.6` 与该模式完全一致却漏了 tag——说明打 tag 是纯手工动作，没有任何检查。另外这 8 个 tag 全是**轻量标签**（`git cat-file -t` 返回 `commit` 而非 `tag`），没有标注日期/发布说明，`git describe` 语义弱于 annotated tag。
- 上游/对照依据：同仓库 `v0.7.19`…`v0.8.5` 共 8 个 tag，唯独当前版本缺失，属流程遗漏而非有意取舍（`README.md:124` 只声明「没有 CI」，没说「不打 tag」）。
- 建议：在发布脚本/发布说明里加一行 `git tag -a v$(node -p "require('./package.json').version") -m "Lumina $(node -p "require('./package.json').version")"`；或让 `scripts/check-version.mjs`（见 2.1）在 `--release` 模式下额外断言 `git rev-parse -q --verify refs/tags/v<ver>` 存在。

### 2.3 已安装依赖树与 lockfile 不一致：1 个 UNMET + 4 个 extraneous，且 lockfile 有手改历史

- 级别：**P2**
- 位置：`package-lock.json`、commit `ab2d5ea`
- 现状（实测）：

  ```
  $ npm ls --depth=0
  +-- @emnapi/core@1.11.3 extraneous
  +-- @emnapi/wasi-threads@1.2.2 extraneous
  +-- @napi-rs/wasm-runtime@1.1.6 extraneous
  +-- @tybys/wasm-util@0.10.3 extraneous
  （其余 21 个直接依赖正常，无 invalid / UNMET）

  $ npm ls --all   (920 行输出中的问题行)
  +-- @napi-rs/wasm-runtime@1.1.6 extraneous
  | +-- UNMET DEPENDENCY @emnapi/runtime@^1.7.1
  ```

  而 lockfile 里这 5 个包都登记着：`@emnapi/runtime v1.11.3 (optional=true, dev=true)`、`@emnapi/core`、`@napi-rs/wasm-runtime`、`@tybys/wasm-util`；但 `node_modules/@emnapi/runtime` **实际不存在**（`Test-Path` 为 false），另 4 个存在。

- 问题：这些是 `@rolldown/binding-wasm32-wasi` / `@tailwindcss/oxide-wasm32-wasi` 的 wasm32-wasi 可选回退，在 win32-x64 上本应**整组都不安装**；现在是「装了 4 个、缺 1 个」，只能说明 `node_modules` 不是由当前 lockfile `npm ci` 出来的。根因有直接证据：`ab2d5ea chore: 补齐 package-lock.json 缺失的 @emnapi/runtime` 是一个**只改 `package-lock.json` 的提交**（`package-lock.json | 103 ++++…`，+92/−11），即 lockfile 被手工编辑过——手写条目无法由 npm 再生，下次 `npm install` 可能又改回去或报 `EUSAGE`。再加上没有 CI（2.4），「干净机器能否装上」这件事从未被验证。
- 上游/对照依据：npm 官方要求 lockfile 只由 npm 生成、并用 `npm ci` 在 CI 中校验；`npm ci` 会在 lock 与 `package.json` 不一致时直接失败，正是为防这类漂移。
- 建议：删除 `node_modules/` 与 `package-lock.json`，重新 `npm install` 并提交生成结果（预期这 5 个包在 win32-x64 上只剩 lock 里的 optional 记录、`node_modules` 里一个都不装）；随后加 CI 跑 `npm ci`（见 2.4）作为长期护栏。

### 2.4 无 CI：tsc / vitest / lockfile / 漏洞 / tag 全部只靠本机自觉

- 级别：**P2**
- 位置：仓库根（无 `.github/`，实测 `NO .github directory`）；`README.md:124`
- 现状：`package.json:10-18` 只有 `dev/build/preview/tauri/version/test/test:watch` 七个脚本，没有任何 `ci`/`lint`/`check` 可复用的门禁组合；仓库里没有 workflow 文件。
- 问题：`README.md:124` 把「没有 CI」写成自觉取舍，但它在本仓库的具体代价不是抽象的——本次审查发现的每一条都只能靠人肉发现：
  - 2.3 的 lockfile 漂移（`npm ci` 会失败）；
  - 2.2 的 tag 缺失；
  - 2.9 的 4 个已知漏洞（`npm audit` 从未跑过）；
  - 2.10 的 19 个依赖落后；
  - `npx tsc --noEmit` 与 363 个测试在任何提交上都没有记录可查。
    另一层：项目分发 AGPL 二进制并从 Releases 发布，没有可复现的构建记录（谁在哪台机器上用哪个 Node 版本出的包，无从查证）。
- 上游/对照依据：同类 Tauri 客户端（如各类 sd.cpp / ComfyUI 包装器）普遍用 `tauri-apps/tauri-action` + `ubuntu-latest` 跑 `npm ci && npx tsc --noEmit && npm test`，成本约 3 分钟。
- 建议（最小可用 CI，3 个 job 合成一个）：
  ```yaml
  # .github/workflows/ci.yml
  on: [push, pull_request]
  jobs:
    check:
      runs-on: windows-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version-file: .nvmrc, cache: npm }
        - run: npm ci
        - run: npx tsc --noEmit
        - run: npm test
  ```
  再加一个 `ubuntu-latest` 的 `cargo test`（归 backend-rust 组）与一个 `npm audit --omit=dev` 步骤即可覆盖本次发现的全部类别。

### 2.5 TS↔Rust 接缝零覆盖：23 个 Tauri 命令全是手写字符串，测试把整个 `api` mock 掉

- 级别：**P2**
- 位置：`src/api.ts:20`（`export const api = {`），共 23 个 `invoke<...>("...")`；测试侧 7 处 `vi.mock`
- 现状：

  ```ts
  // src/api.ts:21-34
  startServer: (exePath, modelName, mode, args, port) =>
    invoke<{ pid: number; sdPort: number }>("start_server", {
      exePath, modelName, mode, args, port,
    }),
  ```

  ```
  src/hooks/__tests__/useModelSwitch.test.ts:11     vi.mock("../../api", () => ({ api: mocks }));
  src/components/dashboard/__tests__/Dashboard.test.tsx:20   vi.mock("../../../api", () => ({ api: mocks }));
  src/hooks/__tests__/useJobPolling.test.ts:7        vi.mock("../../api", () => ({ api: mocks }));
  src/components/dashboard/__tests__/CliCompatibility.test.tsx:7、GenerationUpscale.test.tsx:13、HistoryGallery.test.tsx:23、GenerationUI.test.tsx:11
  ```

- 问题：`invoke("start_server", { exePath, ... })` 的两个要素——命令名与参数键名——都是普通字符串，`tsc` 看不见；7 个交互测试全部把 `api` 换成 `vi.fn()`，所以命令名写错、Rust 侧 `#[tauri::command]` 改名、参数键改名（Tauri 的 camelCase↔snake_case 自动转换依赖名字本身）、返回结构变化，**tsc 绿、363 个测试全绿**，只有真正启动应用点一次才发现。这正是简报 §3.2 说的「同一事实两处手写」的典型，而且是本项目**唯一**没有任何自动化保护的一处接缝（家族识别已收敛到 `family.rs`，但命令面没有）。
- 上游/对照依据：`src/api.ts:16-19` 的注释自己承认这层是「Typed wrappers around Tauri commands」，类型只在 TS 侧自洽；`Cargo.toml:15-31` 没有 `tauri-specta` 之类的绑定生成器，因此不存在单一事实源。
- 建议（两档，都不大）：
  - 便宜档：在 `src/__tests__/apiContract.test.ts` 里用 `fs.readFileSync("src/api.ts")` 正则抽出全部 `invoke<...>("xxx")` 命令名，与一份硬编码快照比对（快照变更必须显式批准）；Rust 侧对 `tauri::generate_handler![...]` 列表做同样快照——两侧快照对不上就是改名了。
  - 彻底档：引入 `tauri-specta` 生成 `bindings.ts`，`api.ts` 直接引用生成类型（改动涉及 `src-tauri/src/lib.rs` + 新增构建步骤，归 backend-rust 配合）。

### 2.6 发布链路：无签名、无 updater、安装包内无许可文件

- 级别：**P2**
- 位置：`src-tauri/tauri.conf.json:31-40`、`src-tauri/Cargo.toml:15-19`；`src/styles.css:7-8`
- 现状：

  ```json
  // tauri.conf.json:31-40 —— bundle 段全部内容
  "bundle": { "active": true, "targets": "all",
              "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico"] }
  ```

  `Cargo.toml:16-19` 的插件只有 `tauri-plugin-window-state` / `single-instance` / `notification`，**没有** `tauri-plugin-updater`；`tauri.conf.json` 里没有 `plugins.updater`、没有 `bundle.windows.certificateThumbprint`/`signCommand`、没有 `publisher`/`copyright`。`dist/` 实测 26 个文件（12 个 woff2 + 12 个 `assets/*.js|css` + `favicon.svg` + `index.html`）里**没有任何** `LICENSE`/`NOTICE`/`OFL` 文件。

- 问题（三件事，都影响「从 Releases 下载安装包」这个唯一分发路径）：
  1. **无签名**：Windows 上 SmartScreen 会显示「未知发布者」，用户需要点「仍要运行」；`publisher`/`copyright` 缺失进一步让控制面板与 MSI 属性里的发布者信息为空。
  2. **无 updater / 无更新提示**：`build-release.log:47-53` 证明实际产出过 `Lumina_0.8.0_x64_en-US.msi` 与 `Lumina_0.8.0_x64-setup.exe`，而 0.8.0→0.8.6 已经过六轮迭代；用户装的是哪个版本只能自己回 GitHub 看。`README.md:124` 只说了「发布包是本地构建的」，没有把「无自动更新」列为已知限制，所以这是缺口而非取舍。
  3. **许可合规**：`src/styles.css:7-8` 用 `@import "@fontsource-variable/inter"` / `jetbrains-mono` 把字体打进 `dist`，这两个包是 **OFL-1.1**（`node_modules/@fontsource-variable/inter/package.json` `"license": "OFL-1.1"`），OFL-1.1 §1 要求随字体软件一并分发许可证文本；当前安装包里既没有 OFL 文本，也没有项目自己的 AGPL 文本（AGPL 虽已在仓库公开，但二进制分发时随包附许可更稳妥）。
- 上游/对照依据：Tauri v2 官方 `updater` 插件 + `bundle.createUpdaterArtifacts`，需要一个 minisign 密钥对与 `latest.json`；代码签名走 `bundle.windows.signCommand` 或 `certificateThumbprint`。
- 建议（按成本递增）：
  1. 立刻可做：`bundle.publisher`/`copyright`/`shortDescription` 补齐，`bundle.resources` 放入 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`（后者列出 OFL 字体与 MIT/Apache 依赖，可用 `license-checker` 生成）；
  2. 中期：`tauri-plugin-updater` + `createUpdaterArtifacts: true`，`endpoints` 指向 GitHub Releases 的 `latest.json`；
  3. 有条件时：代码签名证书（或至少提供 SHA256 校验值，README 发布说明里贴出 `Get-FileHash` 结果，成本近乎为零）。

### 2.7 无 lint / 格式化 / 编辑器配置，且已出现可见漂移

- 级别：**P3**
- 位置：仓库根（`.eslintrc*`、`eslint.config.*`、`.prettierrc*`、`.editorconfig`、`rustfmt.toml`、`clippy.toml`、`.vscode/` 全部实测 `MISSING`）
- 现状与证据：
  - **缩进漂移**：`src/components/dashboard/__tests__/Dashboard.test.tsx` 是唯一一个 tab 与空格混用的文件（62 行以 tab 开头、511 行以空格开头，全库 95 个 ts/tsx 里仅此一例）。
  - **未被任何工具捕获的重复赋值**：`src/hooks/useKeyboardShortcuts.ts:14-15`
    ```ts
    escRef.current = handlers.onEscape;
    escRef.current = handlers.onEscape;
    ```
    `tsc` 不报（`noUnusedLocals` 不管重复赋值），363 个测试也不报。
  - **`globals` 与类型系统不对齐**：`vitest.config.ts:8` `globals: true`，但 `tsconfig.json` 没有 `"types"` 字段（全文 21 行无 `types`）。当前 34 个测试文件**全部**显式 `import { describe, it, expect } from "vitest"`（实测 0 个遗漏），所以没爆；但下一个人按 `globals: true` 的暗示写 `describe(...)` 而省略 import，`npm test` 通过、`npx tsc --noEmit`（也就是 `npm run build` 的第一步）失败。
- 问题：本项目唯一的自动化门禁是 `tsc` + `vitest`，两者都看不见格式、看不见「配置与用法不一致」、看不见 hooks 依赖数组。结合 2.2/2.3 的手工提交习惯，格式与风格漂移没有任何刹车。
- 上游/对照依据：Tauri 官方模板自带 `eslint` + `prettier` 配置；React 生态里 `eslint-plugin-react-hooks` 的 `exhaustive-deps` 是本项目最相关的规则（大量 `useEffect` + `useRef` 镜像写法，如 `useKeyboardShortcuts.ts:17-31`）。
- 建议：`npm i -D eslint typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh prettier`，加 `eslint.config.mjs` + `.prettierrc` + `.editorconfig`，脚本 `"lint": "eslint . && prettier --check ."`，并把 `lint` 放进 CI（2.4）。**不要**先全库 `prettier --write` 再提交（会产生巨大 diff）；先只对新增/改动文件生效。

### 2.8 缺 CONTRIBUTING / SECURITY / CHANGELOG / issue 模板

- 级别：**P3**
- 位置：仓库根（实测 `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md`、`.github/` 全部 `MISSING`）
- 现状：`README.md:101-102` 明确把用户导向「本仓库 Issues」与「上游 Issues」，但仓库没有任何 issue 模板；`README.md:99` 用一段长文字描述「当前对齐上游 f0aac52」，等价于把变更日志写在 README 里——每版都要重写这段（0.8.4/0.8.5/0.8.6 的提交信息格式一致，说明作者每次都在做这件事）。
- 问题：
  - 没有 issue 模板 → 用户报告缺「Lumina 版本 / sd-server 版本 / 后端（CUDA/Vulkan/CPU）/ 模型家族 / 日志最后 30 行」，而这五项恰好是 `README.md:88-95`「遇到问题先看这里」要求的信息，现在是靠用户自觉；
  - 没有 CHANGELOG → 用户从 0.8.0 升到 0.8.6 不知道改了什么，只能读 6 条中文 commit message；
  - 没有 SECURITY → AGPL 项目分发未签名二进制，安全研究者没有私下报告渠道；
  - 没有 CONTRIBUTING → 结合 2.7 的无 lint/format，外部 PR 的风格必然漂移。
- 建议：`.github/ISSUE_TEMPLATE/bug.yml`（用上面五项做必填字段，与 README 的「遇到问题先看这里」对齐）、`CHANGELOG.md`（Keep a Changelog 格式，从 `v0.8.0` 补起，历史信息可从 `git log --oneline` 取）、`SECURITY.md`（3 行即可：报告邮箱 + 支持版本）、`CONTRIBUTING.md`（开发命令直接抄 `README.md:128-133`，加一句「提交前跑 `npm run lint && npm test`」）。

### 2.9 4 个已知漏洞（2 high），全部在 dev/build 链，可在声明范围内直接修

- 级别：**P3**
- 位置：`package-lock.json`（`undici`、`source-map-js`、`vitest`、`@vitest/mocker` 条目）
- 现状（实测 `npm audit --json`）：

  | 包                    | 级别     | 范围                | 引入者                                                     | 说明                                                                                              |
  | --------------------- | -------- | ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `undici` 7.29.0       | **high** | 7.0.0–7.29.0        | `node_modules/jsdom [dependencies] ^7.25.0` → `dev: true`  | 10 条 GHSA（WebSocket 解压 DoS、retry 拦截器响应拆分、`Set-Cookie` 跨用户泄露、TLS 校验被丢弃等） |
  | `source-map-js` 1.2.1 | **high** | 1.0.0–1.2.1         | `postcss` / `@tailwindcss/node` / `css-tree` → `dev: true` | GHSA-68fv-2mgg-jv7q 事件循环 DoS                                                                  |
  | `vitest` 4.1.10       | moderate | 2.1.0-beta.1–4.1.10 | 直接 devDependency                                         | GHSA-82fw-gwwq-j7x9 `@vitest/mocker` 重定向 mock 路径穿越                                         |
  | `@vitest/mocker`      | moderate | 2.1.0–4.1.10        | `vitest` 传递                                              | 同上                                                                                              |

  `npm audit --omit=dev --json` → `{"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0}}}`，**生产依赖 96 个包零漏洞**。

- 问题：不影响最终用户（这些代码不进 `dist`，`dist` 里只有 14 个本地文件），影响的是「开发机跑测试/构建」这条链：`jsdom` 在测试里执行被测代码、`undici.retry`/`WebSocket` 场景全部是本地 mock 数据，实际可利用性低；但它们是可直接消除的噪音，留着会让将来的 `npm audit` 检查失去信号价值。
- 建议：`npm update vitest source-map-js undici`（三者都在已声明的 caret 范围内，`wanted` 分别是 4.1.12 / 1.2.2 / ≥7.29.1，不需要跨大版本），然后重跑 `npm audit` 确认归零；长期靠 2.10 的 dependabot。

### 2.10 19 个直接依赖落后上游，5 个跨大版本；无升级机器人

- 级别：**P3**
- 位置：`package.json:19-47`
- 现状（实测 `npm outdated`，`EXIT=1`，19 行）：

  ```
  @tauri-apps/api        2.11.0 → 2.12.4   @tauri-apps/cli        2.11.2 → 2.12.3
  @tauri-apps/plugin-notification 2.3.3 → 2.7.0
  @testing-library/jest-dom 6.9.1 → 7.0.1   @testing-library/react 16.3.2 → 16.3.3
  @testing-library/user-event 14.6.1 → 14.6.8
  @types/react 18.3.31 → 19.3.0   @types/react-dom 18.3.7 → 19.3.0
  @vitejs/plugin-react 6.0.3 → 6.1.2   lucide-react 1.27.0 → 1.59.0
  motion 12.42.2 → 12.43.0 (latest 14.3.0)   radix-ui 1.6.7 → 1.8.1
  react/react-dom 18.3.1 (latest 19.3.1)   tailwind-merge 3.6.0 → 3.7.0
  typescript 5.9.3 (latest 7.0.2)   vite 8.1.4 → 8.3.4
  vitest 4.1.10 → 4.1.12 (latest 5.0.5)   zustand 5.0.14 → 5.0.15
  ```

- 问题：`react`/`react-dom`/`@types/react` 停在 18 是有意选择（`package.json:28-29` 是 `^18.3.1`），不算缺陷；但 `"Wanted"` 列的差距说明 lockfile 已经有一段时间没刷新（`vite 8.1.4 → 8.3.4`、`vitest 4.1.10 → 4.1.12` 都在 caret 范围内却未升级）。真正的风险是「大版本跳跃在无人预警的情况下同时到来」：`vitest 5`、`typescript 7`、`motion 14`、`@testing-library/jest-dom 7` 四个同时落后一个大版本，将来一次性升级的代价远高于分批。
- 建议：开 dependabot（`.github/dependabot.yml`，`versioning-strategy: increase`，`npm` 每周一次，把 major 单独分组），或每次发版前手动跑一次 `npm update` + `npm test`。

### 2.11 `tsconfig` 不覆盖配置文件，配置写错只会静默失效

- 级别：**P3**
- 位置：`tsconfig.json:20`（`"include": ["src"]`）、`vite.config.ts`、`vitest.config.ts`
- 现状：`tsconfig.json` 只包含 `src`（95 个文件），`vite.config.ts` / `vitest.config.ts` 不在任何 project 内；`package.json:12` 的 `"build": "tsc && vite build"` 因此**从不检查**这两个文件。本仓库又恰好没有 `@types/node`（`package.json:33-47` 里没有），所以也没法给它们补 `node` 类型。
- 问题：`vite.config.ts:23-41` 这一段（`rolldownOptions.output.codeSplitting.groups`）是纯配置对象，写错键名（例如把 `rolldownOptions` 写成 `rollupOptions`、把 `codeSplitting` 写成 `codeSplittingGroups`）**不会失败、不会警告**，只会让分组静默失效、回到单一大 chunk。本次审查确认它当前是生效的，但依据只是「chunk 名字叫 `react-vendor`」这个旁证——没有任何自动化断言保护它。
- 上游/对照依据：Vite 官方 `create-vite` 模板的 `tsconfig.node.json` 专门负责 `vite.config.ts` 的类型检查（`"include": ["vite.config.ts"]`，`"types": ["node"]`）。
- 建议：加 `tsconfig.node.json`（`"include": ["vite.config.ts", "vitest.config.ts", "scripts/**/*.mjs"]`，`"compilerOptions": { "types": ["node"], "module": "ESNext", "moduleResolution": "bundler", "noEmit": true }`），装 `@types/node`，`build` 脚本改成 `"tsc -p tsconfig.json && tsc -p tsconfig.node.json && vite build"`。若要更保险，再加一条构建后断言：`vite build` 之后用脚本检查 `dist/assets/react-vendor-*.js` 是否存在。

### 2.12 `vitest.config.ts` 缺覆盖率、`globals` 与类型不一致、纯逻辑测试也跑 jsdom

- 级别：**P3**
- 位置：`vitest.config.ts:1-11`
- 现状：

  ```ts
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test/setup.ts"] }
  ```

  没有 `coverage` 段；`devDependencies` 里没有 `@vitest/coverage-v8` 或 `-istanbul`；`package.json:16-17` 只有 `test` / `test:watch`，没有 `test:coverage`。

- 问题：
  1. **没有覆盖率数字**：363 个用例听起来很多，但没人知道 `src-tauri/src/*.rs` 之外的 TS 覆盖率是多少；`src/lib/utils.ts`（92 个用例）与 `src/components/generation/*` 的覆盖分布差异不可见。
  2. **`globals: true` 是陷阱**：见 2.7 第三条。
  3. **jsdom 全局化**：34 个文件里至少 9 个是纯函数测试（`src/lib/__tests__/utils.test.ts` 24ms、`launchConfig.test.ts` 29ms、`theme.test.ts`、`logFormat.test.ts`、`virtualGrid.test.ts`、`byteCache.test.ts`、`sensenova.test.ts`、`diagnostics.test.ts`、`store.test.ts`），它们不需要 DOM，却都付了 jsdom 初始化成本。实测汇总行：`Duration 21.98s (transform 9.30s, setup 7.41s, import 27.85s, tests 27.63s, environment 84.40s)`——`environment` 累计 84.40s 是全表最大值。
- 建议：
  - `npm i -D @vitest/coverage-v8`，加 `"test:coverage": "vitest run --coverage"`，`test.coverage.thresholds` 先设一个能过的最低线（例如 `lines: 70`）再逐步提高；
  - 给纯逻辑测试文件加文件头注释 `// @vitest-environment node`（Vitest 官方支持按文件覆盖 `environment`），可省掉约 1/6 的文件数 × jsdom 启动成本；
  - `globals: true` 二选一：要么删掉，要么在 `tsconfig.json` 加 `"types": ["vitest/globals"]`。

### 2.13 单文件占全量测试 77% 时长（17.0s / 21.98s）

- 级别：**P3**
- 位置：`src/components/dashboard/__tests__/Dashboard.test.tsx:68-72`
- 现状（实测逐文件耗时，Top 5）：

  | 文件                                                                                                    | 用例 | 耗时         |
  | ------------------------------------------------------------------------------------------------------- | ---- | ------------ |
  | `dashboard/__tests__/Dashboard.test.tsx`                                                                | 18   | **17004 ms** |
  | `generation/__tests__/GenerationUI.test.tsx`                                                            | 14   | 1606 ms      |
  | `generation/__tests__/GenerationUpscale.test.tsx`                                                       | 7    | 1065 ms      |
  | `generation/__tests__/PromptDock.test.tsx`                                                              | 8    | 952 ms       |
  | `generation/__tests__/ImagePreprocessPanel.test.tsx`                                                    | 7    | 686 ms       |
  | （其余 29 个文件合计 ≈ 4.8s；单用例 700–1500ms，见 `blocks startup and lists missing…` 968ms 等 18 条） |
  | 原因可见：                                                                                              |

  ```ts
  // Dashboard.test.tsx:68-72 —— 每次调用 pickOption 都新建一个 userEvent 实例
  async function pickOption(label: string, optionName: string | RegExp) {
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(label));
    await user.click(await screen.findByRole("option", { name: optionName }));
  }
  ```

  每个用例还要完整挂载 `Dashboard`（大量 Radix Select / 折叠面板）。

- 问题：22s 的测试时长本身可接受，但它意味着「改一行 Dashboard 要等 20 秒」，且这个文件会随用例增长线性变慢（18 个用例已占 17s，50 个用例就是 45s+）。在没有 CI 的现状下，它是「本地不愿跑全量测试」的诱因。
- 建议：把 `userEvent.setup()` 提到 `describe` 之外复用（或 `userEvent.setup({ delay: null })` 去掉事件间隔）；`pickOption` 里的 `findBy*` 换成同步 `getBy*`（Radix 的 Select 在 `fireEvent.click` 后同步挂载菜单）；对 `Dashboard` 的重复挂载考虑 `beforeEach(render)` 复用容器。

### 2.14 打包元数据与「跨平台」声明不一致

- 级别：**P3**
- 位置：`src-tauri/tauri.conf.json:31-40`
- 现状：`"targets": "all"`，`icon` 数组只有 `png` 与 `ico`（`tauri.conf.json:34-39`）；但 `src-tauri/icons/icon.icns` **存在**（369,027 字节）却没被引用。`bundle` 段也没有 `windows.webviewInstallMode`（默认 `downloadBootstrapper`，安装时需联网下载 WebView2）。
- 问题：`README.md:42` 说「依赖本身跨平台，macOS 与 Linux 应该能构建」。Linux 的 `deb/rpm/appimage` 用 png 图标没问题；macOS 的 `dmg/app` 需要 `.icns`，而 `bundle.icon` 里没有 → 大概率在 macOS 上打包失败（配置层面已能看出不一致）。另外 `targets: "all"` 在 Windows 上只产出 msi+nsis（`build-release.log:47-53` 印证），这一点 README 说法是对的。
- 建议：`"icon"` 补 `"icons/icon.icns"`（文件已在仓库里，零成本）；若确定要支持离线安装，加
  `"windows": { "webviewInstallMode": { "type": "embedBootstrapper" } }`（约 +1.8MB）或 `"offlineInstaller"`（约 +127MB，仓库体积敏感的话别选）。若暂不支持 macOS，就把 `README.md:42` 改成「仅在 Windows 上验证，macOS/Linux 配置未完成」，比「应该能构建」更诚实。

### 2.15 文档抽查：10 条可验证论断，9 条一致、1 条不一致

- 级别：**P3**
- 方法：每条 README 论断在代码里找唯一事实源，逐条比对。

| #   | README 论断（行号）                                          | 代码证据                                                                                                                                                                                             | 结论                                                                                                                             |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 默认端口 `127.0.0.1:1234`，可改 1024–65535（`:86`）          | `server.rs:14 DEFAULT_SD_PORT: u16 = 1234`；`server.rs:20-21` `if port < 1024 { bail!("端口 {} 不可用，请使用 1024–65535 之间的端口") }`；前端 `utils.ts:16-17 MIN_SD_PORT=1024 / MAX_SD_PORT=65535` | **一致**                                                                                                                         |
| 2   | 目录最多向下三层、单次最多 5000 个文件（`:90`）              | `scanner.rs:9 const MAX_DEPTH: usize = 3`；`scanner.rs:14 const MAX_SCAN_FILES: usize = 5000`；`scanner.rs:310 if depth > MAX_DEPTH`                                                                 | **一致**                                                                                                                         |
| 3   | 只认 `.safetensors/.sft/.gguf/.ckpt/.pt/.pth`（`:90`）       | `scanner.rs:105 matches!(ext, "safetensors" \| "sft" \| "gguf" \| "ckpt" \| "pt" \| "pth")`                                                                                                          | **一致**                                                                                                                         |
| 4   | 6 条快捷键（`:75-80`）                                       | `Ctrl+Enter` → `useKeyboardShortcuts.ts:19`；`Ctrl+R` → `:23`；`Esc` → `:27`；`Ctrl+,` → `GenerationUI.tsx:963`；`←/→/+/-/0` → `Lightbox.tsx:86-102`                                                 | **一致**                                                                                                                         |
| 5   | 生成参数缓存在 `sdcpp:params:*`，不进 settings.json（`:85`） | `launchConfig.ts:235 getItem(\`sdcpp:params:${mode}\`)`、`:243`；`GenerationUI.tsx:294/306/781`                                                                                                      | **一致**（但未提及另外三个键：`store.ts:398 "sdcpp:seedRandom"`、`store.ts:417 "sdcpp:sizeStep"`、`theme.ts:43 "lumina:theme"`） |
| 6   | 已适配 58 个家族，外加「自定义」（`:105`）                   | 求值 `src/config/families.ts` 得到 `FAMILY_CONFIG` **61 个键 = 60 个真实家族 + custom**（见 §5 探针输出）                                                                                            | **不一致**（少报 2 个）                                                                                                          |
| 7   | PNG / WebP 元数据解析（`:156`）                              | `png_info.rs:51 parse_png_metadata`、`:97 parse_webp_metadata`、`:227 else if ext == "webp"`                                                                                                         | **一致**                                                                                                                         |
| 8   | Windows 产出 msi + nsis + 免安装 exe，文件名形态（`:37-39`） | `build-release.log:47-53`：`bundle\msi\Lumina_0.8.0_x64_en-US.msi`、`bundle\nsis\Lumina_0.8.0_x64-setup.exe`、`target\release\lumina.exe`                                                            | **一致**                                                                                                                         |
| 9   | 前置 Node.js 20.19+（`:23`）                                 | `.nvmrc:1 20.19.0`；`package.json:7 "node": ">=20.19.0"`；`vite@8.1.4` engines `^20.19.0 \|\| >=22.12.0`                                                                                             | **一致**（`engines` 范围偏宽，见 2.16）                                                                                          |
| 10  | `npm run dev` 端口 1420（`:129`）                            | `vite.config.ts:11-13 port: 1420, strictPort: true`；`tauri.conf.json:8 devUrl: "http://127.0.0.1:1420"`                                                                                             | **一致**                                                                                                                         |

- 第 6 条的具体差异：`README.md:107` 的枚举（39 个顿号分隔项）里**完全没有** `LLaDA-Image` / `LLaDA-Image Turbo` / `SenseNova U1.5`——这三者在代码里是三个独立 id（`family.rs` 的 detect 返回值与 `families.ts:1198`、`families.ts:401` 都有完整配置，`src/lib/__tests__/sensenova.test.ts` 还专门测了它的参数映射），却不在 README 的「已适配」清单里。同时 README 把 `MOSS-Image（Base / SFT）` 并列（代码里是同一个 id `moss-image`，`family.rs:152-153`）把 `PiD / PiD 1.5` 并列（同一个 id `pid`），所以「58」这个数字既不是枚举项数、也不是代码 id 数。
  顺带一个**正向**发现：`family.rs detect_family` 返回的 60 个 id 与 `FAMILY_CONFIG` 的 60 个键**双向零差集**（§5 探针），说明「Rust 检测 / TS 配置」这两处没有漂移，`README.md:135`「家族识别只有 family.rs 一份实现」属实。
- 建议：把 `README.md:105` 的「58 个」改为「60 个」，并把 `LLaDA-Image（含 Turbo）`、`SenseNova U1.5` 补进 `README.md:107`；最好让一个测试直接断言「README 里的家族数与 `FAMILY_CONFIG` 一致」——把 `README.md` 里的数字做成可测的（例如新增 `src/__tests__/readme.test.ts` 用正则抽取数字比对），否则这类数字会继续腐烂。

### 2.16 `engines` 范围宽于真实要求，且没有 `packageManager`

- 级别：**P3**
- 位置：`package.json:6-8`、`.nvmrc:1`
- 现状：`"node": ">=20.19.0"`；`.nvmrc` 是 `20.19.0`；本机实测 `v24.13.0`。但真实约束更严：

  | 包                           | engines                                |
  | ---------------------------- | -------------------------------------- |
  | `vite@8.1.4`                 | `^20.19.0 \|\| >=22.12.0`              |
  | `vitest@4.1.10`              | `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0`   |
  | `jsdom@29.1.1`               | `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0` |
  | `@vitejs/plugin-react@6.0.3` | `^20.19.0 \|\| >=22.12.0`              |
  | `rolldown@1.1.5`             | `^20.19.0 \|\| >=22.12.0`              |

- 问题：`>=20.19.0` 允许 Node **21.x / 23.x**，但 `vitest` 与 `jsdom` 明确不支持奇数版本——在这些版本上 npm 只会打 `EBADENGINE` 警告（`.npmrc` 没有 `engine-strict=true`，所以不阻断），随后 `npm test` 会以难以理解的方式失败。另一侧：没有任何 npm 版本约束，而本项目明显敏感（`package-lock.json` 是 `lockfileVersion: 3`，npm 6 生成的是 v2）。
- 建议：
  ```json
  "engines": { "node": "^20.19.0 || ^22.13.0 || >=24.0.0" },
  "packageManager": "npm@11.6.2"
  ```
  `.npmrc` 加 `engine-strict=true`（对 `npm ci`/`npm install` 都会生效）。

### 2.17 其它打磨项

- 级别：**P3**
- **`sourcemap: false` + 无 ErrorBoundary**：`vite.config.ts:19 sourcemap: false`，`src` 全库 0 处 `ErrorBoundary`/`componentDidCatch`/`window.onerror`/`unhandledrejection`（`grep` 只命中 `utils.ts:206/218` 的 `img.onerror`），`main.tsx:16` 直接 `createRoot(...).render(<App />)`。任何渲染异常 → React 卸载整棵树 → **白窗**；而「服务器日志面板」只收 `sd-server` 的 stdout/stderr，抓不到前端异常。`Cargo.toml:16` 又把 `devtools` feature 开着（release 构建也可开 devtools），用户理论上能打开控制台，但 `sourcemap: false` 意味着只能看到压缩后的栈。（与 frontend-arch 重叠：ErrorBoundary 归他们；本条只报「构建侧不给 sourcemap，导致即便有 devtools 也无法定位」。）建议：至少给 release 出 `sourcemap: "hidden"` 并归档 `.map`（不进安装包），或在 `main.tsx` 加 `window.onerror` → `invoke("log_frontend_error", ...)` 写进日志面板。
- **`build-release.log` 残留在工作区**：被 `.gitignore:5 *.log` 忽略（`git ls-files` 中不存在，非入库文件），但内容是 0.8.0 的旧构建、路径还是 `D:\Project\lumina\src-tauri`（当前是 `D:\Project\AmeowCAT\lumina`）。它不影响构建，但作为「发布证据」已经过期 6 个版本。建议删除，或改为发布脚本显式 `Tee-Object` 到固定位置并随 Releases 归档。
- **字体子集冗余**：`dist` 里 12 个 woff2 合计约 302 kB（`inter-latin-ext` 85.06 kB、`inter-cyrillic-ext` 25.96 kB、`inter-cyrillic` 18.74 kB、`inter-greek` 18.99 kB、`inter-greek-ext` 11.23 kB、`inter-vietnamese` 10.25 kB，JetBrains Mono 同构）。README 全中文界面（`index.html:2 <html lang="zh-CN">`），中文字形走系统字体，这些西里尔/希腊/越南子集对目标用户是纯重量。桌面应用从本地磁盘加载，影响仅限安装包体积与解压时间。若要瘦身，改用 `@import "@fontsource-variable/inter/latin.css"`（fontsource 支持按子集导入），可省约 120 kB。
- **Cargo 侧依赖双版本**（归 backend-rust，此处仅记录实测）：`Cargo.lock` 里 `dirs` 同时有 5.0.1（直接依赖，`Cargo.toml:29 dirs = "5"`）与 6.0.0（传递）；`reqwest` 有 0.12.28（直接）与 0.13.4（传递）；`windows-sys` 共 6 个版本（0.45/0.48/0.52/0.59/0.60/0.61，直接依赖是 0.59，`Cargo.toml:36`）。多为生态常态，但 `dirs 5→6`、`windows-sys 0.59→0.61` 属可收敛项。
- **`dist` 里没有任何许可文件**：见 2.6 第 3 点。

## 3. 待验证假设

1. **macOS 打包是否真的因缺 `.icns` 失败**（2.14）：`src-tauri/icons/icon.icns` 存在但未列入 `bundle.icon`。我推断 tauri-bundler 在 `dmg/app` 打包时会报「找不到 icns」，但本机无 macOS 环境，未实测。若 bundler 会回退到 `icon.png`，则该条降级为「配置与文件不一致」。
2. **`target: "esnext"` 在非 Windows 平台的可用性**（`vite.config.ts:17`）：`dist` 产物里有 `??=` 7 处、`?.` 579 处（来自依赖，`oxc` 压缩后保留）。Windows 的 WebView2 跟随 Edge 更新，无风险；macOS 旧系统（10.15 的 Safari 13.1 不支持 `??=`）与部分 Linux `webkit2gtk` 可能白屏。未在非 Windows 平台实测，且 README 只声明 Windows 已验证，故未列为正式结论。
3. **离线机器装不上**：`tauri.conf.json` 未设 `bundle.windows.webviewInstallMode`，默认 `downloadBootstrapper` 需要在安装时联网下载 WebView2。未实测（本机已装 WebView2）。
4. **`@emnapi/*` 的最终一致状态**：本组未执行 `npm ci`（会删改 `node_modules`，且可能与并行小组的读取冲突）。「干净 `npm ci` 之后这 5 个包应该一个都不装」是基于 optional+平台过滤的推断，需要用一次性干净目录验证。
5. **`motion-dom` / `motion-utils` 的 chunk 归属**：`vite.config.ts:33` 的正则 `/node_modules\/(motion|framer-motion)\//` 只匹配 `node_modules/motion/` 与 `node_modules/framer-motion/`，不匹配 `motion-dom` / `motion-utils`（目录名带连字符）。但实测 `motion-vendor` 有 125.24 kB 且没有额外的 motion 相关 chunk，推断是 rolldown 把「单一引用者的模块」合并进了 `motion-vendor`（因为 `motion-dom` 只被 `framer-motion` 引用）。未用 `--debug` 打印模块归属，属推断。
6. **`README.md:99` 对齐上游 `f0aac52` 的逐条 PR 清单**：不在本组范围（归 cli-families / api-alignment），本组只核对了「版本号 / 构建命令 / 快捷键 / 端口 / 扫描参数 / 家族数」这一类工程性论断。

## 4. 与其它组可能重叠的点（Lead 合并用）

| 事项                                                                                           | 本组视角                                                                 | 建议归属                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 无 ErrorBoundary / 无 `window.onerror` / 白窗                                                  | 与 `sourcemap: false` 联动：即使开 devtools 也只能看到压缩栈（2.17）     | 主记 frontend-arch，本组只保留「构建侧不产 sourcemap」这一半 |
| `Cargo.toml` 依赖版本双份（`dirs` 5/6、`windows-sys` 6 个版本）、`devtools` feature 进 release | 依赖健康度（2.17）                                                       | 主记 backend-rust                                            |
| `capabilities/default.json` 权限面、CSP                                                        | 已读但未评估（`tauri.conf.json:28` CSP 与 `README.md:135` 一致，无矛盾） | backend-rust                                                 |
| `index.html:13` 与 `src/lib/theme.ts:43` 双写 `lumina:theme` 键名                              | 一致性风险：两处手写字面量，靠注释「保持一致」（`index.html:12`）        | 主记 frontend-arch                                           |
| `hooks/useKeyboardShortcuts.ts:14-15` 重复赋值                                                 | 作为「无 lint 会漏掉什么」的实例（2.7）                                  | 主记 frontend-arch（无功能影响，纯冗余）                     |
| `src/api.ts` 23 个命令名 vs Rust `generate_handler!`                                           | TS↔Rust 接缝零覆盖（2.5）                                                | 可与 api-alignment 合并；本组提供测试缺口视角                |
| 33 处 README 论断中的上游对齐细节（`:99` 那段 PR 清单）                                        | 未评估                                                                   | cli-families / api-alignment                                 |

## 5. 实测记录

环境：`node v24.13.0`、`npm 11.6.2`、`npx 11.6.2`、HEAD `d442371`（工作时 `git status` 仅 `?? docs/audit/`）。所有命令在仓库根 `D:\Project\AmeowCAT\lumina` 执行。

### 5.1 `npx tsc --noEmit`

```
EXIT=0
输出行数 = 0
```

`tsconfig.json` 下 `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`（`:14-17`），`include: ["src"]`（`:20`），95 个 ts/tsx 文件。全库 `@ts-ignore`/`@ts-expect-error` 各 0 处、`any` 0 处、`as unknown as` 11 处（`store.ts:263`、`setup.ts:6/20/33`、`store.test.ts:45`）。**类型面干净，且不是靠 suppress 换来的。**

### 5.2 `npm test`（Vitest 4.1.10）

```
Test Files  34 passed (34)
     Tests  363 passed (363)
  Start at  17:09:01
  Duration  21.98s (transform 9.30s, setup 7.41s, import 27.85s, tests 27.63s, environment 84.40s)
EXIT=0
```

- 慢文件 Top 5：`Dashboard.test.tsx` 17004ms(18)、`GenerationUI.test.tsx` 1606ms(14)、`GenerationUpscale.test.tsx` 1065ms(7)、`PromptDock.test.tsx` 952ms(8)、`ImagePreprocessPanel.test.tsx` 686ms(7)。
- 快文件（纯逻辑）：`utils.test.ts` 24ms(92)、`launchConfig.test.ts` 29ms(54)、`store.test.ts` 54ms(10)、`diagnostics.test.ts` 8ms(22)。
- stderr 相关行共 14 条命中：`act(...)` 警告 5 处（`GenerationUI.test.tsx`：`An update to GenerationUI inside a test was not wrapped in act(...)`，栈指向 `GenerationUI.tsx:73`）、`Not implemented: Window's scrollTo() method` 2 处（`Dashboard.test.tsx`）、`stderr | <文件>` 块头 6 行，其余为同一警告的续行。

### 5.3 `npm run build`（`tsc && vite build`，Vite 8.1.4 + rolldown 1.1.5）

```
✓ 2357 modules transformed.
✓ built in 1.23s
EXIT=0
```

chunk 列表（Vite 的 kB = 1000 B）：

| chunk                               | raw           | gzip     |
| ----------------------------------- | ------------- | -------- |
| `index-DMVPcQti.js`（入口）         | **145.72 kB** | 42.25 kB |
| `react-vendor-CGZnkPnf.js`          | 139.88 kB     | 45.35 kB |
| `ui-vendor-B_Rq68Ng.js`             | 133.90 kB     | 44.43 kB |
| `motion-vendor-BAQjeKJd.js`         | 125.24 kB     | 40.79 kB |
| `Dashboard-DXA0bGl6.js`             | 35.59 kB      | 12.01 kB |
| `GenerationParamsSheet-CoCKwEWY.js` | 32.23 kB      | 10.32 kB |
| `Select-CH5SMzhI.js`                | 20.55 kB      | 7.38 kB  |
| `HistoryGallery-W9EYc7kd.js`        | 11.25 kB      | 4.48 kB  |
| `Panel-BrprmwLN.js`                 | 1.08 kB       | 0.61 kB  |
| `Toggle-ClJs1DEi.js`                | 0.50 kB       | 0.31 kB  |
| `rolldown-runtime-CNC7AqOf.js`      | 0.87 kB       | 0.50 kB  |
| `index-BGL1fDii.css`                | 97.75 kB      | 20.41 kB |

- **`codeSplitting.groups` 确认生效**：`vite.config.ts:26-39` 配的三个 `name` 原样出现在产物里（`react-vendor` / `motion-vendor` / `ui-vendor`），并且 `dist/index.html` 用 `<link rel="modulepreload">` 预加载它们 → 配置被 Vite 8 的 `rolldownOptions.output.codeSplitting` 正确消费（不是被静默忽略）。
- **没有 >500KB 的 chunk**：最大 145.72 kB，Vite 未打 `(!) Some chunks are larger than 500 kB` 警告。
- 首屏预加载合计（`dist/index.html` 的 `modulepreload` + 入口）：`0.87 + 139.88 + 125.24 + 133.90 + 20.55 + 145.72 = 566.16 kB raw / 180.70 kB gzip`；懒加载部分（Dashboard / GenerationParamsSheet / HistoryGallery / Panel / Toggle）合计 80.65 kB raw。
- `dist` 合计：26 个文件 / 1,025.9 KiB，其中 12 个 woff2 约 302 kB、js+css+html 728.7 KiB。
- 产物中 `??=` 7 处、`?.` 579 处（`target: "esnext"` 未下降）。

### 5.4 依赖树

```
$ npm ls --depth=0
21 个直接依赖全部 OK；4 个 extraneous：
  @emnapi/core@1.11.3  @emnapi/wasi-threads@1.2.2
  @napi-rs/wasm-runtime@1.1.6  @tybys/wasm-util@0.10.3
（无 UNMET、无 invalid、无 missing 在顶层）

$ npm ls --all      # 920 行
唯一非 optional 的问题行：
  +-- UNMET DEPENDENCY @emnapi/runtime@^1.7.1
其余均为 win32-x64 上正常缺席的 optional（darwin/linux 二进制、babel 插件、canvas 等）
```

lock 侧：277 个包；根 `package.json` 的 25 条声明与 `package-lock.json` 根 `dependencies`/`devDependencies` 逐条一致；锁定版本均满足 caret 范围（`react`/`react-dom` 都是 `18.3.1`，同版；`@tauri-apps/cli@2.11.2` 与 `Cargo.lock` 的 `tauri 2.11.2` 同版）。

### 5.5 `npm outdated` / `npm audit`

```
$ npm outdated          # EXIT=1；19 行，见 2.10
$ npm audit --json      # EXIT=1
  info 0  low 0  moderate 2  high 2  critical 0  total 4
    undici 7.29.0 (high, ←jsdom dev) / source-map-js 1.2.1 (high, ←postcss+tailwind dev)
    vitest 4.1.10 + @vitest/mocker (moderate, 直接 devDependency)
$ npm audit --omit=dev --json   # EXIT=0
  {"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0},"dependencies":{"prod":96,"dev":182,"optional":64,"peer":13,"total":277}}}
```

### 5.6 版本一致性与 `sync-version.mjs` 幂等性

```
package.json:4                  0.8.6
package-lock.json:3 / :9        0.8.6 (根对象 + packages[""]，两处)
src-tauri/tauri.conf.json:4     0.8.6
src-tauri/Cargo.toml:3          0.8.6
src-tauri/Cargo.lock:2257       0.8.6  (name = "lumina" @ :2256)
```

`$ node scripts/sync-version.mjs` 输出（运行前后对 5 个文件做 SHA256 比对，全部 `UNCHANGED`，即脚本在当前状态是幂等的、四个锚点都能命中）：

```
sync-version: package-lock.json 已是 0.8.6
sync-version: src-tauri/tauri.conf.json 已是 0.8.6
sync-version: src-tauri/Cargo.toml 已是 0.8.6
sync-version: src-tauri/Cargo.lock 已是 0.8.6
EXIT=0
```

**五处版本号当前完全一致。** 但同步机制的脆弱性见 2.1（`npm version` 的 git 集成只 add 两个文件，实测 npm 内部实现 `libnpmversion/lib/version.js:110-117`）。

### 5.7 家族数量探针（精确计数，替代人工数 key）

用仓库自带的 `typescript` 转译 `src/config/families.ts` 后在内存中求值（脚本写在 `%TEMP%`，不落仓库）：

```
FAMILY_CONFIG total keys: 61
includes 'custom': true
real families (excluding custom): 60
rust detect_family ids: 60
rust ids missing in FAMILY_CONFIG: (none)
FAMILY_CONFIG keys not produced by detect_family: (none)
```

→ 60 个真实家族 + `custom`；Rust 与 TS 两侧家族 id **双向零差集**（这是正向结论）；README 声称的「58 个」偏少 2（2.15 第 6 条），且清单漏 3 个 id。

### 5.8 许可统计（扫描 `node_modules` 全部 `package.json`）

```
236 个 package.json → 221 个唯一包
MIT                         194      Apache-2.0                    5
ISC                           5      Apache-2.0 OR MIT             3
MPL-2.0                       3      BSD-2-Clause                  2
BSD-3-Clause                  2      MIT-0                         2
OFL-1.1                       2      0BSD                          1
CC0-1.0                       1      MIT OR Apache-2.0             1
```

非宽松项（逐条评估）：

- `OFL-1.1` × 2：`@fontsource-variable/inter@5.3.0`、`@fontsource-variable/jetbrains-mono@5.3.0` — **打进安装包**（`src/styles.css:7-8` → `dist/assets/*.woff2`），需要随包附 OFL 文本 → 2.6 第 3 点。
- `MPL-2.0` × 3：`lightningcss@1.32.0` 及两个平台绑定 — 仅构建期（Tailwind 4 的 CSS 编译），不随包分发；MPL-2.0 §3.3 允许并入 GPL/AGPL 作品，**与 AGPL-3.0-or-later 兼容**。
- `MIT-0` × 2（`@csstools/*`）、`CC0-1.0`、`0BSD`：公共领域等价，无义务。
- **结论：未发现与 AGPL-3.0-or-later 冲突的依赖许可**；唯一实质义务是 OFL 字体归属文本缺失。

### 5.9 其它实测

```
$ git tag -l        → v0.7.19 v0.7.20 v0.8.0 v0.8.1 v0.8.2 v0.8.3 v0.8.4 v0.8.5（无 v0.8.6）
$ git describe --tags --always → v0.8.5-3-gd442371
$ git ls-files | 匹配 Cargo.lock|package-lock  → package-lock.json、src-tauri/Cargo.lock（均已入库，181 个受控文件）
$ 哈希前后比对 sync-version 的 5 个目标文件 → 全部 UNCHANGED
```

- 依赖使用核对（对 25 个直接依赖逐个 grep `from "pkg"` / `@import`）：**12 个 `dependencies` 与 13 个 `devDependencies` 全部命中真实 import**，无未使用项。代表性证据：
  - `clsx`+`tailwind-merge` → 同一个文件 `src/components/ui/cn.ts:1-2`，各司其职（条件拼装 / 冲突消解），非重复依赖；
  - `radix-ui`（统一包）→ `Toggle.tsx:2`、`Slider.tsx:2`、`Select.tsx:2`、`PromptDock.tsx:2`、`LoraPanel.tsx:2`；全库 **0** 处直接 `from "@radix-ui/..."`，无混用；
  - `lucide-react@1.27.0` peer 为 `react@^16.5.1 || ^17 || ^18 || ^19`，与 `react@18.3.1` **无 peer 冲突**（`npm ls` 亦无 UNMET）；
  - `@fontsource-variable/*` → `src/styles.css:7-8` 的 `@import`，属 CSS 侧使用，进 `dist` 后仍是有效字体文件（实测 12 个 woff2）；
  - `@types/node` 缺失**不是问题**：`vite.config.ts` / `vitest.config.ts` 都没用 Node API（问题在别处，见 2.11）。
- 治理文件实测存在性：`README.md`、`LICENSE`（35,184 B，AGPL-3.0 全文）存在；`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md`、`.editorconfig`、`eslint.config.*`、`.prettierrc*`、`.github/`、`rustfmt.toml`、`clippy.toml`、`deny.toml`、`.vscode/` 全部**不存在**；`.gitignore:1-6` 覆盖 `node_modules/ dist/ src-tauri/target/ src-tauri/gen/ *.log gui-test-screenshots/`，`.gitattributes:1-12` 行尾与二进制规则到位（`* text=auto` + 显式 `eol=lf` + 图片 `binary`），`Cargo.lock` 只落进 `* text=auto`（无扩展名，但 `sync-version.mjs:40/44` 用 `\r?\n` 已兼容 CRLF）。
