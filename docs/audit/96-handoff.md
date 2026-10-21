# 交接备忘（给下一个会话）

> 写于第二十二轮末。上一版这份文档列了 10 项待办；本轮全部做完（拆分、三个 CLI
> 控件、F-18、生命周期测试、脚本类型门禁、Prettier），**只剩 2 项需要产品决策**。
> 新会话不必重新审计，先跑第 1 节确认基线，再看第 3 节。

## 1. 先确认基线是绿的（60 秒）

```bash
npm run check:types && npm run lint && npm test && npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

预期：`check:types` 0 / `lint` 0 error（52 warning 是既有基线） / **489** 前端用例
（42 文件） / build ≈1.3s，入口 `index` ≈112 kB（gzip ≈36.5） / cargo 三件套全绿 /
**108** Rust 用例。若不满足，先修基线，不要叠加新改动。

## 2. 现状一句话

P1 十条全修完；P2 与大部分 P3 已落地；状态表 `98-fixes-status.md` 逐条记证据，
总验收证据在 `97-verification.md`（14 行门禁矩阵）。剩余只有 2 项产品决策，见下。

## 3. 剩余 2 项：都需要先问产品，不要顺手改

### A. F-22 i18n（`50-ux-a11y.md`）

- **为什么没做**：前提是 Rust 侧先把 20+ 条命令的错误从「直接返回中文字符串」改成
  `AppError { code, message }`，前端再做 code→文案映射。这是跨前后端的破坏性契约
  改动（`src/api.ts` 的每个 `invoke` 调用点、`contract.test.ts`、大量断言都要动），
  没有真实二语需求时收益低于风险。
- **将来怎么开工**：第一步只做 Rust 错误码层（新增 `AppError` 枚举 + `code` 字段，
  保留 `message` 作为兜底文案），前端做 `code → 文案` 映射并保留原文兜底；
  第二步再抽界面文案键 + 语言切换。

### B. `webviewInstallMode` 离线安装（`60-build-test.md` §2.14）

- 当前是 `downloadBootstrapper`（安装时联网下 WebView2）。
- 改 `offlineInstaller` 能让离线机器装上，但每个发布包 +100 MB 左右，构建也变慢。
- 决定：保持现状。若将来要做，改 `src-tauri/tauri.conf.json` 的 `bundle.windows`
  一处即可，同时在 README 的「离线安装」段落里写清前提。

## 4. 不要动的地方（已经过验证的约定）

- `src/config/families.data.ts` 是**纯数据**，逻辑在 `families.ts`；不要让 data 反向依赖逻辑。
- 内存预算只有一个来源：`src/lib/memoryBudget.ts`。不要在 hook/组件里另写魔数。
- Tauri 三个 npm 包锁精确版本，与 crate major.minor 必须对齐（`check-version` 会验）。
- `src/api.ts` 的 `invoke("…")` 与 `lib.rs` 的 `generate_handler!` 由契约测试双向绑定。
- `autoSaveResults` 默认**关**（用户确认）；语义是 `=== true` 才开。
- `threads` / `paramsBackend` / `rpcServers` 只存**全局设置**，不进
  `ModelConfigSnapshot`——它们是本机硬件配置，不该随模型切换漂移。
- `scm_mask` 的客户端校验是**安全边界**：上游 `parse_scm_mask` 无 try/catch 且跑在
  worker 线程，非法值会让 sd-server `terminate`。任何"放宽校验"的改动都要先读
  `docs/audit/95-f18-semantics.md`。
- SLG `layers` 未设置时**省略该键**（硬塞 `[7,8,9]` 会顶掉服务端 `--skip-layers`；
  空数组在上游等于关闭 SLG，所以也绝不能发 `[]`）。
- 格式只有一个来源：Prettier（`npm run format:check` 进门禁）。ESLint 不启用格式规则。
- 换行符：源码 LF 入库。`.gitattributes` 里**不能**写 `*.{ts,tsx}` 这种花括号模式
  （gitattributes 不支持展开），新增扩展名要逐条加。
