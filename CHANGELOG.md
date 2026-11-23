# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号以 `package.json` 为唯一来源，历史条目按 git tag 回溯补齐到 0.8.6。

## [Unreleased]

## 0.12.0 — 2026-11-23

### 界面与体验重构

- **双主题重塑（去 AI 化设计语言）**：
  - **`墨曜 · 暗室`（`lumina`）**：重构为校色中性黑曜石暗房风格，移除旧版琥珀金渐变按钮、发光阴影、呼吸光晕球与毛玻璃糊感，改用 1px 发丝线、高对比纯白主按钮、哑光凹陷禁用态与克制的光学钴蓝交互强调；
  - **`东方号 VOSTOK`（`vostok`）**：保留苏俄构成主义 × 航天测控室核心美学并深度精致化——重绘丝网版画风 `VostokPoster`（`红楔入轨 / RED WEDGE · ORBIT-1`）、双形态几何徽标、斜切平行四边形主按钮、45° 菱形滑杆推子、作品四角 L 形裁切标尺与高对比在轨青蓝遥测边注；双主题全部视图达 WCAG AA（≥ 4.5:1）。
- **窗口与工作区架构升级**：
  - 标题栏新增像素对齐原生窗口控制键与右上角一键主题切换按钮；Toast 固定至右上安全区避免遮挡日志栏与提示词坞；
  - 控制台重排为左导轨（状态信标 + 三步启动检查单 + 底部启动坞）+ 右工作区（1→2→3 主流程 + 带摘要角标的折叠高级面板 + 空目录引导）；
  - 生成工作室改为画廊优先布局：顶栏整合模型胶囊、当前结果/历史画廊分段切换、图片/视频切换、队列与参数入口；结果卡改为悬停/聚焦显露的无边框幽灵操作条与静谧种子展签；提示词坞改为无光晕单层实体面板。
- **三层渐进披露与文案精简**：
  - 新增 `InfoTip` 悬浮/点击情报卡组件，统一收纳非自明参数的语法与避坑说明（`Slider`/`Toggle`/`Panel` 展开时不裁切浮层）；模型说明收敛为单行规格芯片 + 可展开「使用说明」抽屉；
  - 全面精简冗余提示与开发者术语（清零界面 PR 编号、内部实现与防御性免责声明），同步提炼 66 个模型家族的实用配重说明。
- **表单纵向节奏统一**：
  - 修复 Tailwind CSS v4 `space-y-*` 与 `form-row mb-0` 优先级冲突导致的 0px 紧贴问题，引入 `.form-stack` / `.form-grid` / `.form-grid-sm` / `.form-section` 统一全站「标签→控件 `6px`、行→行 `14px`」的垂直间距。

## 0.11.0 — 2026-11-23

### 同步上游 `0d71f96`（2026-11-23）

- **正确性（DGL 架构双代兼容，上游 #2396 / #2365）**：按 `/sdcpp/v1/capabilities` 的协议指纹（`isDglBackend`）动态识别前 DGL 内核（`<= 32d516c`）与 DGL 架构内核（`#2396+`），避免新版内核 HTTP 400 崩溃：
  - 新增 `stripNullish` / `resolveInitialParams` / `resolveResetParams`，安全过滤 `#2365/#2396` 序列化为 `null` 的 `std::optional` 默认值，修复全新启动与「重置为推荐值」时宽/高/步数/种子被覆写成 `null` 的问题；`vaeTilingProtocolFromCapabilities` 改为按属性存在性识别协议。
  - 连接 DGL 内核时，`buildRequestBody` 与参数面板自动省略/隐藏已迁入 DGL 的原生字段：`slg`（含 `{ scale: 0 }`）、`shifted_timestep`、`ip_adapter_strength`/`ip_adapter_image`、`image_preprocess`、`ref_image_args`、`increase_ref_index`、块级缓存 `Fn`/`Bn` 与非 `sample_steps` 的高噪段独立采样参数；非 `qwen-image-layered` 模型不再携带残留的 `qwen_image_layers`。连接旧内核时完整保持原有行为。
  - Wan2.2 A14B 高噪段面板在 DGL 内核下收敛为「高噪段步数（支持 `-1` 按 MoE Boundary 自动分段）」+「MoE Boundary」并说明共享主采样器/CFG。
  - 独立放大（`POST /sdcpp/v1/upscale`）对话框拦截 `1–31` 的非法 `tile_size`（#2396+ 从静默抬升 32 改为直接返回 HTTP 400）；进度标签补齐 `executing` / `dgl`。
- **正确性（三代元数据与 `generation_info` 解析，上游 #2396）**：
  - Rust 端 `png_info.rs` 新增 PNG `iTXt`（`dgl` / `parameters`）、WebP XMP `<sdcpp:dgl>` 与 JPEG COM 段（`0xFF 0xFE`）解析，并将 `.jpg`/`.jpeg` 纳入历史画廊元数据读取。
  - 前端 `generationInfoSeed` 兼容 `#2396+` UTF-8 DGL 源码字符串（结果卡/下载文件名继续回显随机种子任务的真实 seed），`sdcppMetadataToGenParams` 新增 `sdcpp.dgl/v1` 分支（`dglGenerationToGenParams`），恢复提示词、尺寸、种子、采样参数、高噪步数、分层数（`layers - 1`）、hires、VAE 分块、缓存草稿与 LoRA。
- **新增（提示词内联图片，上游 #2341）**：原生 `img_gen` / `vid_gen` 接入 `prompt_images`（`<image:ID>`）：图片输入面板新增内联图片上传、ID 重命名、一键插入 `<image:ID>` 与提交前校验（ID 合法性、未闭合标记、32 张上限、未绑定 ID 拦截），任务快照与字节预算同步纳管；SenseNova U1.5 按家族禁用。
- **工程化（CLI 预检双代适配，上游 #2396）**：`cli.rs` 登记 `--dgl-dir`（支持旧内核拦截与路径校验），并在确认 DGL 内核时对已移除的 32 个旧启动参数（`--ref-image-args`、`--motion-module`、`--ip-adapter`、`--ad-model`、`--slg-scale`、`--high-noise-*` 等）给出指向性清理错误；控制台兼容性面板与「参考图处理」提示同步更新。
- **正确性（视频帧对齐与家族完善，上游 #2396 / #2337 / #2340 / #2203）**：
  - `alignVideoFrames` 支持 `"ceil" | "floor"`，默认按 `#2396+` 向上对齐（Wan/Hunyuan/LingBot `4n+1`、LTX `8n+1`），连接前 DGL 内核时自动切换为向下对齐并同步界面提示。
  - MiniMax-H3 / HyperFlow H3 / P-H3-Image 全部 6 族补齐统一文本编码器说明（支持 Qwen3-VL 32B 或 P-H3 Qwen3-VL 4B）与可选 `--embeddings-connectors` 槽位。
  - MOSS-Image 补齐可选 `--llm_vision` 视觉投影槽位（`mmproj-BF16.gguf`），并更新 HQ 编辑 LoRA（`armV5-moss-edit-lora`）与 `<image:ID>` 内联提示图使用提示。
- **工程化与文档**：`scripts/upstream-diff.mjs` 补齐 `prompt_images` 键提取与 DGL 架构 / ADetailer 移除 / `/upscale` `tile_size` 语义漂移检查；修正 `README.md` 已迁移的上游文档链接（`docs/guides/performance.md`、`docs/guides/backend.md`）；完整分析与落点见 `docs/UPSTREAM-SYNC-2026-11-23.md`。

## 0.10.0 — 2026-11-11

### 同步上游 `32d516c`（2026-11-11）

- **正确性**：嵌入元数据 schema 换代兼容（上游 #2206）：`sdcpp.image.params/v1` →
  `sdcpp.generation/v1`（prompt 扁平化、seed 变十进制字符串、sampling → sample_params、
  cache 只存结构化参数、LoRA 记相对路径）。参数恢复按 schema 分流，新图旧图都能
  完整回填；`cache_dit`（元数据枚举）归一为请求体的 `cache-dit`，避免恢复后提交 400。
- **新增**：结果项 `generation_info` 的实际种子回显（上游 #2206）：随机种子任务的
  结果卡/下载文件名显示每张图的真实 seed，「应用此配置」优先带回实际种子。
- **新增**：结构化执行进度（上游 #2303）：任务行显示阶段文案（条件编码/采样/VAE 解码/
  输出编码…）与段内步数进度条，多任务不再借用全局日志进度；旧内核无 `progress` 键时
  回落日志解析，任务栏全局进度不变。
- **新增**：Ref2VA 参考视频/音频输入（上游 #2194）：参考视频按 **24fps 抽帧**（服务端
  JSON 通道固定帧率，短边 ≤1024、单个上限 481 帧），参考音频/视频音轨只收 **WAV**
  （RIFF 头校验），音轨按序配对视频且数量不得更多；参考媒体与首尾帧互斥在提交前拦截。
- **新增**：`control_type` 选择器（上游 #2284 / #2187）：SDXL ControlNet Union 必需的
  控制类型（8 个枚举，tile/repaint 标注 ProMax），仅新内核显示；其它 ControlNet 忽略。
- **新增**：MiniMax-H3-Image（#2324）、P-H3-Image（#2272）、HyperFlow H3 Flash 两支
  （#2299）家族，家族数 62 → 66。专用 sigmas 调度按上游数值数组下发（请求体不认 CLI
  预设名）；P-H3-Image 文本连接器走 `--embeddings-connectors`（官方包内置时可选）。
- **新增**：MiniMax-H3 latent hires 二段采样（上游 #2249）：与首尾帧互斥的提交前校验；
  H3 家族提示补 Sol-H3-VAE 时间分块（5 的倍数）与 `minimax_h3_attn_chunk_budget` 写法。
- **工程化**：队列治理参数预检（上游 #2316）：`--max-pending-jobs`（正整数）/
  `--completed-ttl-seconds`（非负整数秒）写入附加启动参数时校验取值、旧内核报不支持；
  完成任务默认 600s 后清理、过期查询 410 的轮询兼容早已实现。
- **工程化**：`upstream-diff.mjs` 补三个盲区：请求体键提取覆盖
  `parse_*_array_json_field`（ref_videos 等不再漏报）；生成期参数（`--control-type`）
  不再误报为启动参数；语义检查新增结构化 progress 与元数据 schema 换代两条。
- **裁定**：SeedVR2 / RelayVSR（#2300 / #2285）走 CLI-only 的 `vid_upscale`，服务端
  无通道，不接（README 已知限制）；recipe `size_multiple` / `video_constraints` /
  幂等加载仍不消费。分析与落地记录见 `docs/UPSTREAM-SYNC-2026-11-11.md`。

### 修复

- **正确性**：`control_type` 元数据回填把内核的「未设置」哨兵 `"none"` 当成有效值，
  导致每张没设控制类型的图恢复参数后都带上伪设置（界面枚举无此值、提交时又发给内核）；
  现按未设置丢弃，未知取值同样不采信。
- **正确性**：MiniMax-H3 Ref2VA 的必备输入口径与内核不符——上游 `has_references` 是
  「参考图 / 参考视频 / 参考音频**任一**」，此前写成「参考图必须给」，只用参考媒体的
  用户会被界面拦下。改为「任一即可」组校验，缺失时提示三项可选项。
- **正确性**：上述改动后 Ref2VA 的参考图输入行改用统一的 `familyAcceptsRefImages`
  判定（必需或任一即可），避免入口消失；「（必需）」角标仍只对真正全必需的家族显示。
- **正确性**：二次放大（hires）与首尾帧的互斥判定改用按 features 裁剪后的参数，
  与提交时的裁剪口径一致，避免家族禁用 hires 时仍按「开着」误报冲突。
- **工程化**：`ServerManager` 补 `#[derive(Default)]`、`save.rs` 的
  `manual_is_multiple_of` allow 前置 `unknown_lints`，修复本地旧 clippy 下
  `-D warnings` 的两处存量报错。

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
