# 总验收记录（第十五轮）

> 目的：把"修完了没有"从叙述变成可复跑的证据。每条命令都可以在仓库根目录原样执行。
> 修复清单见 [98-fixes-status.md](./98-fixes-status.md)，原始问题见 10–60 六份审查报告。

## 1. 门禁矩阵

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm run check:types` | exit 0（`src` + `vite/vitest` 两套 project） |
| 2 | `npm run lint` | exit 0 —— 0 error / 52 warning（React 19 建议类与 `exhaustive-deps`，见第九轮说明） |
| 3 | `npm test` | 35 files / **403 passed** |
| 4 | `npm run test:coverage` | 语句 66.38% / 分支 62.71% / 函数 60.31% / 行 67.96%，**全部通过阈值**（60/55/55/62） |
| 5 | `npm run build` | 通过；入口 `index.js` 111.51 kB（gzip 36.16）、`families-data` 独立 chunk |
| 6 | `npm audit` | 0 vulnerabilities |
| 7 | `npm ls --depth=0` | 无 extraneous / UNMET / invalid |
| 8 | `npm run check:version` | 5 处版本号一致，Tauri npm↔crate 主次版本匹配 |
| 9 | `cd src-tauri && cargo fmt --check` | exit 0 |
| 10 | `cargo clippy --all-targets -- -D warnings` | exit 0 |
| 11 | `cargo test` | **105 passed** |
| 12 | `npx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json` | 产出 `src-tauri/target/debug/lumina.exe` |
| 13 | `node scripts/upstream-diff.mjs` | 与上游 `d55cc0f…master` 相比无参数/字段增删 |

## 2. P1 逐条核对（S-1 … S-11）

`99-final-report.md` 的 10 条 P1（+1 条同批 P2）全部有落地证据，明细表在
[98-fixes-status.md 第 1 节](./98-fixes-status.md)：监听别名绕过、输出目录白名单自指、
PuLID/PhotoMaker 死组件、`distilled-sd` 默认值、结果只在内存、设置往返丢字段、
提示词 token 截断、画廊 blob 泄漏、animated WebP 被当视频、LoRA 元数据永不匹配、
caps 缺键白屏。

## 3. 本轮新增的护栏（防止"修好了又退回去"）

| 护栏 | 位置 | 作用 |
|---|---|---|
| TS↔Rust 命令面契约 | `src/__tests__/contract.test.ts` | 23 条命令双向断言，改名/漏注册立刻失败 |
| 版本号一致性 | `scripts/check-version.mjs` | 5 处版本 + Tauri npm↔crate 主次版本 |
| 上游漂移 | `scripts/upstream-diff.mjs` | 参数/字段增删对比，`--coverage` 查字段覆盖 |
| CI | `.github/workflows/ci.yml` | 类型 / lint / 测试 / 覆盖率门禁 / 构建 / 依赖审计 / Rust 三件套 / 上游漂移 |
| 日志落盘 | `src-tauri/src/logging.rs` | release 无控制台，`lumina.log` 8 MB 滚动保留 3 份 |
| 覆盖率阈值 | `vitest.config.ts` | 语句 60 / 分支 55 / 函数 55 / 行 62 |

## 4. 遗留项与理由（12 项，见状态表末节）

- **需要产品决策**：F-22 i18n（先做 Rust 错误码化）、`webviewInstallMode`（离线安装包策略）。
- **需要独立 commit**：Prettier 全库格式化。
- **需要真实测量/新测试层**：§2.2 内存预算总账、§2.12 生命周期与订阅层测试。
- **需要先核上游语义**：`cache_option` / `scm_mask` 控件。
- **结构改动**：`Dashboard.test.tsx` 拆分并行（瓶颈已定位并被实测证伪了一个假设）。
- **可做但非阻塞**：extraArgs 补全、`--threads`/`--params-backend`/`--rpc-servers` 控件、
  F-18 余项（`shifted_timestep` 等）、`scripts/*.mjs` 类型检查。

## 5. 行为变化提醒（用户可知）

1. **结果默认不自动保存**（第十八轮按产品意图调整）：只有用户在控制台显式打开
   「生成完成后自动保存到输出目录」才会落盘；默认行为是"结果只在内存"，需要留档
   时点「保存到输出目录」。
2. **开发者工具**：release 构建 `devtools: false`；日常开发用 `npm run dev:desktop`
   （走 `tauri.dev.conf.json` 覆盖，devtools 打开）。
3. **保存设置会拒绝相对 `output_dir`**：必须是绝对路径。
4. **Tauri 三个 npm 包锁精确版本**：与 Rust crate 主次版本必须对齐，否则 `tauri build` abort。
