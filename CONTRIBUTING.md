# 参与开发

## 环境

- Node.js ≥ 20.19（仓库带 `.nvmrc`）、npm
- Rust stable
- Tauri 在你平台上的[系统依赖](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev      # 开发（前端热更新）
npm test               # 前端单测（Vitest）
cd src-tauri && cargo test
```

## 提交前必须跑

```bash
npm run check:types       # 类型（src + vite/vitest 配置，CI 同样会跑）
npm run lint              # ESLint（缺陷类规则 error，风格/React19 建议类 warning）
npm test                  # 前端单测
npm run test:coverage     # 覆盖率（基线：语句约 66% / 行约 67%）
npm run check:version     # 5 处版本号一致
npm run format:check      # Prettier 格式门禁
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

CI（`.github/workflows/ci.yml`）会把这些再跑一遍，另外跑一次 `vite build`
与 `npm audit --omit=dev`。

> 本地 Rust 请保持 `rustup update stable`：CI 用 runner 自带的最新 stable，clippy
> 新版本会新增 lint（2026-10 的 `collapsible_match` 就是本地 1.93 绿、CI 1.99 红）。
> 升级后先跑一遍 `cargo fmt --check && cargo clippy --all-targets -- -D warnings`。

> **格式由 Prettier 统一**：`npm run format` 会重写文件，提交前跑
> `npm run format:check`（CI 同样会跑）。纯格式化改动请单独放一个 commit，便于
> review；`npm run lint` 只保留能抓缺陷的规则，不承担格式职责。

## 改动约定

- **前端不直接发 HTTP**：所有请求都是 `src/api.ts` 里的类型化 Tauri 命令，
  由 Rust 侧代理。页面 CSP 不放行 `connect-src`。
- **家族识别只有一份实现**：`src-tauri/src/family.rs`；家族元数据只有一份：
  `src/config/families.ts`。两边靠家族 id 字符串对齐，改 id 时两边都要改，
  并跑 `cargo test` 与 `npm test`。
- **协议字段按内核实际声明发送**，不要按 Lumina 自己的版本号猜：
  `vaeTilingProtocolFromCapabilities` 是范本。
- **跟随上游**：同步流程见 [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md)；
  先跑 `node scripts/upstream-diff.mjs` 看差集。
- 新增设置字段要同时改 `src/types.ts` 与 `src-tauri/src/settings.rs`（camelCase ↔
  snake_case），两边都是 `#[serde(default)]`，漏一侧会静默丢值。
- **Tauri 的 npm 包与 Rust crate 必须 major.minor 对齐**（`@tauri-apps/api` ↔ `tauri`、
  `@tauri-apps/plugin-notification` ↔ `tauri-plugin-notification`）。这三个 npm 包因此
  写了精确版本，不要改回 `^`；`npm run check:version` 会检查，未对齐时 `tauri build`
  会直接 abort。
- **新增/改名 Tauri 命令时**：`src/api.ts` 的 `invoke("...")` 与 `src-tauri/src/lib.rs`
  的 `generate_handler!` 必须同时改，`src/__tests__/contract.test.ts` 会在两边不一致时失败。

## 文档

- README 的家族数与清单必须和 `FAMILY_CONFIG` 一致（写错会被 review 指出）。
- 已知限制与「遇到问题先看这里」是产品契约，改动行为时同步更新。
