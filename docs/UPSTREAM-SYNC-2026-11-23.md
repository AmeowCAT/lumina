# 上游同步分析：`32d516c` → `0d71f96`（2026-11-23）

对齐号：README 此前对齐 `32d516c`（2026-11-11，`feat: add MiniMax-H3-Image support (#2324)`）。
上游 `master` 现已推进至 `0d71f96`（2026-11-23，`fix: restore runtime LoRA tensor counts and unify automatic LoRA mode selection (#2400)`），
两者之间共 **29 个提交**。虽然提交总数不多，但其中 `#2365`（不透明 options / tensors / results API 重构）
与 `#2396`（**Diffusion Graph Language，DGL** 架构落地）是上游自 `sd-server` 独立以来**破坏面最大的一次架构换代**，
同时还有 `#2341`（视觉 LLM 提示词内联图片 `prompt_images`）、`#2337/#2340`（H3 家族统一文本编码器）与
`#2203`（MOSS-Image 编辑 LoRA）。

本文沿用 `UPSTREAM-SYNC-2026-11-11.md` 的结构：先给结论与逐项影响评估，再记录落点、战略取舍与验收结果。

## 0. 结论

**必须同步，核心是「前 DGL / 后 DGL 两代内核无感兼容」与「第三代元数据（DGL 源码）解析」，同时接入 `prompt_images` 与 H3/MOSS 家族增强。**

| 结论                                        | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 有 **4 处会直接报错或静默损坏**的破坏性变更 | ① `#2365/#2396` `/capabilities` 的 `defaults_by_mode` 对 `std::optional<T>` 输出 JSON `null`，直接 `deepMerge` 会冲毁宽高/步数/CFG 默认值；② `#2396` 发送 `slg`/`shifted_timestep`/`image_preprocess`/`ref_image_args`/`increase_ref_index`/`ip_adapter_strength`/非 `sample_steps` 高噪字段/非分层模型 `qwen_image_layers` 会直接回 **HTTP 400**（`dgl_only_parameter`）；③ `#2396` `generation_info` 从 JSON 对象改为 UTF-8 **DGL 源码字符串**，且图片元数据迁至 PNG `iTXt`(`dgl`)/WebP XMP `<sdcpp:dgl>`/JPEG COM；④ `#2396` `POST /sdcpp/v1/upscale` 对 `1..31` 的 `tile_size` 改为 HTTP 400 |
| 有 **32 个启动参数被移除**                  | `#2396` 将 AnimateDiff、IP-Adapter、ADetailer、PhotoMaker、PuLID、SLG、Shifted Timestep、高噪采样覆写、图像预处理与 `--ref-image-args` 迁入 DGL 脚本并删除 32 个 CLI 参数，同时新增 `--dgl-dir`；预检必须对旧配置给出明确迁移提示，不得静默改写用户设置                                                                                                                                                                                                                                                                                                                                          |
| 有 **1 个视频帧对齐方向变更**               | `#2396`（`src/model/vae/geometry.hpp::aligned_frames`）把 Wan / LingBot / Hunyuan（`4n+1`）与 LTX（`8n+1`）从向下对齐（`floor`）统一改为**向上对齐（`ceil`）**；需按是否 DGL 内核双轨提示                                                                                                                                                                                                                                                                                                                                                                                                        |
| 有 **1 项核心新协议能力**                   | `#2341` 原生 `img_gen` / `vid_gen` 新增 `prompt_images` + `<image:ID>` 内联提示图片（上限 32 张、`\<image:...>` 转义，Qwen2.5-VL / Qwen3-VL / Qwen3.5；SenseNova U1.5 显式拒绝）                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 有 **2 项已有家族能力扩展**                 | `#2337/#2340` 统一 6 个 H3 家族的文本编码器（Qwen3-VL 32B 或 P-H3 4B + 可选 `--embeddings-connectors`）；`#2203` MOSS-Image 新增编辑 LoRA 支持（可选 `--llm_vision` + `armV5-moss-edit-lora.safetensors`）                                                                                                                                                                                                                                                                                                                                                                                       |
| 无新增模型家族                              | 家族总数保持 **66**；无新增采样器或调度器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 战略项（暂不接入）                          | 图形化 DGL 脚本编辑器与 `/sdcpp/v1/dgl/*` 执行器本轮暂不内置（理由与演进路径见 §5），本轮先完成 `--dgl-dir` 预检、DGL 元数据/种子解析与 `executing/dgl` 进度标签                                                                                                                                                                                                                                                                                                                                                                                                                                 |

机器检查的现状（本地克隆离线模式，脚本更新后执行）：

```text
$ node scripts/upstream-diff.mjs --upstream <sdcpp> --since 32d516c --ref HEAD
⚠ 上游新增的启动参数（1）
  --dgl-dir
⚠ 上游删除/改名的启动参数（32）
  --ip-adapter, --motion-module, --photo-maker, --pulid-weights,
  --ad-model, --ad-negative-prompt, --ad-prompt, --extra-ad-args,
  --high-noise-cfg-scale, --high-noise-eta, --high-noise-guidance,
  --high-noise-img-cfg-scale, --high-noise-sampling-method,
  --high-noise-skip-layer-end, --high-noise-skip-layer-start,
  --high-noise-skip-layers, --high-noise-slg-scale,
  --image-preprocess, --increase-ref-index, --ip-adapter-image,
  --ip-adapter-strength, --pm-id-embed-path, --pm-id-images-dir,
  --pm-style-strength, --pulid-id-embedding, --pulid-id-weight,
  --ref-image-args, --skip-layer-end, --skip-layer-start,
  --skip-layers, --slg-scale, --timestep-shift
⚠ 上游新增的请求体字段（1）
  prompt_images
⚠ 上游删除/改名的请求体字段（2）
  increase_ref_index, ref_image_args
⚠ 参数/字段之外的语义变化（4）
  ADetailer 迁至 DGL / DGL 架构换代 / prompt_images 协议 / /upscale tile_size 1..31 返回 400

$ node scripts/upstream-diff.mjs --coverage --upstream <sdcpp> --ref HEAD --strict
✓ 未覆盖字段都已登记（31 个字段全部有落点或已说明）。
```

## 1. 上游 29 个提交分组（`32d516c..0d71f96`）

| 组                       | 提交                                                                                                                                             | 影响面                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DGL 架构 & API 重构**  | `6cd0ef1` #2396、`532d2c1` #2365                                                                                                                 | 不透明 options/tensors/results、`/capabilities` `null` 默认值、DGL 引擎、32 个 CLI 删除、`/sdcpp/v1/dgl/*`、三代元数据、帧向上对齐、`/upscale` `tile_size` 严格校验 |
| **内联提示图片**         | `5d78740` #2341                                                                                                                                  | `prompt_images` 映射 + `<image:ID>` 占位符（上限 32）、Qwen2.5-VL/Qwen3-VL/Qwen3.5 支持、SenseNova U1.5 明确拒绝                                                    |
| **MOSS-Image 编辑 LoRA** | `2c678bc` #2203                                                                                                                                  | MOSS-Image 可配 `--llm_vision`（Qwen3.5-9B mmproj）+ `armV5-moss-edit-lora.safetensors` + `ref_images`                                                              |
| **H3 家族统一编码器**    | `b9d7176` #2340、`8b1e9df` #2337、`394d210` #2350                                                                                                | 全部 6 个 H3 家族互通 Qwen3-VL 32B / P-H3 4B（配 `--embeddings-connectors`）；MiniMax-H3 音频裁剪至视频时长                                                         |
| **LoRA / 量化修复**      | `0d71f96` #2400、`56d95bf` #2388                                                                                                                 | 恢复运行时 LoRA 张量计数并统一自动模式选择；`asym_w4a8_int8` `group_size` 默认对齐 ComfyUI 的 16（内核内部）                                                        |
| **ggml 1.0 / 构建修复**  | `5dcfa79` #2354、`f0816c9` #2363、`bf31b9c`                                                                                                      | 同步 ggml 1.0.0、修复 shared libggml 链接与 MUSA 编译（对 GUI 协议无影响）                                                                                          |
| **后端性能优化**         | `422b10d` #2369、`6874e49` #2374、`b521db4` #2353、`4b51674` #2351、`3bad892` #2346、`a59298e` #2347、`766ce0e` #2335                            | H3 VAE / Hunyuan 卷积 / HIP FlashAttn+INT8 / MOSS CUDA / QKV 视图优化（对 GUI 协议无影响）                                                                          |
| **文档重组与指南**       | `ca4e755`、`6201bcc`、`9e7eed7` #2318、`a852f49` #2356、`9860a92` #2372、`01c463a` #2359、`f7120ce` #2352、`85a0b90`、`0f8a467`、`ce94719` #2110 | 文档迁至 `docs/guides/*` 与 `docs/models/*`，同步更新本地引用路径                                                                                                   |

## 2. 必须处理（P0）

### 2.1 DGL 协议兼容与 `/capabilities` `null` 默认值防护（`#2365` / `#2396`）

**证据**：

- `#2365` 将 `SDGenerationParams` / `SDSampleParams` 的多数成员改为 `std::optional<T>`；`#2396` 的 `routes_sdcpp.cpp` 序列化 `defaults_by_mode` 时，启动期未显式指定的字段直接输出 JSON `null`（例如 `width: null`、`sample_steps: null`、`vae_tiling_params.tile_size_w: null`）。
- `#2396` 在 `routes_sdcpp.cpp` 增加 `dgl_only_parameter` 拦截：向原生 `/sdcpp/v1/images/generations` 或 `/sdcpp/v1/videos/generations` 发送以下任一字段会直接返回 **HTTP 400**：
  - `sample_params.guidance.slg`（含 `scale: 0`！）
  - `sample_params.shifted_timestep`
  - `ip_adapter_strength`（含默认值 `1.0`！）
  - `image_preprocess`
  - `ref_image_args` / `increase_ref_index` / `auto_resize_ref_image`
  - `high_noise_sample_params` 中除 `sample_steps` 以外的任意字段（`sample_method` / `scheduler` / `guidance` / `eta` / `flow_shift` / `extra_sample_args` / `slg`）
  - 非 `qwen-image-layered` 模型的 `qwen_image_layers`（`generation_image.cpp:188` 返回 `SD_STATUS_UNSUPPORTED`）
- 块级缓存（DBCache / TaylorSeer / Cache-DiT）在 `generation_program.cpp:103` 中忽略 `Fn` / `Bn`（`fn_compute_blocks` / `bn_compute_blocks`）。
- `vaeTilingProtocolFromCapabilities` 此前靠 `typeof tile_size_w === "number"` 判像素协议，面对 `#2396+` 的 `tile_size_w: null` 会误判为旧版 latent 协议。

**落点**（双代内核动态探测，不静默篡改持久化配置）：

1. `src/lib/utils.ts`：
   - 新增 `stripNullish`、`neutralModeDefaults`、`resolveInitialParams`、`resolveResetParams`：所有合并层级先剔除 `null`/`undefined`，确保服务端非空默认值仍生效、而 `null` 不冲毁家族推荐或中性兜底。
   - 修复 `vaeTilingProtocolFromCapabilities`：改为按 `"tile_size_w" in tiling` 等键存在性判定像素协议。
   - 新增确定性探测函数 `isDglBackend(caps)` 及细粒度能力函数 `supportsSlg`、`supportsShiftedTimestep`、`supportsImagePreprocess`、`supportsRefImageOverrides`、`supportsIpAdapter`、`supportsFullHighNoiseSampling`（优先检查前 DGL 键，再结合 `control_type`、`features_by_mode.vid_gen.high_noise_sample_params === false` 与 `generation_features`）。
   - `cacheOptionFields` / `buildCacheOption` / `resolveCacheOption` 支持 `{ dglBackend }`：DGL 内核省略 `Fn` / `Bn`。
   - `buildRequestBody` 按上述能力动态裁剪请求体：在 DGL 内核上不发任何 `dgl_only_parameter` 字段、`high_noise_sample_params` 仅保留 `{ sample_steps }`、`qwen_image_layers` 仅在 `qwen-image-layered` 家族下发送；在旧内核（`<= 32d516c`）上 100% 保持原行为。
2. `src/components/generation/panels/HighNoisePanel.tsx` / `AdvancedSamplingPanel.tsx` / `ImageInputsPanel.tsx` / `GenerationParamsSheet.tsx` / `GenerationUI.tsx`：
   - 在 DGL 内核上自动隐藏 SLG、Shifted Timestep、`ImagePreprocessPanel`、H3 `ref_image_size`、块级缓存 `Fn`/`Bn` 与非 `sample_steps` 高噪段控件，并给出简明说明（不加 `role="note"` 以免污染家族使用提示语义）。

### 2.2 第三代元数据 & `generation_info` 变更（PNG `iTXt` / WebP `<sdcpp:dgl>` / JPEG COM）

**证据**：

- `#2396` 在 `src/api/generation_metadata.cpp` / `image_metadata.cpp` 中彻底替换元数据载体：
  - HTTP 响应的 `images[i].generation_info` / `result.generation_info` / `/upscale` `generation_info` 从 `sdcpp.generation/v1` JSON 对象变为 **UTF-8 DGL 源码字符串**（顶层含 `var { width = ... height = ... seed = ... }`）。
  - PNG 改为写 `iTXt` 块（keyword `dgl`，压缩或未压缩）；WebP XMP 改为 `<sdcpp:dgl>...</sdcpp:dgl>`；JPEG 写入 COM 段（`0xFF 0xFE`，`dgl` 或 `parameters`）。

**落点**（三代兼容：`sdcpp.dgl/v1` + `sdcpp.generation/v1` + `sdcpp.image.params/v1`）：

1. `src-tauri/src/png_info.rs`：
   - PNG 新增 `iTXt` 解析（支持无压缩及 zlib 压缩，优先识别 `dgl`，回退 `parameters`）；
   - WebP XMP 新增 `<sdcpp:dgl>` 提取；
   - 新增 JPEG COM（`0xFF 0xFE`）解析，并在 `list_output_files` 中放行 `.jpg`/`.jpeg` 历史输出文件；
   - 提取到 DGL 源码时以 `{ "schema": "sdcpp.dgl/v1", "dgl": "<source>" }` 封装返回，与现有 IPC 契约完全兼容。
2. `src/types.ts` & `src/components/generation/ResultsGrid.tsx`：
   - `generation_info` 放宽为 `Record<string, unknown> | string`。
3. `src/lib/utils.ts`：
   - `generationInfoSeed` 同时支持 JSON 对象、`sdcpp.dgl/v1` 对象与原始 DGL 字符串；
   - 新增 `parseDglVarBlock`、`dglGenerationToGenParams`，并在 `sdcppMetadataToGenParams` 中按三代 schema 分流，完整恢复 prompt（优先 `source_prompt`）、尺寸、seed、采样器/调度器/步数/CFG/Eta/Flow Shift/Beta/LMS、双专家 `high_noise_steps` 拆分、`qwen_image_layers = layers - 1`、hires、VAE tiling、cache、control_type、vace_strength 与 LoRA 路径。

### 2.3 CLI 预检更新（`--dgl-dir` 与 32 个已移除参数）

**证据**：`#2396` 在 `sd-server --help` 中新增 `--dgl-dir <string>`，删除 32 个已迁至 DGL 脚本的启动参数。其中 Lumina 控制台曾直接生成或用户可能保存在快照中的高频参数包括 `--ref-image-args`、`--motion-module`、`--ip-adapter`、`--ad-model` 等。

**落点**：

1. `src-tauri/src/cli.rs`：
   - `parse_help` 将 `--dgl-dir` 登记为取值选项（同时作为确认 DGL 内核的可靠标识）；
   - `validate_args` 校验 `--dgl-dir`（旧内核报错、空路径报错），并在确认为 DGL 内核（声明 `--dgl-dir` 且不支持某参数）时，对全部 32 个已移除参数给出指向性的迁移引导（而非放行后让 `sd-server` 以 `unknown argument` 闪退），绝不静默删改用户保存的快照。
2. `src/components/dashboard/CliCompatibility.tsx` & `Dashboard.tsx`：
   - 探测到 `--dgl-dir` 时在兼容性卡片中标注「DGL 架构内核（#2396+）」，并在控制台「参考图处理」处补充 DGL 内核保持「自动检测」的说明。

### 2.4 `/upscale` `tile_size` 1–31 改为 HTTP 400（`#2396`）

**证据**：`examples/server/routes_sdcpp.cpp` 对 `POST /sdcpp/v1/upscale` 的 `tile_size` 不再把 `1..31` 静默钳制到 `32`，而是直接返回 HTTP 400（`0` 仍表示使用内核默认，`>= 32` 合法）。

**落点**：`src/components/generation/UpscaleDialog.tsx` 在 `tileSize > 0 && tileSize < 32` 时内联给出 `role="alert"` 提示并禁用「开始放大」按钮。

## 3. 应处理（P1）

### 3.1 视觉 LLM 提示词内联图片 `prompt_images`（`#2341`）

**协议**（`src/api/generation_prompt.cpp` + `examples/common/common.cpp`）：

- `img_gen` 与 `vid_gen` 请求体新增 `prompt_images: Record<string, string>`（ID → base64/dataURL）；提示词中用 `<image:ID>` 按位置插入图像视觉 token，奇数个反斜杠（如 `\<image:foo>`）表示字面文本。
- 单次请求最多 32 个唯一图片 ID；ID 不能为空或含 `>`；未闭合或未绑定的 `<image:ID>` 会被内核拒绝。
- 支持 Qwen2.5-VL / Qwen3-VL / Qwen3.5 文本编码器家族；**SenseNova U1.5 显式拒绝**（`generation_program.cpp:335`）。

**落点**：

- `src/types.ts` / `src/store.ts` / `src/lib/launchConfig.ts`：新增 `Features.prompt_images`、`GenImages.promptImages`、store 状态、家族禁用过滤与 `jobImagesBytes` 内存预算计入；`sensenova-u1` 的 `disabledFeatures` 加入 `"prompt_images"`。
- `src/lib/utils.ts`：实现 `MAX_PROMPT_IMAGES = 32`、`extractPromptImageRefs`、`validatePromptImages`，并在 `buildRequestBody`（`img_gen`/`vid_gen`）下发 `prompt_images`。
- `src/components/generation/panels/ImageInputsPanel.tsx` / `GenerationParamsSheet.tsx` / `GenerationUI.tsx`：新增「提示内联图片（`<image:ID>`）」上传、改名、一键插入正向提示词与删除交互，任务快照/「应用此配置」完整往返。

### 3.2 视频帧对齐方向更新：`floor` → `ceil`（`#2396`）

**证据**：`#2396` 将 `video_frames_to_latent_frames` 统一重构为 `src/model/vae/geometry.hpp::aligned_frames`：Wan / LingBot / Hunyuan（`4n+1`）与 LTX（`8n+1`）均改为**向上取整**（例如 Wan `34 → 37`、`32 → 33`，LTX `40 → 41`），与 MiniMax-H3（`17k+5` 向上）一致；旧内核（`<= 32d516c`）仍向下取整。

**落点**：`src/config/families.ts::alignVideoFrames(family, frames, rounding = "ceil")` 默认按新上游向上对齐、兼容传入 `"floor"`；`SizeSeedPanel.tsx` 与 `GenerationParamsSheet.tsx` 按 `dglBackend ? "ceil" : "floor"` 动态切换对齐预览文案。

### 3.3 H3 家族统一文本编码器（`#2337` / `#2340`）

**证据**：全部 6 个 H3 家族（`minimax-h3-fl2va`、`minimax-h3-ref2va`、`minimax-h3-image`、`p-h3-image`、`hyperflow-h3-flash`、`hyperflow-h3-flash-ref2va`）现均支持在 Qwen3-VL 32B 与 P-H3-Image Qwen3-VL 4B（需配 `--embeddings-connectors`）之间自由选择。

**落点**：`src/config/families.data.ts` 为全部 6 个 H3 家族开放可选 `embeddings-connectors` 槽位，并统一 TE 说明文案。

### 3.4 MOSS-Image 编辑 LoRA（`#2203`）

**证据**：MOSS-Image 支持 `armV5-moss-edit-lora.safetensors`（配 Qwen3.5-9B `--llm_vision` mmproj + `ref_images`）。

**落点**：`src/config/families.data.ts` 为 `moss-image` 增加可选 `llm_vision` 组件槽并更新提示；`src-tauri/src/family.rs` 已将 `*mmproj*` 归入 `llm_vision`、`*lora*` 归入 `lora`，补充专项单测锁定 `Qwen3.5-9B-mmproj-BF16.gguf` 与 `armV5-moss-edit-lora.safetensors`。

### 3.5 进度阶段补全与文档链接更新

- `src/lib/utils.ts` 进度文案表补入 `executing: "执行中"` 与 `dgl: "DGL 脚本"`（`#2396`）。
- `src/config/families.data.ts`、`docs/UPSTREAM-SYNC.md`、`README.md`、`CHANGELOG.md` 同步更新上游新文档路径（`docs/guides/*`、`docs/models/*`）与对齐说明。

## 4. 只需登记（P2 / 内核内部）

| 项                                                       | 现状与裁定                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `#2400` 运行时 LoRA 张量计数与自动模式统一               | 内核内部行为修复，无需改前端 LoRA 协议                                  |
| `#2350` MiniMax-H3 音频裁剪至视频时长                    | 内核后处理修复，前端音频/视频播放无协议变化                             |
| `#2354` / `#2363` / `bf31b9c` ggml 1.0.0 & 编译修复      | 构建依赖更新，不影响 HTTP/CLI 协议                                      |
| `#2388` `asym_w4a8_int8` `group_size=16`                 | 量化加载内部默认对齐 ComfyUI，对 GUI 透明                               |
| `#2369/#2374/#2353/#2351/#2346/#2347/#2335` 后端性能优化 | CUDA/HIP/VAE 算子优化，对 GUI 透明                                      |
| `#2318` 浏览器生成完成通知（上游 WebUI）                 | Lumina 桌面端已有系统通知与任务栏进度（`useSystemIntegration`），不适用 |

## 5. 战略项：DGL 脚本编辑器与 `/sdcpp/v1/dgl/*` 执行器（本轮暂不内置）

`#2396` 在 `sd-server` 上开放了 `GET /sdcpp/v1/dgl/scripts`、`POST /sdcpp/v1/dgl/execute` 等 DGL 端点，并将 AnimateDiff / IP-Adapter / ADetailer / PhotoMaker / PuLID / SLG 等高阶组合能力下沉为可编程 DGL 脚本。

**本轮暂不直接内置图形化 DGL 工作流编辑器的原因**：

1. **产品边界与稳定性**：Lumina 的核心定位是面向常见模型家族的零配置桌面暗房，而 DGL 语言与内置标准库刚落地（首个提交 `#2396`），API 形态与脚本生态仍在快速收敛期。
2. **双代过渡零回退**：通过本轮的自动能力探测与 CLI 预检，用户在 DGL 内核下仍可无缝使用全部原生生成能力（含 `prompt_images`、Ref2VA、Hires、VAE Tiling、Cache、LoRA 与历史图三代元数据恢复），在旧内核（`<= 32d516c`）下则继续完整保留 AnimateDiff / IP-Adapter / SLG / 图像预处理。
3. **后续演进路径**：待上游 DGL 脚本目录与 `/sdcpp/v1/dgl/*` 参数 schema 稳定后，可在独立面板提供「从 `--dgl-dir` 列出脚本 → 自动渲染 `var { ... }` 表单 → 调用 `/sdcpp/v1/dgl/execute`」的轻量化执行模式，无需从零造节点图编辑器。

## 6. 工具链：`scripts/upstream-diff.mjs` 盲区修补

1. **键提取器补齐 `prompt_images`**：上游 `parse_prompt_images_json` 不走 `load_if_exists`，在 `extractJsonKeys` 中补充匹配，避免漏报。
2. **`KNOWN_UNSUPPORTED` 更新**：将 ADetailer 相关 4 个原生键的说明更新为「前 DGL 仅启动参数、#2396+ 已迁至 DGL 脚本」。
3. **新增 4 条语义漂移检查**：自动捕捉 ADetailer 原生移除、DGL 架构（`--dgl-dir` / `dgl_only_parameter` / `sdcpp:dgl`）、`prompt_images` 协议与 `/upscale` `tile_size < 32` 校验变化。

## 7. 验收结果

| 检查项                        | 命令                                                                               | 结果                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 版本一致性                    | `npm run check:version`                                                            | 通过（5 处版本 `0.10.0` 一致，Tauri npm/crate 主次版本匹配）                                                                   |
| TypeScript 类型检查           | `npm run check:types`                                                              | 通过（0 错误）                                                                                                                 |
| 前端单元测试（Vitest）        | `NODE_OPTIONS=--no-experimental-webstorage npm test`                               | 通过（**44 / 44** 测试文件，**582 / 582** 测试用例）                                                                           |
| ESLint 检查                   | `npm run lint`                                                                     | 通过（0 错误；改动文件无新增警告）                                                                                             |
| Prettier 格式检查（改动文件） | `npx prettier --check <changed files>`                                             | 通过（全部改动文件符合格式规范）                                                                                               |
| 前端生产构建                  | `npm run build`                                                                    | 通过（2499 模块，3.00s）                                                                                                       |
| 上游漂移检查                  | `node scripts/upstream-diff.mjs --upstream <sdcpp> --ref HEAD --strict`            | 通过（对齐 `0d71f96`，0 漂移，exit 0）                                                                                         |
| 请求体字段覆盖率              | `node scripts/upstream-diff.mjs --coverage --upstream <sdcpp> --ref HEAD --strict` | 通过（31 / 31 字段全部有落点或已登记，exit 0）                                                                                 |
| Rust 格式检查                 | `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                           | 通过（0 diff）                                                                                                                 |
| Rust 全目标静态检查           | `cargo +stable-x86_64-pc-windows-gnu check --all-targets --offline`                | 通过（0 错误，无业务代码警告）                                                                                                 |
| Rust 单元测试                 | `lumina_lib` 单元测试套件（`--lib`，ComCtl32 v6 清单）                             | 通过（**118 / 118** 测试用例，含 DGL CLI 预检、PNG `iTXt` / WebP `<sdcpp:dgl>` / JPEG COM 元数据与 MOSS-Image 组件分类新用例） |

> 注：本机未安装 MSVC Build Tools（缺 `link.exe`），因此 Rust 检查与单测使用本机已安装的 `stable-x86_64-pc-windows-gnu` 工具链完成；该工具链未装 `clippy` 组件，后续在具备 MSVC/clippy 的 CI 或开发机上建议补跑 `cargo clippy --all-targets -- -D warnings`。

手工验收清单（按 `0d71f96` 构建的 `sd-server`）：

| 场景                                   | 期望                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制台点「检测内核兼容性」             | 识别 `--dgl-dir`，展示「DGL 架构内核（#2396+）」提示；若附加参数含已移除的 32 个旧参数之一，预检明确报错并指引清理                                                                             |
| DGL 内核下进入生成页                   | 宽高/步数/CFG 保持有效推荐值（不被 `/capabilities` 的 `null` 覆盖）；隐藏 SLG、Shifted Timestep、图像预处理、块级缓存 `Fn`/`Bn` 与非 `sample_steps` 高噪控件；视频帧数提示按向上对齐（`ceil`） |
| 携带历史持久化配置提交生成             | 不发送任何 `dgl_only_parameter` 字段（不会触发 HTTP 400）；非 `qwen-image-layered` 不发 `qwen_image_layers`                                                                                    |
| Qwen-VL / Qwen3.5 家族使用提示内联图片 | 上传并命名 `<image:ID>` 后可一键插入提示词；未绑定或超 32 张时提交前拦截；SenseNova U1.5 自动禁用并过滤                                                                                        |
| 生成完成 & 历史画廊恢复参数            | 卡片正常从 DGL 源码 `generation_info` 回显实际种子；历史画廊可读取 PNG `iTXt` / WebP `<sdcpp:dgl>` / JPEG COM 元数据并完整还原参数                                                             |
| 独立放大对话框                         | 输入 `1..31` 的分块尺寸时内联告警并禁用提交；输入 `0` 或 `≥ 32` 可正常提交                                                                                                                     |
