# 修复进度（按 2026-10 审查报告）

> 规格以 `99-final-report.md` 与六份领域报告为准；本文件只记录「哪一条改完了、证据是什么、还差什么」。
> 总验收证据（可复跑的门禁矩阵、13 项检查）见 [97-verification.md](./97-verification.md)。
> 状态：✅ 已修并验证 / 🟡 部分修 / ⬜ 未开始
> 新会话接手请先看 [96-handoff.md](./96-handoff.md)（基线命令 + 剩余项开工指引）。

## P1（10 条）——全部完成

| 编号 | 内容 | 修复位置 | 验证 |
|---|---|---|---|
| S-1 | `-l` 绕过监听守卫 | `src-tauri/src/server.rs`（`LISTEN_OVERRIDE_FLAGS` + `is_listen_override`） | 单测 `build_args_rejects_the_listen_short_alias`（含 `-log-level` 负例） |
| S-2 | 任意写→任意执行链 | `save.rs` 扩展名白名单、`settings.rs::validate_output_dir`、`server.rs::exe_trusted_without_probe`、移除 `ad-model` 路径校验 | 3 个单测 + `cargo test` |
| S-3 | PuLID/PhotoMaker 死组件 | `families.ts` 删除 sd/sdxl 上的两个组件位；README 已知限制写明原因 | `npm test`、tsc |
| S-4 | `distilled-sd` 错误默认值 | `families.ts` 改中性默认值 + `generationHint` 说明 SDXS 需手改 | tsc |
| S-5 | 结果只在内存 | `settings.autoSaveResults`（TS + Rust，**默认关**，用户确认）+ `autoSaveEntry` + Dashboard 开关 | `useJobPolling` 路径 + 单测（Rust 侧 round-trip） |
| S-6 | 设置往返丢字段 / `{}` 清空快照 | `settings.rs::save_to` 改为「读旧 JSON → merge → 原子写」+ `schemaVersion` | 单测 `save_merges_unknown_keys_and_keeps_model_snapshots` |
| S-7 | 提示词 token 静默截断 | `PromptDock` 估算计数 + 家族上限（`FAMILY_CONFIG[*].promptTokenLimit`，Iris 300） | 新增 4 条 PromptDock 测试 |
| S-8 | 历史画廊 blob 泄漏 | `HistoryGallery` 卸载 revoke + `disposed` 守卫 + 惰性缓存初始化 | 新增 revoke 断言测试 |
| S-9 | animated WebP 被当视频 | `ResultsGrid`/`Lightbox` 按 mime 分流 + AVI 提示 | 新增 3 类 mime 测试 |
| S-10 | LoRA 元数据永不匹配 | `utils.ts::matchAvailableLora` + 修正假夹具 + 新增归一化用例 | `utils.test.ts` |
| S-11 | caps 缺键白屏 | `GenerationUI` 降级链 `defaults_by_mode → defaults → 家族预设` + toast + `Capabilities.defaults` 类型 | tsc（该路径无测试，见「剩余」） |

## 同批（报告 §0.3 注记 / 批次 A·B）

| 项 | 状态 | 证据 |
|---|---|---|
| 发布包 WebView Inspector | ✅ | `tauri.conf.json` 窗口 `devtools:false` + `devDependencies` 里的 dev 覆盖配置 `src-tauri/tauri.dev.conf.json`（`npm run dev:desktop`） |
| CSP 收紧 | ✅ | 删除 `connect-src http://127.0.0.1:*`，补 `object-src/base-uri/frame-ancestors`，新增 `devCsp` 供 Vite HMR |
| `cargo fmt` / `clippy -D warnings` | ✅ | 两者 exit 0；`cargo test` 95 passed |
| CI | ✅ | `.github/workflows/ci.yml`（前端 + Rust + 上游漂移提示） |
| 版本号门禁 / tag 断言 | ✅ | `scripts/check-version.mjs`（含 Tauri npm↔crate 主次版本检查），`npm run build` 前执行；`--release` 断言 tag |
| lockfile | ✅ | 重新生成 + `npm ci` 干净安装；`npm ls` 无 extraneous/UNMET；`npm audit` 0 |
| Tauri 依赖对齐 | ✅ | npm 侧三包改精确版本（`npm update` 曾把 api 升到 2.12 导致 `tauri build` abort） |
| 上游漂移检测 | ✅ | `scripts/upstream-diff.mjs`（drift + coverage 两种模式，实测输出见交付说明）+ `docs/UPSTREAM-SYNC.md` |
| README/文档 | ✅ | 家族数 58→60、补 LLaDA-Image / SenseNova U1.5 与前置条件、PuLID/PhotoMaker 限制、自动保存、CI、对齐号 `d55cc0f` |
| 仓库治理 | ✅ | `CHANGELOG.md`、`SECURITY.md`、`CONTRIBUTING.md`、`.github/ISSUE_TEMPLATE/bug.yml` |
| 键盘 F-01/F-02/F-03 | ✅ | `useKeyboardShortcuts` 改 `e.code` + 认 `metaKey` + 尊重 `defaultPrevented` + 浮层门禁（参数面板放行提交） |
| 日志面板 §2.4 | ✅ | `logs` 改 `{id,text}[]` 稳定 key；新增「复制全部日志」；`aria-live` 关掉；`jobs` 改标量 selector |
| Dashboard §2.6 | ✅ | 去掉 `jobs`/`results` 整数组订阅，点击时 `getState()` |
| features 极性 / output_format | ✅ | `featureEnabled()` 统一显隐与提交；`reconcileOutputFormat()` 按 caps 收敛 |
| mage-flow | ✅ | Base 默认 30 步；补 16 像素对齐 |

## 第二轮（P2 批次，部分）

| 项 | 状态 | 证据 |
|---|---|---|
| 20-frontend §2.7 App 3s 轮询 | ✅ | `checkBusy` 互斥；控制台内的"不可达"不再弹红色"连接已断开"（只在工作室里失联才报） |
| 20-frontend §2.9 params 防抖丢改动 | ✅ | `pendingParamsWrite` + `flushParamsWrite()`，切 mode 前强制落盘 |
| 20-frontend §2.3 jobs `config.images` 预算 | ✅ | `trimJobsToBudget()`（256 MB，从最旧剥离）接在 `store.setJobs`，+2 测试 |
| 20-frontend §2.15 卡片显影动画 | ✅ | 去掉 `filter: saturate()` 与每卡 `layout`，只留 opacity+scale（合成属性） |
| 30-api §2.8 队列位次 / 真实耗时 | ✅ | `Job.queue_position/started/completed` + `jobElapsed()`；排队时显示 `#N`，+2 测试 |
| 30-api §2.6 附带 `fps` 缺省 | ✅ | 24 → 16（对齐上游 `common.h:249`） |
| 10-backend §2.19 无调用方命令 | ✅ | 删除 `parse_png_metadata`（Rust 命令 + `api.ts` 封装） |
| 10-backend §2.6 心跳自残 | ✅ | `sdcpp.rs` 的 capabilities 兜底加 30s 负缓存（连续 3 次失败后节流），+1 测试 |
| 10-backend §2.7 日志背压 | ✅ | `MAX_PENDING_LINE`(8 KiB) 强制切行 + progress 去重，+2 测试 |
| ux F-04/F-05/F-13 对比度与字号 | ✅ | `--color-muted` 提亮（lumina #9a9184 / vostok oklch .66）、placeholder 专用色、form-label/field-hint/result-meta 各提 1px、vostok 主 CTA 底色压深至 ≈6:1 |
| ux F-06 `aria-modal` | ✅ | ParamsSheet / QueueDrawer |
| ux F-07 折叠面板 Tab 序 | ✅ | `Panel` 折叠时对 body 设 `inert`（用 ref，避免 testing-library 把面板当隐藏） |
| ux F-09 日志 aria-live | ✅ | 改为 `off`（生成进度另有 ProgressBar 的 aria-valuetext） |
| ux F-10 动效偏好 | 🟡 | 根节点本来就有 `MotionConfig reducedMotion="user"`（审查报告这条判断有误）；真正漏的是 `filter` 动画，已随 §2.15 去掉 |
| ux F-15 不可见命中区 | ✅ | 卡片动作条 `opacity:0` 时同时 `pointer-events:none` |

## 第三轮（Rust 可用性 + 协议 UI）

| 项 | 状态 | 证据 |
|---|---|---|
| 10-backend §2.5 日志落盘 | ✅ | 新增 `logging.rs`：`%LOCALAPPDATA%/lumina/logs/lumina.log`，8 MB 滚动 + 3 份历史，sd-server 每一行与启动命令行都落盘，+3 测试（含一次真实写文件） |
| 10-backend §2.4 退出卡顿 | ✅ | `RunEvent::Exit` 改用 `try_lock()`；拿不到锁时交给 JobObject / PR_SET_PDEATHSIG 兜底，不再阻塞事件循环最长 35s |
| 10-backend §2.8 画廊整读 | ✅ | `png_info` 先只读 256 KiB 头部，命中即返回；仅当元数据在 IDAT 之后才整读兜底，+2 测试（大文件头命中 / IDAT 后兜底） |
| 30-api §2.9 视频时间维分块 | ✅ | `AdvancedSamplingPanel` 新增开关 + 帧数/重叠两个输入，读写 `extra_tiling_args`；`tilingArgValue`/`setTilingArgValue` +2 测试 |
| 30-api §2.9 数据层 | ✅ | `types.ts` 的 `VaeTilingParams` 早已有 `temporal_tiling`/`extra_tiling_args`，本轮补上唯一的 UI 入口 |

## 第四/五轮（跨平台、探测锁、隐私开关）

| 项 | 状态 | 证据 |
|---|---|---|
| 10-backend §2.10 链接目录 | ✅ | `scanner.rs`：`file_type.is_symlink()` 时按 `fs::metadata` 判目标类型（跟随链接），并用规范化 `visited_dirs` 集合防环、记一条 `directory_already_visited` 警告；+1 Unix 测试（symlink 跟随且只扫一次） |
| 10-backend §2.13 探测锁 | ✅ | `cli.rs::probe`：锁只保护缓存读写，探测（两次 spawn，各 5s）在锁外；缓存改按 exe 路径索引的 HashMap，来回切内核不再必然 miss |
| 10-backend §2.9 跨平台路径 | ✅ | `dir_is_within` 的 canonicalize 分支改 `Path::starts_with`（非 UTF-8 路径不再恒拒）；`replace('\\', "/")` 在 `lib.rs` 三处与 `scanner::to_slash` 加 `cfg!(windows)` |
| 30-api §2.10 元数据隐私 | ✅ | `OutputPanel` 新增「写入生成参数元数据」开关（img_gen 与 vid_gen 都生效；此前 img 恒 true、视频根本不发该字段） |
| 50-ux F-18 VACE 强度 | ✅ | `ImageInputsPanel` 在条件帧区域新增「VACE 条件强度」滑杆（请求体一直会发 `vace_strength`，此前无控件） |

## 第六轮（工程护栏 + 陈旧枚举）

| 项 | 状态 | 证据 |
|---|---|---|
| 60-build §2.5 TS↔Rust 命令面 | ✅ | 新增 `src/__tests__/contract.test.ts`：正则抽 `api.ts` 的 `invoke("…")`、`lib.rs` 的 `generate_handler![]` 与 `#[tauri::command]`，双向断言（23 条命令）——改名时立刻失败 |
| 60-build §2.11 构建配置类型 | ✅ | 新增 `tsconfig.node.json`（vite/vitest 配置此前不在任何 project 内）；`npm run check:types` 两套 project 一起查，接进 `build` 与 CI |
| 60-build §2.12 覆盖率 | ✅ | 装 `@vitest/coverage-v8` + `npm run test:coverage`，实测基线：语句 65.8% / 行 67.3% / 分支 62.4% / 函数 59.4%；`coverage/` 已 gitignore |
| 30-api §2.7 陈旧 sampler/scheduler | ✅ | `SamplingPanel` 对不在 caps 列表里的持久值标「（当前内核不支持）」并给 `role="alert"` 提示（内核会静默忽略），+1 测试 |

## 第七轮（结构调整 + 同步接口反馈）

| 项 | 状态 | 证据 |
|---|---|---|
| 10-backend §2.22 `server.rs` 拆分（第一步） | ✅ | 日志管道整体抽到 `src-tauri/src/log_pipe.rs`（251 行：ANSI 清理、`server-log` 事件、单行上限、进度去重、落盘）；`server.rs` 2209 → 1971 行；相关测试一并迁移，103 个 Rust 测试全绿 |
| 30-api §2.12 放大耗时反馈 | ✅ | `UpscaleDialog` 在同步执行期间显示已耗时秒数（`放大中… 12s`），用假定时器测试锁定；误导性重复提示未加——界面本来就有 `role="status"` 的"不可取消"说明（报告这条只缺时间参照） |

## 第八轮（`server.rs` 拆分完成）

| 项 | 状态 | 证据 |
|---|---|---|
| 10-backend §2.22 余项：argv 拼装与校验 | ✅ | 抽出 `src-tauri/src/args.rs`（675 行）：`build_args`、`split_args`、路径/显存/后端三类校验、`refine_component_dirs`、`adapt_flash_attn_for_kernel`、`extra_arg_values`；`server.rs` 2209 → **1307 行**（-41%），只剩进程管理、可执行文件解析、JobGuard/Unix 看护与 `ServerManager` |

## 第九轮（ESLint 接入）

| 项 | 状态 | 证据 |
|---|---|---|
| 60-build §2.7 ESLint | ✅ | 新增 `eslint.config.js`（扁平配置：`@eslint/js` + `typescript-eslint` + `react-hooks`）；接入 `npm run lint` 与 CI。首轮 56 个问题 → **0 error / 52 warning**（React 19 建议类与 `exhaustive-deps` 降为 warning 但可见） |
| 修掉的真实缺陷 | ✅ | ① `HistoryGallery` 的局部回调改名 `applyAsInitialImage`（原名以 `use` 开头，被 `rules-of-hooks` 判为"在回调里调 Hook"）；② `useModelSwitch` 的 `throw new Error` 补 `{ cause }`（原来丢失原始堆栈）；③ `tsconfig.json` lib 提到 ES2022 以支持 `ErrorOptions` |
| 60-build §2.7 Prettier | ⏳ | 明确延后并在 CONTRIBUTING 写明原因：全库格式化必须单独做一个无逻辑改动的 commit，否则无法审阅 |

## 第十轮（`families.ts` 拆包）

| 项 | 状态 | 证据 |
|---|---|---|
| 20-frontend §2.11 家族数据离开入口 chunk | ✅ | 拆成 `src/config/families.data.ts`（2062 行，纯数据表 + 类型）与 `src/config/families.ts`（63 行，4 个纯函数 + `export *`，调用方导入路径不变）；Vite `codeSplitting.groups` 增 `families-data` 组 |
| 实测收益 | ✅ | 入口 chunk **151.96 kB → 111.39 kB（-27%）**、gzip 44.62 → 36.13 kB；`families-data` 独立 40.66 kB（gzip 8.64 kB），逻辑改动不再让整张表失效缓存 |

## 第十一轮（虚拟滚动键盘可达）

| 项 | 状态 | 证据 |
|---|---|---|
| 50-ux F-08 虚拟滚动键盘/读屏可达 | ✅ | `HistoryGallery` 的虚拟网格改为 `role="group"` + `tabIndex={0}` + `aria-rowcount`，容器上处理 `PageUp/PageDown/Home/End` 翻页（翻页后新瓦片挂载并进入 Tab 序）；新增 `sr-only` 的 `role="status"` 播报「共 N 项，当前显示第 X–Y 项；按 PageUp / PageDown 翻页」；+2 测试（可聚焦/播报范围、按键不抛异常） |

## 第十二轮（检查单定位 + 错误文案中文化）

| 项 | 状态 | 证据 |
|---|---|---|
| 50-ux F-14 检查单定位到控件 | ✅ | `Dashboard.revealSection(ref, focusFirstField)`：滚动+闪烁后展开区域内第一个折叠面板（`.panel.collapsed .panel-head` 点击，与用户手动操作同一条路径），rAF 后聚焦该区域第一个可填控件；「还缺 N 个必需配置」旁新增「去填写」按钮；检查单「组件」行也改为带聚焦；+1 测试 |
| 50-ux F-19 英文裸串 | ✅ | Rust 侧 9 条用户可见错误改为中文（`args.rs` 未闭合引号/路径不存在、`scanner.rs` 目录不可用、`sdcpp.rs` 任务 ID/生成模式、`server.rs` 找不到或不可执行 sd-server、`settings.rs` 序列化/替换失败、`png_info.rs` 非 PNG/文件过大）；3 处断言同步更新 |
| 50-ux F-20 缺"下一步" | ✅ | 每条错误都带可执行的下一步（"请在控制台重新选择内核路径"、"Linux/macOS 可用 chmod +x"、"请在设置里重新选择模型目录"…） |

## 第十三轮（toast 合并 + 覆盖率门禁）

| 项 | 状态 | 证据 |
|---|---|---|
| 50-ux F-21 toast 生命周期 | ✅ | `store.toast` 对"同文案 + 同级别"就地合并：保留原卡片、重置消失计时器、`count+1`；`Toast.tsx` 渲染 `×N`；+3 测试（合并计数、不同文案不合并、错误级别不与非错误合并） |
| 60-build §2.12 覆盖率门禁 | ✅ | `vitest.config.ts` 设阈值（语句 60 / 分支 55 / 函数 55 / 行 62，低于实测 66.3/62.7/60.2/67.8 以防回退）；CI 增「覆盖率门禁」步骤；`npm run test:coverage` 通过 |
| 60-build §2.13 Dashboard 测试耗时 | 🟡 | 已定位瓶颈并尝试优化（共享 `userEvent` 实例 + `delay: null`）：无效，仍 17.4s——耗时来自 19 个用例各自渲染整个 Dashboard（多个 Radix Select 门户）。正解是把该文件按 describe 拆成多个文件让 vitest 并行跑，属纯测试结构改动，留待单独一轮 |

## 第十四轮（家族识别边界）

| 项 | 状态 | 证据 |
|---|---|---|
| 40-cli §2.6 家族识别的裸子串误判 | ✅ | `family.rs` 新增 `has_word()`（匹配处前一个字符不能是字母数字、后一个不能是小写字母），`anima` / `wan` 改用它——`animation-motion.safetensors` 不再被当成 Anima、`taiwan-style-v1` 不再被当成 Wan；`anima_pony`、`wan2.1-t2v`、`wan-ti2v` 等正例仍命中 |
| 40-cli §2.6 `flux-1-dev` 无命中 | ✅ | FLUX.1 规则补 `flux-1-` / `flux-1_` / `flux-1-dev` / `flux-1-schnell`（官方文件名用连字符，旧规则只认 `flux1-` / `flux.1-` / `flux1_`，会落到 `custom`）；+2 测试 |

## 第十五–十八轮（总验收 + 按用户决策调整默认值）

| 项 | 状态 | 证据 |
|---|---|---|
| 总验收 | ✅ | 13 项门禁全绿并逐条记录在 [97-verification.md](./97-verification.md)；含 `tauri build --debug` 产出 `lumina.exe`、上游漂移检查 |
| S-5 自动保存默认值 | ✅ | 按用户确认改为**默认关**：Rust 侧去掉 `#[serde(default = "default_true")]`、`Settings::default()` 置 false、单测改名为 `auto_save_results_defaults_to_false_and_round_trips`；前端判定改 `=== true`（`useJobPolling` / Dashboard 开关 / 类型注释），README 与验证文档同步 |

**用户确认的下一批优先级**：① CLI 控件与 extraArgs 补全（§2.5/§2.9）；② 内存预算总账（§2.2）；③ Dashboard 测试拆分提速（§2.13）；④ F-18 余项控件（`shifted_timestep` / `cache_option` / SLG 细项）。

## 第十九轮（附加启动参数补全）

| 项 | 状态 | 证据 |
|---|---|---|
| 40-cli §2.5 extraArgs 无补全 | ✅ | `Dashboard` 用 `api.inspectServer(exeDir)` 取内核 `--help` 的选项名（后端已有 30s 缓存），渲染成 `<datalist>` 挂在「附加启动参数」输入框上；提示文案在拿到选项后改为「按 ↓ 可从当前内核的 N 个选项里补全」；探测失败静默（启动流程会给更准确的报错）；+1 测试断言 datalist 内容与 `list` 属性 |

## 第二十轮（内存预算总账）

| 项 | 状态 | 证据 |
|---|---|---|
| 20-frontend §2.2 内存预算一本账 | ✅ | 新增 `src/lib/memoryBudget.ts`：`MEMORY_BUDGET` 五层份额（结果 640 MB / 任务 128 MB / 缩略图 128 MB / 原图 384 MB / 视频 384 MB），`MEMORY_BUDGET_TOTAL` 求和 = 1664 MB。原先五处互不知情的预算（合计约 2.4 GiB）改为从这本账取值：`useJobPolling.MAX_RESULTS_BYTES`、`utils.MAX_JOB_CONFIG_BYTES`、`HistoryGallery` 的三个 `ByteBudgedCache` 上限 |
| 可预期上限 | ✅ | 渲染进程内存上限从"逐层叠加到 2.4 GiB"变为**单一天花板 ≈1.6 GiB**；+3 测试（总和等于账面、≤1.75 GiB、每层为正且结果层最大）——调大任一层或漏记一层都会失败 |

## 第二十一轮（F-18 `shifted_timestep` 入口）

| 项 | 状态 | 证据 |
|---|---|---|
| 50-ux F-18 `shifted_timestep` | ✅ | `AdvancedSamplingPanel` 新增「Shifted Timestep」滑杆（0–1000、步进 10、0 = 内核默认），写 `sample_params.shifted_timestep`；`GenerationParamsSheet` 传入 `sp?.shifted_timestep`；+1 测试。该字段一直随请求体发送（`utils.ts:1011`），此前界面无处可改 |

## 剩余（下一轮起）

**Rust（`10-backend-rust.md`）**
- 无剩余 P2（§2.22 已在第七/八轮拆成 `log_pipe.rs` + `args.rs`，`server.rs` 2209 → 1307 行）

**前端（`20-frontend-arch.md`）**
- §2.12 生命周期/订阅层测试缺口（`useBlobUrlCache`、App 阶段机、快捷键）

**协议（`30-api-alignment.md`）**
- §2.9 余项：`cache_option` / `scm_mask` 控件（需要先确认上游语义，见缓存文档）

**CLI / 家族（`40-cli-families.md`）**
- §2.9 `--threads` / `--params-backend` / `--rpc-servers` 无控件（extraArgs 补全已在第十九轮完成）

**体验（`50-ux-a11y.md`）**
- F-18 余项：`cache_option` / `scm_mask`（需先核上游语义）、SLG 细项（`shifted_timestep` 已补）
- F-22 i18n（需先做"Rust 错误码化"这一层，属于产品级决策，单独立项）

**工程化（`60-build-test.md`）**
- §2.7 Prettier（需一次全库格式化，单独 commit；已接入的 ESLint 不启用格式规则）
- §2.11 余项：`scripts/*.mjs` 无类型检查（目前靠 `--check` dry-run 兜底）
- §2.13 `Dashboard.test.tsx` 17s（瓶颈已定位：19 个用例各渲染整个 Dashboard；正解是按 describe 拆文件并行跑）
- §2.14 `webviewInstallMode`（离线安装）


