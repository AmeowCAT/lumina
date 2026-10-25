# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号以 `package.json` 为唯一来源，历史条目按 git tag 回溯补齐到 0.8.6。

## [Unreleased]

（下一轮的改动写这里。发版时把本节改成 `## <版本号> — <日期>`，并在上方新开一个空的
`[Unreleased]`。）

## 0.9.1 — 2026-10-24

### 同步上游 `95ff762`（2026-10-23）

- **正确性**：任务时间戳 `created` / `started` / `completed` 兼容上游 #2176 起的
  **毫秒**单位（`toEpochMs`），旧内核的秒级值仍然算得对；修掉耗时显示变成 1000 倍
  或恒为 0 的问题。
- **交互**：支持中断正在生成的任务（上游 #2190）。取消接口返回 200 +
  `cancel_requested` 后，任务行显示「中断中…」并禁用重复点击，等内核在采样检查点停下。
- **正确性**：更正 ADetailer 的旧裁定（上游 #2164）：`--ad-model` 现在会让 sd-server
  在每次图片生成后自动检测 + 局部重绘，写在附加启动参数里会在启动前给出警告；
  `--ad-model` 也重新纳入路径存在性预检。
- **新增**：TAE 仅用于采样预览（`--taesd-preview-only`，上游 #2184）。控制台开关，
  未选 TAE 组件时禁用；最终图仍由完整 VAE 解码。
- **新增**：Fibo 2.0 Dev / Edit Turbo 家族（上游 #2180），家族数 60 → 62。
- **正确性**：MiniT2I 的尺寸由内核强制 512×512（上游 #2189），界面锁定为只读展示，
  提交时同样强制，不再出现「显示 1024、实际 512」。
- **新增**：MiniMax-H3 视频参考图尺寸（`ref_image_size=match|max`，上游 #2177）与
  Wan2.2 TI2V 5B 的组解码帧数（`temporal_decode_frames`，上游 #2196）。
- **工程化**：设备预检在找不到设备名时按 `--rpc-servers` 补探一次（上游 #2182）；
  `upstream-diff.mjs` 新增语义漂移检查（时间戳单位、`cancel_generating`、ADetailer）。
  分析与落地记录见 `docs/UPSTREAM-SYNC-2026-10-24.md`。

### 修复

- **正确性**：数字输入框与滑杆统一收敛浮点尾巴——上游默认值/PNG 元数据里的
  `0.00999999999776482582`、`0.20000000298023224` 现在显示为 `0.01`、`0.2`；
  覆盖 SLG 起止比例、LoRA 强度、缓存阈值等所有 `NumberInput` 字段，以及顶栏
  CFG chip 与滑杆读数。滑杆也改为按 6 位有效数字显示，不再先把 `0.875` 舍成 `0.88`。

## 0.9.0 — 2026-10-22

### 修复（来自 2026-10 全面审查，见 `docs/audit/`）

- **安全**：`--listen-ip` 的短别名 `-l` 不再能绕过监听守卫被写进「附加启动参数」，
  避免 sd-server 无鉴权对局域网开放。
- **安全**：`save_settings` 校验输出目录（绝对路径、不含 `..`），`save_output` 只接受
  图片/视频扩展名，`start_server` 的免探测快速通道收敛到 `exeDir` 子树，切断
  「任意写 → 任意执行」链；发布包关闭 WebView Inspector，CSP 不再放行任意本地端口。
- **数据**：设置写盘改为「读旧 JSON → 合并 → 原子写」，并加 `schemaVersion`；
  `save_settings({})` 不再清空按模型保存的组件/参数快照。
- **数据**：生成结果默认自动保存到输出目录（控制台可关），关闭窗口/刷新不再整批丢失。
- **正确性**：`vid_gen` 的 animated WebP 结果按 `mime_type` 走 `<img>`，不再永远黑屏；
  AVI 输出给出「浏览器多半不能播，建议下载」提示。
- **正确性**：从 PNG 元数据恢复 LoRA 时归一化比较（stem ↔ 含扩展名文件名），
  之前所有 LoRA 都被静默丢弃。
- **正确性**：capabilities 缺 `defaults_by_mode` 时按 `defaults` → 家族预设降级，
  不再白屏；`output_format` 按 `output_formats_by_mode` 收敛，避免跨内核切换后
  每次提交 400；`features` 的面板显隐与提交裁剪改用同一个判定函数。
- **正确性**：`distilled-sd` 默认参数从「1 步 / CFG 1 / 512²」改为中性值——
  那套参数只对 SDXS 成立，SSD-1B / Vega 会直接出糊图。
- **正确性**：移除 PuLID / PhotoMaker 组件位。它们的身份参数是生成级参数，
  上游 `/sdcpp/v1` 不开放，权重能加载但身份永不注入且几乎没有日志。
- **正确性**：`mage-flow`（Base）默认 30 步，并补上 16 像素对齐。
- **性能**：历史画廊的 blob 缓存随组件卸载释放（此前每次切 tab 永久泄漏一份，
  单次最多 512 MB）；缩略图完成不再整表复制缓存。
- **可用性**：提示词框显示估算 token 数与家族上限（Iris-3B 300），超限变色提示。
- **工程化**：新增 CI（类型/测试/构建/漏洞 + Rust fmt/clippy/test）；
  `npm run build` 前校验 5 处版本号一致；新增 `scripts/upstream-diff.mjs` 检上游漂移。
- **可用性/性能（第二轮）**：任务队列显示内核排队位次（`#N`），耗时改用
  `completed - started` 的真实采样时长；切换生成模式不再丢失防抖窗口内的参数改动；
  任务侧的图片输入按字节预算回收；结果卡片的显影动画改用合成属性（去掉
  `filter: saturate()` 与逐卡 `layout`）；日志面板可一键复制全部日志、行 key 稳定；
  对比度与字号按 WCAG AA 修正（次级文字、占位符、vostok 主按钮），折叠面板从 Tab 序
  移除（`inert`），参数面板/队列抽屉补 `aria-modal`。
- **稳定性（第二轮）**：`server_status` 的 3 秒轮询加互斥，切模型时不再误报"连接已断开"；
  能力探测兜底加 30 秒负缓存（避免空闲时每 3 秒触发内核全量 LoRA 扫描）；
  日志管道加单行上限与进度去重；删除无人调用的 `parse_png_metadata` 命令。
- **可观测性与启动（第三轮）**：新增文件日志
  （`%LOCALAPPDATA%/lumina/logs/lumina.log`，8 MB 滚动保留 3 份），sd-server 的每一行
  输出与启动命令行都会落盘；关窗不再因等待 server 锁而卡住（改 `try_lock` + OS 兜底）；
  历史画廊打开时只读每张图的头部 256 KiB 解析元数据，千张图不再产生数 GB IO。
- **视频（第三轮）**：参数面板新增「视频时间维分块」开关与帧数/重叠，长视频解码
  显存不足时不再只能手改 localStorage。
- **跨平台与内核探测（第四/五轮）**：Windows junction / Unix symlink 目录不再被扫描器
  静默跳过（并按规范化路径去重防环）；CLI 探测不再在整段子进程执行期间持有全局锁
  （切模型时的 `preflight → start` 不再互相排队）；非 UTF-8 路径与 POSIX 里含反斜杠的
  合法文件名不再被 `dir_is_within` 恒判越界。
- **隐私与控件（第四/五轮）**：输出面板新增「写入生成参数元数据」开关（图片与视频都生效），
  分享原图前可以不再泄露提示词；VACE 家族补上「VACE 条件强度」滑杆。
- **工程护栏（第六轮）**：新增 TS↔Rust 命令面契约测试（23 条命令双向断言，改名即失败）；
  `vite.config.ts` / `vitest.config.ts` 纳入类型检查（`tsconfig.node.json`）；
  接入 `@vitest/coverage-v8`，实测基线 语句 65.8% / 行 67.3%。
- **陈旧枚举（第六轮）**：采样器/调度器里不在当前内核列表中的持久值会标注
  「当前内核不支持」并给出提示——此前界面显示 A、内核静默用默认，无从察觉。
- **架构（第七轮）**：`server.rs` 的日志管道抽成独立 `log_pipe.rs`（ANSI 清理、
  `server-log` 事件、单行上限、进度去重、落盘），进程管理文件缩到 1971 行。
- **架构（第八轮）**：`server.rs` 的启动参数拼装与校验抽成 `args.rs`（`build_args`、
  路径/显存/后端三类校验、组件目录与 FlashAttention 适配），`server.rs` 继续缩到
  1307 行，只剩进程管理与可执行文件解析。
- **工程（第九轮）**：接入 ESLint（缺陷类规则为 error，含 `react-hooks/rules-of-hooks`、
  未使用变量、`preserve-caught-error`），`npm run lint` 进 CI；顺带修掉三处真实问题
  （被误判为 Hook 的回调命名、丢失 `cause` 的重新抛出、`tsconfig` lib 过旧）。
- **性能（第十轮）**：家族数据表（2000 行）从 `families.ts` 拆到 `families.data.ts` 并
  单独成 chunk——入口 chunk 151.96 kB → 111.39 kB（-27%），改逻辑不再让整张表失效缓存。
- **无障碍（第十一轮）**：历史画廊的虚拟滚动列表可聚焦，支持 `PageUp/PageDown/Home/End`
  翻页，并用 `role="status"` 播报「共 N 项，当前显示第 X–Y 项」——此前键盘与读屏用户
  只能到达首屏已渲染的瓦片。
- **上手体验（第十二轮）**：启动检查单的「还缺 N 个必需配置」新增「去填写」按钮，
  点开即展开组件面板并把焦点送到第一个可填控件（此前只滚动到一片折叠面板）；
  内核侧 9 条英文错误（找不到/不可执行 sd-server、路径不存在、任务 ID 非法等）
  改为中文并补上下一步该怎么做。
- **通知与门禁（第十三轮）**：同文案的重复提示（轮询失败、批量保存失败）合并成
  一张卡片并显示 `×N`，不再几秒内刷满屏幕；新增覆盖率门禁（语句 60 / 分支 55 /
  函数 55 / 行 62），CI 上跑 `npm run test:coverage`。
- **家族识别（第十四轮）**：短家族名改为词首匹配——`animation-motion` 不再被识别成
  Anima、`taiwan-style` 不再被识别成 Wan；补上 FLUX.1 官方连字符文件名
  （`flux-1-dev` / `flux-1-schnell`），此前会落到 `custom` 用错默认值。
- **默认值调整（第十八轮）**：「生成完成自动保存到输出目录」改回**默认关**（按产品
  意图）：不打招呼就往磁盘写文件比丢结果更糟。README、控制台开关与提示文案、
  Rust `auto_save_results` 的 serde 默认值、相关测试一并更新。
- **控制台（第十九轮）**：「附加启动参数」输入框接入当前内核 `--help` 的选项名
  （datalist 补全），拼错参数不再只能等到启动失败才发现。
- **内存（第二十轮）**：结果区、任务输入、画廊缩略图/原图/视频五处独立内存预算
  收进一本账（`src/lib/memoryBudget.ts`），渲染进程上限从约 2.4 GiB 降到
  可预期的 1.6 GiB（结果 640 MB / 任务 128 / 缩略图 128 / 原图 384 / 视频 384），
  并有测试保证"调大任一层或漏记一层"会失败。
- **参数面板（第二十一轮）**：高级采样补上「Shifted Timestep」滑杆——该字段一直
  随请求体发送，但界面此前没有入口（Flow 类模型微调时间步的第二个旋钮）。
- **体验（第七轮）**：独立放大在同步执行期间显示已耗时秒数（该接口无进度事件），
  用户能判断是不是卡死。
- **引擎控件（第二十二轮）**：控制台「运行后端」补上 `--threads`（0 = 由内核按 CPU
  物理核数决定）、`--params-backend`（权重驻留后端，`disk`/`cpu`/`te=cpu,vae=cpu`）、
  `--rpc-servers`（多机拆卡的 `host:port` 列表）三个控件——此前只能手写进「附加启动
  参数」，而代码里早就处理了 `--params-backend` 与 auto-fit 的冲突却不给入口。三者是
  **本机硬件配置**，只存全局设置、不随模型快照漂移；`--params-backend` 的 `&` 设备列表
  与 `--rpc-servers` 的端口形状在 GO/NO-GO 阶段就拦下（上游对连不上的 RPC 端点只打日志，
  写错端口的表现是「多机显卡没出现」）。
- **缓存与跳层（第二十二轮）**：`cache_option` 从「只能手写 key=value 串」改为按当前
  `cache_mode` 渲染结构化子控件（固定键序、切模式裁剪，`threshold`/`warmup` 按实际写入
  的上游字段判断是否丢弃）；`scm_mask` 加硬校验且**非法值永不下发**——上游
  `parse_scm_mask` 的 `std::stoi` 没有 try/catch 且跑在工作线程，坏掩码会让 sd-server
  整个进程 terminate，这个场景等不到 400；SLG 补 `layers` / `layer_start` /
  `layer_end`，`layers` 未设置时**省略该键**以沿用服务端 `--skip-layers`（此前硬塞
  `[7,8,9]` 会把它顶掉），高噪段不再恒发 `{scale:0}`。
- **测试（第二十二轮）**：`Dashboard.test.tsx`（712 行 / 20 例）按 describe 拆成 kit +
  三个文件，该目录耗时 16.8s → 10.9s；补生命周期/订阅层测试——blob URL 的撤销时机
  （卸载、剪枝、替换）、快捷键（CapsLock/非美式布局、`isComposing`、`blockBackgroundShortcuts`
  与 `escapeActive` 分离）、App 阶段机（骨架/就绪/失联、控制台里切模型不弹假错误）。
- **工程（第二十二轮）**：`scripts/*.mjs` 并入类型门禁（`allowJs`+`checkJs` 随
  `npm run check:types` 跑，首轮暴露 20 条类型错误，其中 18 条是隐式 any）；接入
  Prettier 作为唯一格式来源
  （`npm run format:check` 进 CI，ESLint 继续只管缺陷）；修正 `.gitattributes` 里
  `*.{ts,tsx}` 花括号模式不生效导致的行尾漂移，索引里 8 个 CRLF 文件归一为 LF；
  `upstream-diff.mjs` 改用 `process.exitCode`，不再在 Windows + Node 24 上以
  `0xC0000409` 崩溃；`check-version.mjs` 补查 `package-lock.json`，成功文案的处数改为
  由检查清单推导。
- **依赖**：`package-lock.json` 重新生成并删掉手工补的 `@emnapi` 条目（`npm ci` 现在能
  干净安装），`npm audit` 归零；`@tauri-apps/{api,cli,plugin-notification}` 改为精确版本，
  使其与 Rust crate 的 major.minor 对齐（否则 `tauri build` 会直接失败）。

## 0.8.6 — 2026-10-17

- 同步上游 `f0aac52`：FLUX.3 Image Klein（含 Base）、Iris-3B、MOSS-Image；
  `--flash-attn` / `--conv-direct` 按后端自动选择，旧别名自动回退；
  UNet 条件/无条件分支合并前向；TAEQI2.1；独立放大支持 MoSR；非 ANSI 路径修复。

## 0.8.5 及更早

见 git 提交历史（`git log --oneline v0.8.5`）与 Releases 说明。
