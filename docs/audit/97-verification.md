# 总验收记录（第二十二轮更新）

> 目的：把"修完了没有"从叙述变成可复跑的证据。每条命令都可以在仓库根目录原样执行。
> 修复清单见 [98-fixes-status.md](./98-fixes-status.md)，原始问题见 10–60 六份审查报告。

## 1. 门禁矩阵

| #   | 命令                                                                         | 结果                                                                                          |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | `npm run check:types`                                                        | exit 0（`src` + `vite/vitest/scripts` 两套 project）                                          |
| 2   | `npm run lint`                                                               | exit 0 —— 0 error / 52 warning（React 19 建议类与 `exhaustive-deps`，见第九轮说明）           |
| 3   | `npm test`                                                                   | 42 files / **489 passed**                                                                     |
| 4   | `npm run test:coverage`                                                      | 语句 72.03% / 分支 67.29% / 函数 65.50% / 行 73.92%，**全部通过阈值**（60/55/55/62）          |
| 5   | `npm run build`                                                              | 通过；入口 `index.js` 112.58 kB（gzip 36.56）、`families-data` 独立 chunk 40.66 kB            |
| 6   | `npm audit`                                                                  | 0 vulnerabilities                                                                             |
| 7   | `npm ls --depth=0`                                                           | 无 extraneous / UNMET / invalid                                                               |
| 8   | `npm run check:version`                                                      | 5 处版本号一致（含 `package-lock.json`），Tauri npm↔crate 主次版本匹配                        |
| 9   | `cd src-tauri && cargo fmt --check`                                          | exit 0                                                                                        |
| 10  | `cargo clippy --all-targets -- -D warnings`                                  | exit 0                                                                                        |
| 11  | `cargo test`                                                                 | **108 passed**                                                                                |
| 12  | `npx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json` | 产出 `src-tauri/target/debug/lumina.exe`                                                      |
| 13  | `node scripts/upstream-diff.mjs`                                             | 请求体字段无增删；启动参数新增 `--model-dir`，已裁定不接并登记理由（`docs/UPSTREAM-SYNC.md`） |
| 14  | `npm run format:check`                                                       | 全库已格式化（Prettier 独立 commit 之后）                                                     |

## 2. P1 逐条核对（S-1 … S-11）

`99-final-report.md` 的 10 条 P1（+1 条同批 P2）全部有落地证据，明细表在
[98-fixes-status.md 第 1 节](./98-fixes-status.md)：监听别名绕过、输出目录白名单自指、
PuLID/PhotoMaker 死组件、`distilled-sd` 默认值、结果只在内存、设置往返丢字段、
提示词 token 截断、画廊 blob 泄漏、animated WebP 被当视频、LoRA 元数据永不匹配、
caps 缺键白屏。

## 3. 本轮新增的护栏（防止"修好了又退回去"）

| 护栏               | 位置                                   | 作用                                                                       |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------- |
| TS↔Rust 命令面契约 | `src/__tests__/contract.test.ts`       | 23 条命令双向断言，改名/漏注册立刻失败                                     |
| 版本号一致性       | `scripts/check-version.mjs`            | 5 处版本（含 lockfile）+ Tauri npm↔crate 主次版本                          |
| 上游漂移           | `scripts/upstream-diff.mjs`            | 参数/字段增删对比，`--coverage` 查字段覆盖                                 |
| 脚本类型门禁       | `tsconfig.node.json`                   | `allowJs` + `checkJs` 覆盖 `scripts/*.mjs`，随 `check:types` 一起跑        |
| CI                 | `.github/workflows/ci.yml`             | 类型 / lint / 测试 / 覆盖率门禁 / 构建 / 依赖审计 / Rust 三件套 / 上游漂移 |
| 日志落盘           | `src-tauri/src/logging.rs`             | release 无控制台，`lumina.log` 8 MB 滚动保留 3 份                          |
| 覆盖率阈值         | `vitest.config.ts`                     | 语句 60 / 分支 55 / 函数 55 / 行 62                                        |
| 格式一致性         | `.prettierrc` + `npm run format:check` | 唯一格式来源；ESLint 不启用格式规则，避免两套规则打架                      |
| 行尾一致性         | `.gitattributes`                       | 逐条列出扩展名（花括号模式在 gitattributes 里不生效），源码 LF 入库        |

## 4. 遗留项（2 项，均为产品决策，本轮明确不做）

- **F-22 i18n**：前提是 Rust 侧先做错误码化（`AppError { code, message }`），
  属于跨 20+ 命令的破坏性契约改动。没有真实二语需求时收益低于风险。
- **`webviewInstallMode` 离线安装**：改 `offlineInstaller` 会让安装包 +100 MB 左右；
  Win10+ 多数机器自带 WebView2，离线场景写进文档更划算。

除上述两项，10–60 六份报告里的 P0/P1/P2 与大部分 P3 均已落地，逐条证据见状态表。

## 5. 行为变化提醒（用户可知）

1. **结果默认不自动保存**（第十八轮按产品意图调整）：只有用户在控制台显式打开
   「生成完成后自动保存到输出目录」才会落盘；默认行为是"结果只在内存"，需要留档
   时点「保存到输出目录」。
2. **开发者工具**：release 构建 `devtools: false`；日常开发用 `npm run dev:desktop`
   （走 `tauri.dev.conf.json` 覆盖，devtools 打开）。
3. **保存设置会拒绝相对 `output_dir`**：必须是绝对路径。
4. **Tauri 三个 npm 包锁精确版本**：与 Rust crate 主次版本必须对齐，否则 `tauri build` abort。
5. **新增三个引擎控件**：`--threads`（0 = 内核按物理核数决定）、`--params-backend`、
   `--rpc-servers`。三者是**本机硬件配置**，只存全局设置，不随模型快照切换；
   形状不合法会在 GO/NO-GO 阶段拦下，不会带着坏参数启动。
6. **缓存/SLG 请求体更保守**：`scm_mask` 非法时**不下发**（上游解析器会崩内核）；
   SLG `layers` 未设置时省略该键，改为沿用服务端 `--skip-layers`。
7. **换行符**：源码一律 LF 入库；`.gitattributes` 修正后，Windows 工作区的 CRLF 由
   `core.autocrlf` 处理，不再出现"整文件重写"的 diff。
