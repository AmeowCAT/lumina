# 交接备忘（给下一个会话）

> 写于第二十二轮末。当前会话上下文接近上限，大改动风险高于收益；这份备忘让新会话
> 能**直接开工**，不必重新审计。

## 1. 先确认基线是绿的（60 秒）

```bash
npm run check:types && npm run lint && npm test && npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

预期：`check:types` 0 / `lint` 0 error / **408** 前端用例 / build ≈1.3s /
cargo 三件套全绿 / **105** Rust 用例。若不满足，先修基线，不要叠加新改动。

## 2. 现状一句话

P1 十条全修完；P2 约 44 条、P3 大部分已修；状态表 `98-fixes-status.md` 记录
63 项 ✅ 与 10 项剩余（每项都写了为什么还没做）。总验收证据在 `97-verification.md`。

## 3. 剩余 10 项，按"可直接开工"排序

### A. `Dashboard.test.tsx` 拆分（60-build §2.13）— 建议第一个做
- **现状**：单文件 ~700 行、19+ 用例串行跑 16–17s，占全量约 80%。
- **已证伪的假设**：共享 `userEvent` + `delay: null` 无效（实测 17.4s 不变）。
- **正解**：把该文件按 `describe` 拆成 3 个文件（onboarding 校验 / 启动参数 / 快照与还原），
  共享的 `mocks`、`settings`、`scanFor`、`pickOption` 抽到
  `__tests__/dashboardTestKit.tsx`（用 `vi.hoisted` 保持 mock 提升语义）。
- **注意**：`vi.mock` 必须留在各测试文件里（提升到模块顶层），kit 只导出
  `mocks`/`settings`/`scanFor`/`pickOption` 这类非 mock 声明。
- **验收**：3 个文件各自通过；`npm test` 总时长下降（vitest 默认按文件并行）。

### B. §2.9 三个 CLI 控件（`--threads` / `--params-backend` / `--rpc-servers`）
- 模式参照现有 `maxQueueSize`/`sdPort`：`Settings`（Rust + TS）加字段 →
  `args.rs::build_args` 映射 → Dashboard「引擎」区加控件 → `settings.rs` 单测往返。
- `--threads`：正整数，0/空 = 不传（让内核按 CPU 核数决定）。
- `--params-backend` / `--rpc-servers`：字符串，入参前用现有 `validate_path_arg`
  之外的后端名校验（`backend_spec_static_error` 已可复用）。

### C. F-18 `cache_option` / `scm_mask` / SLG 细项
- **必须先核对上游语义**：`docs/audit/30-api-alignment.md` 对应小节只是标注了
  "无控件"，没有定义取值域。去 `stable-diffusion.cpp` 的 `examples/server/api.md`
  与 `cache_*.h` 查清 `cache_option` 是枚举还是 `key=value` 串，再决定用 Select 还是文本。
- `scm_mask`：确认是 bool 还是路径。

### D. §2.12 生命周期/订阅层测试
- 三个空白点：`useBlobUrlCache`（revoke 时机）、App 阶段机、`useKeyboardShortcuts`。
- 建议先写 `useBlobUrlCache`：它是内存泄漏的守门人，且可纯 hook 测试。

### E. 需要产品决策（做之前先问）
- **F-22 i18n**：先做 Rust 错误码化（`AppError { code, message }`），前端做 code→文案映射。
  这是跨 20+ 命令的契约改动，不要顺手改。
- **Prettier**：`prettier --write .` 必须单独一个 commit，且在该 commit 前先合并其它改动。
- **`webviewInstallMode`**：`offlineInstaller` 会让安装包增加约 100 MB。
- **`scripts/*.mjs` 类型检查**：要么转 .ts，要么加 `// @ts-check` + jsconfig。

## 4. 不要动的地方（已经过验证的约定）

- `src/config/families.data.ts` 是**纯数据**，逻辑在 `families.ts`；不要让 data 反向依赖逻辑。
- 内存预算只有一个来源：`src/lib/memoryBudget.ts`。不要在 hook/组件里另写魔数。
- Tauri 三个 npm 包锁精确版本，与 crate major.minor 必须对齐（`check-version` 会验）。
- `src/api.ts` 的 `invoke("…")` 与 `lib.rs` 的 `generate_handler!` 由契约测试双向绑定。
- `autoSaveResults` 默认**关**（用户确认）；语义是 `=== true` 才开。
