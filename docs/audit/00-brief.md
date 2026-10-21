# Lumina 全面审查 · 共享简报（Lead 维护）

> 本文件由 Lead 编写，供各审查小组共享上下文。**只读**，不要修改。
> 各组只写自己名下那一份报告文件，不要改源码、不要改别人的报告。

## 1. 审查对象

- 仓库：`D:\Project\AmeowCAT\lumina`（git `master`，HEAD `d442371`，版本 `0.8.6`）
- 定位：`stable-diffusion.cpp`（上游 `sd-server`）的第三方桌面客户端。
  - 前端：Tauri 2 WebView 里的 React 18 + TypeScript + Zustand + Tailwind 4 + Radix UI + motion，Vite 8（rolldown）。
  - 后端：Rust（Tokio / reqwest / rfd），负责 `sd-server` 进程生命周期、模型扫描、
    家族识别、设置持久化、PNG 元数据、落盘，并把 `/sdcpp/v1` HTTP API 代理成
    类型化 Tauri 命令。
- 规模：前端 `src/**/*.ts,tsx` 约 20,100 行（含约 4,300 行测试）；Rust `src-tauri/src/*.rs` 约 7,120 行。
- 许可：AGPL-3.0-or-later。无 CI、无 lint 配置。

## 2. 上游项目（已克隆，可直接读）

- 路径：`C:\Users\Administrator\AppData\Local\Temp\lumina-audit\stable-diffusion.cpp`
- 上游 HEAD：`d55cc0f`（2026-10-18，`docs: update MOSS-Image docs`）
- 本仓库 README 声明对齐的上游提交：`f0aac52`（2026-10-17）
- 上游在 `f0aac52` 之后新增：`95b3090`（MOSS 拆分 QKV 权重 + host 侧批量加载，#2160）、
  `ab8d5ea`（Diffusers 格式 MiniMax-H3 LoRA，#2159）、`d55cc0f`（文档）。
- 关键上游文件：
  - `examples/server/api.md`（三种 API：OpenAI 兼容、WebUI/sdapi 兼容、`/sdcpp/v1`）
  - `examples/server/routes_sdcpp.cpp`、`routes_sdapi.cpp`、`routes_openai.cpp`、`async_jobs.cpp`、`runtime.cpp`
  - `examples/common/common.h`、`examples/common/common.cpp`（CLI 参数与解析）
  - `examples/cli/main.cpp`、`examples/cli/image_metadata.cpp`（PNG 元数据）
  - `docs/*.md`：每个模型家族一份，另有 `model_config.md`、`image_preprocessing.md`、
    `tokenizers.md`、`caching.md`、`sage_attention.md`、`adetailer.md`、`photo_maker.md`、
    `ip_adapter.md`、`pulid.md`、`backend_probe.md` 等
- 同类 GUI 参考（只作为 UX / 架构对照，不必逐条比对）：
  ComfyUI、AUTOMATIC1111 WebUI、SD.Next、InvokeAI、SwarmUI、Fooocus、sd.cpp-webui、
  KoboldCpp、LocalAI。

## 3. 审查目标

找出**所有值得优化的方面**，并按「与上游的关系」归类：

1. **对齐缺口**：上游已有能力，Lumina 没暴露 / 暴露错 / 版本门控错 / 家族识别漂移。
2. **一致性风险**：同一事实在 Rust 与 TS 各写一份、靠人工同步的地方。
3. **健壮性**：进程生命周期、错误处理、并发、跨平台、路径与安全边界。
4. **性能与内存**：大图 / 长视频 / 长队列 / 大模型目录下的行为。
5. **可维护性**：巨型文件、重复逻辑、命名、类型、测试覆盖结构。
6. **产品与体验**：上手路径、可发现性、无障碍、国际化。
7. **工程化**：构建、依赖、测试、CI、发布、文档。

## 4. 硬性要求

- **只读源码**。允许运行只读命令（`git log`、`grep`、`cargo check --offline` 请勿运行，
  见下方分工）。**不要修改任何源码或配置**。
- 每条结论必须给出**证据**：`文件:行号` + 关键代码片段（一行即可）。
  没找到证据的推测，放到「待验证假设」小节，不要混进正式结论。
- 严重级别：
  - **P0** 会导致用户数据丢失、启动失败、崩溃、安全边界被绕过，或明显错误的生成结果。
  - **P1** 功能缺口 / 上游已支持但界面没有，或某类用户（新用户、非 Windows、
    大模型目录）必然踩坑。
  - **P2** 性能、可维护性、一致性问题，影响面明确但不是阻塞级。
  - **P3** 打磨项（文案、命名、微小体验）。
- 不要重复 README 已写明的「已知限制」——那些是作者的自觉取舍。
  如果认为某个「已知限制」其实可解，请给出可解的**具体理由**与上游依据，那算 P1/P2。
- 不要输出「建议加 ESLint」这类没有上下文的通用建议；要说清**在本仓库里**
  哪一类缺陷会因此漏掉（举本仓库的真实代码为例）。

## 5. 报告格式（每组一份，Markdown）

```
# <主题> 审查报告
## 0. 结论摘要（≤10 条，每条一句话 + 级别）
## 1. 审查范围与方法
## 2. 问题清单
### 2.x <一句话标题>
- 级别：P?
- 位置：`path:line`
- 现状：（代码怎么写的，引一行）
- 问题：（为什么是问题，对应用户/维护者的具体后果）
- 上游/对照依据：（上游文件或同类项目做法，给出路径或链接）
- 建议：（可执行的最小改动；如果改动跨多文件，列出文件清单）
## 3. 待验证假设
## 4. 与其它组可能重叠的点（Lead 合并用）
```

## 6. 并行分工与写入边界

| 组            | 负责范围                                                                          | 只写这个文件                     |
| ------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| backend-rust  | `src-tauri/src/**`、`Cargo.toml`、`capabilities/`、`tauri.conf.json` 安全项       | `docs/audit/10-backend-rust.md`  |
| frontend-arch | `src/**`（除 `config/families.ts` 的家族数据本身）、`store.ts`、hooks、性能与内存 | `docs/audit/20-frontend-arch.md` |
| api-alignment | `/sdcpp/v1` HTTP 面：`types.ts`、`lib/requests*`、`api.ts`、能力探测与版本门控    | `docs/audit/30-api-alignment.md` |
| cli-families  | CLI 参数覆盖、`launchConfig.ts`、`config/families.ts`、`family.rs` 与上游家族文档 | `docs/audit/40-cli-families.md`  |
| ux-a11y       | 交互流、无障碍、国际化、主题、与同类 GUI 的对照                                   | `docs/audit/50-ux-a11y.md`       |
| build-test    | 构建、依赖、测试、CI、发布、文档、许可                                            | `docs/audit/60-build-test.md`    |

构建类命令的分工（避免互相抢锁）：

- 只有 **backend-rust** 可以跑 `cargo` 相关命令（`cargo fmt --check`、`cargo clippy`、`cargo test`）。
- 只有 **build-test** 可以跑 `npm`/`npx`/`vitest` 相关命令（`npx tsc --noEmit`、`npm test`、`npm ls`）。
- 其余组只做静态阅读，不跑构建。

## 7. 给各组的额外提示

- 代码注释里大量引用了上游 PR 编号（如 `#2059`、`#2093`）与历史审查代号
  （「对抗性审查 C」「审查 P3」「审查 L6」）。这说明已经历过多轮审查——
  **默认作者已经处理过显而易见的坑**，要找的是仍然存在的问题。
- README 的「已知限制」「遇到问题先看这里」两节是作者自述的边界，可作为背景。
- 特别关注「上游会漂移」的地方：字段改名、枚举值增删、默认值变化、
  参数单位变化、新增家族。Lumina 用运行时能力探测（capabilities）而不是版本号，
  这条策略本身的局限值得评估。
