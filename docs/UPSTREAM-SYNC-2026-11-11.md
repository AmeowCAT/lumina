# 上游同步分析：`95ff762` → `32d516c`（2026-11-11）

对齐号：README 当前写的是 `95ff762`（2026-10-23）。上游 `master` 现在是
`32d516c`（2026-11-11，`feat: add MiniMax-H3-Image support (#2324)`），
两者之间有 **88 个提交**，其中 **17 个改动了 `examples/server/**` 或
`examples/common/**`**，新增 4 个模型家族/变体、1 套结构化进度协议、
1 套新的生成元数据 schema，以及视频参考输入的服务端通道。

本文沿用 `UPSTREAM-SYNC-2026-10-24.md` 的结构：先判断与落点，再实施。

## 0. 结论

**需要同步，重点是「元数据 schema 换代」与「进度/结果协议升级」，不是只更新对齐号。**

| 结论                            | 依据                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 有 1 处**会静默失效**的协议变更 | 嵌入元数据从 `sdcpp.image.params/v1` 换成 `sdcpp.generation/v1`（#2206）：键位全变（prompt 扁平化、seed 变字符串、sampling→sample_params），旧映射器读新图会恢复出空参数 |
| 有 1 套**新的进度协议**         | 任务 JSON 新增 `progress` 对象（#2303）：阶段/段内步数/耗时独立于预览，Lumina 现在靠解析日志行 `step X/Y`，新协议更准且覆盖非采样阶段                                    |
| 有 1 套**新的结果协议**         | 结果项携带 `generation_info`（#2206）：每张图的**实际 seed** 与完整参数快照，随机种子任务终于能回显真实种子                                                              |
| 新增 3 个家族 + 1 个变体        | MiniMax-H3-Image（#2324）、P-H3-Image（#2272）、HyperFlow H3 Flash（#2299，FL2VA/Ref2VA 两支）；家族数 62 → 66                                                           |
| 有 1 个**等待已久的服务端通道** | `ref_videos` / `ref_audios` / `ref_video_audios` 进入 `/sdcpp/v1` vid_gen（#2194）——Ref2VA 家族注释里「待上游开放后再升级」的条件已满足                                  |
| 有 1 个新请求字段 + 启动参数    | `control_type`（#2284 SDXL ControlNet Union / #2187 Z-Image ControlNet）；`--max-pending-jobs` / `--completed-ttl-seconds`（#2316）                                      |
| 有 1 处**功能解锁**             | MiniMax-H3 视频支持 latent hires 二段采样（#2249），但与首尾帧条件互斥                                                                                                   |
| 有 2 个**不接**的新模型         | SeedVR2（#2300）/ RelayVSR（#2285）走 `-M vid_upscale`，**sd-server 不支持该模式**（supported_modes 仍只有 img_gen/vid_gen）                                             |
| 战略项                          | recipe 体系继续演进（size_multiple / video_constraints / 幂等加载，#2217/#2221）——Lumina 仍不接，理由见 §5                                                               |

机器检查的现状（已跑，本地克隆离线模式）：

```text
$ node scripts/upstream-diff.mjs --upstream <clone> --since 95ff762 --ref origin/master
⚠ 上游新增的启动参数（3）
  --control-type            ← 误报：生成期参数，sd-server 启动不认（见 §6）
  --completed-ttl-seconds
  --max-pending-jobs
⚠ 上游新增的请求体字段（1）
  control_type

$ node scripts/upstream-diff.mjs --coverage --upstream <clone> --ref origin/master
⚠ 上游接受、本仓库源码里完全没提到的请求体字段（1）
  control_type
```

**机器没报但必须处理的**：`ref_videos` / `ref_audios` / `ref_video_audios`
（走 `parse_*_json_field` 而非 `load_if_exists`，脚本的键提取器看不到，§6）、
元数据 schema 换代、progress/generation_info 新协议。这正是上一轮 §6 预言的
盲区类型，本轮补上对应检查。

## 1. 上游变化分组

| 组                     | 提交                                                               | 影响面                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 生成元数据 / 结果协议  | `a85db96` #2206、`7bcd4ce` #2283、`50a64f0` #2202                  | `sdcpp.generation/v1` schema、结果项 `generation_info`、实际 seed、LoRA 相对路径、postprocess 记录                       |
| 结构化进度             | `fc350be` #2303                                                    | 任务 JSON `progress`（stage/detail/pass/completed/total/unit/elapsed），独立于预览                                       |
| 视频参考输入           | `0f76bf5` #2194                                                    | `ref_videos`（帧数组的数组）/ `ref_audios` / `ref_video_audios`（base64 WAV）进入 vid_gen；capabilities 新增三个 feature |
| ControlNet Union       | `fdfc913` #2284、`b29cad5` #2187                                   | `control_type` 请求字段 + `--control-type`（生成期）；SDXL Union 必需，其它 ControlNet 忽略                              |
| 新家族                 | `32d516c` #2324、`3e92bf9` #2272、`80c4707` #2299                  | MiniMax-H3-Image、P-H3-Image、HyperFlow H3 Flash；新 sigmas 预设 5 个                                                    |
| 视频超分（CLI-only）   | `cd5594e` #2300、`9234ad8` #2285                                   | SeedVR2 / RelayVSR，`-M vid_upscale`；服务端无此模式                                                                     |
| H3 视频增强            | `d135894` #2249、`0bb1328` #2317、`de00baf` #2292                  | latent hires 二段采样、Sol-H3-VAE 蒸馏解码器、`minimax_h3_attn_chunk_budget`（--model-args）                             |
| 队列治理               | `a3f46b6` #2316                                                    | `--max-pending-jobs`（默认 64）/ `--completed-ttl-seconds`（默认 600）；过期任务 GET/cancel 回 **410**                   |
| recipe 演进            | `e41fbcf` #2217、`209b28c` #2221、`a5e48c6`                        | `size_multiple` / `video_constraints` / recipe 内 `models` 默认 / 幂等加载 `already_loaded`                              |
| 家族识别（内核内部）   | `8cbe905` #2237、`e7b7ec6` #2247                                   | Chroma 独立 VERSION_CHROMA；SDXL 独立 UNet 按 add_embedding 识别——Lumina 按文件名识别，不受影响                          |
| 采样修复               | `9bfc4d1` #2227、`b43af40` #2293、`0886f11` #2207                  | hires 步数按请求执行、Flux 调度按 patch 数、无消费者的参考图跳过 VAE 编码                                                |
| 设备/显存              | `133087d` #2259、`2032526` #2228、`46da352` #2309、`250ea6e` #2262 | auto-fit 优先独显、集显纳入内存规划、layer-split 按设备容量比例——启动参数语义不变                                        |
| 性能/后端              | #2278/#2280/#2276/#2235/#2251 等约 30 个                           | INT4/INT8 CUTLASS、Vulkan 协作矩阵、ggml 扩展重构——对界面无协议影响                                                      |
| 上游 WebUI / CI / 文档 | #2312、#2230、#2277 等                                             | 上游自带 WebUI 的流式 prompt 增强等，与 Lumina 无关                                                                      |

## 2. 必须处理（P0）

### 2.1 嵌入元数据 schema 换代：`sdcpp.image.params/v1` → `sdcpp.generation/v1`

**证据**

- `examples/common/common.cpp`：`build_sdcpp_image_metadata_json` / `get_image_params`
  整体删除（约 300 行），元数据构建移入内核 `src/generation_info.cpp`。
- `docs/generation_metadata.md`（新增）：schema 为 `sdcpp.generation/v1`，
  **seed 是十进制字符串**（保全 int64 范围）；字段跟随 C 参数结构体。
- 嵌入布局不变：`<WebUI infotext>, SDCPP: <native JSON>`（PNG tEXt `parameters` /
  WebP XMP `sdcpp:parameters`），所以 `png_info.rs` 的提取器**无需改动**，
  坏的是前端映射器 `sdcppMetadataToGenParams`（`src/lib/utils.ts:1314`）。

**新旧键位对照**（只列映射器用到的）

| 旧 schema                                   | 新 schema                                                             |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `prompt.positive` / `prompt.negative`       | `prompt` / `negative_prompt`（扁平字符串）                            |
| `seed`（number）                            | `seed`（**string**，十进制）                                          |
| `sampling`                                  | `sample_params`（键名同请求体：sample_method/sample_steps/guidance…） |
| `high_noise_sampling`                       | `high_noise_sample_params`（video）                                   |
| `video.frame_count` / `video.fps`           | `video_frames` / `fps`（顶层，video）                                 |
| `vae_tiling`                                | `vae_tiling_params`（键名同请求体）                                   |
| `image_preprocess`（字符串数组）            | `image_preprocess.rules`（对象包一层）                                |
| `cache.requested_mode` / `requested_option` | `cache.mode`（字符串名）+ 结构化参数，**无原始 option 串**            |
| `loras[].name`（basename）                  | `loras[].path`（相对 lora-model-dir 或原路径）                        |
| `hires.*`                                   | `hires.*`（基本不变，新增 model_path）                                |
| ——                                          | `control_type`、`kind`（image/video）、`models`                       |

**兼容策略**：旧图仍在野外（输出目录历史画廊按文件读元数据），映射器按
`meta.schema` 分流：`sdcpp.generation/v1` 走新映射，其余走旧映射。新映射里
seed 用 `Number(meta.seed)` 解析字符串；cache 用结构化参数重建
`cache_options` 草稿（`buildCacheOption` 的逆操作，键名与 F-18 草稿一致）；
LoRA 按 path 的 basename 匹配 `availableLoras`（复用 `matchAvailableLora`）。

**落点**：`src/lib/utils.ts::sdcppMetadataToGenParams` + `GenerationUI.tsx:905`
注释 + `src/lib/__tests__/utils.test.ts` 双 schema 夹具。`png_info.rs` 不动
（提取器与 schema 无关，旧测试继续验证旧图兼容）。

### 2.2 随机种子的实际值回显（随 #2206，协议 additive 但体验断裂）

旧内核在 `common.cpp::resolve` 里解析 `seed < 0`；本轮该逻辑移入内核，
**请求侧语义不变**（仍发 -1），但结果项现在携带每张图的实际 seed
（`generation_info.seed`）。Lumina 的任务行/结果卡目前只能显示「随机」，
新内核下应回显实际种子（否则用户无法复现一张满意的随机图）。
落点见 §3.2，与 generation_info 接入合并实施。

## 3. 应处理（P1）

### 3.1 结构化进度 `progress`（#2303）

**协议**（`api.md` + `async_jobs.cpp::make_async_job_json`）：任务 JSON 恒带
`progress` 对象（queued 也有）：

```json
{
  "stage": "sampling",
  "detail": "low_noise",
  "pass": 2,
  "completed": 12,
  "total": 20,
  "unit": "steps",
  "stage_elapsed_ms": 8200,
  "elapsed_ms": 15400
}
```

- stage：`queued / waiting / preparing / conditioning / sampling / vae_encode /
vae_decode / audio_decode / upscaling / adetailer / encoding`，可重复可跳过，
  **客户端必须容忍未知值**。
- `completed/total` 在未知时为 **null**（不是估算百分比）；`unit` 为
  `steps`（采样）/ `images`（编码）/ null。
- 比例是**当前 pass** 的进度，不是整项任务完成度；hires/高低噪/ADetailer
  都会让 pass 自增清零。
- 终态后 elapsed 冻结，stage 保留供检查。

**Lumina 现状**：进度来自日志行解析（`store.ts` 的 `progressStep/progressTotal`），
只有采样步数、全局一份、依赖日志格式；非采样阶段（VAE 解码/编码/ADetailer）
界面只能显示「生成中」。

**落点**（保守增量，旧内核回落日志解析）：

1. `types.ts`：`JobProgress` + `Job.progress?`（轮询已 `...d` 展开，自动进 store）。
2. `JobQueue.tsx`：generating 任务有 progress 时显示阶段中文标签 +
   `pass>1` 时的段号；`unit=steps` 且 total>0 时用 completed/total 画进度条，
   否则保留日志进度条。
3. `GenerationUI.tsx`：当前任务的「FRAME x/y」行在有 progress 时补充阶段文案。
4. 任务栏全局进度（`useSystemIntegration`）仍走日志解析，不动。
5. 阶段文案映射集中在 `src/lib/utils.ts`（`progressStageLabel`），未知 stage
   原样显示，不猜。

### 3.2 结果 `generation_info`（#2206）

**协议**：

- img_gen 结果项：`images[i].generation_info`（对象，`sdcpp.generation/v1`，
  含该图实际 seed，**无 batch_count**）。
- vid_gen 结果：`result.generation_info`（视频请求快照）。
- `/upscale` 响应：顶层 `generation_info`（多次 repeats 合并）。
- **与 `embed_image_metadata` 无关**：关掉元数据嵌入也照样返回。

**落点**：

1. `types.ts`：`JobImage.generation_info?` / `JobResult.generation_info?` /
   `UpscaleResponse.generation_info?`（宽松 `Record<string, unknown>`，不锁结构）。
2. `ResultsGrid.tsx`：图片卡片显示实际 seed（`generation_info.seed` 字符串转
   number）；随机种子任务完成后不再只显示「随机」。
3. 「应用此配置」优先带回 `generation_info` 的实际 seed（`applyConfig` 第三参）；
   参数本体仍用提交时的 config 快照（与请求参数同源，比元数据映射更完整），
   下载文件名同样优先实际 seed。

### 3.3 `control_type`（#2284 / #2187）

**协议**：请求体字符串字段（`from_json_str` 消费），枚举
`openpose / depth / scribble / canny / normal / segment / tile / repaint`
（tile/repaint 仅 Union ProMax）；别名 hed/softedge/pidi/ted→scribble、
lineart/anime_lineart/mlsd→canny、seg→segment、inpaint/outpaint→repaint。
**SDXL ControlNet Union 必需**，其它 ControlNet 忽略；非法值 resolve 失败 → 400。
`--control-type` 是**生成期参数**（sd-cli），sd-server 启动不认（§6 误报说明）。

**落点**：`GenParams.control_type?` → `buildRequestBody` img_gen 分支
（非空才发）→ ControlNet 输入区加「控制类型」选择器（仅当 control_image 存在
且内核 capabilities 默认值里出现该键时显示；旧内核无此键则隐藏）→
`types.ts` 注释写明 Union 必需/其它忽略。Z-Image ControlNet（#2187）复用同一
控件，无需家族特判。

### 3.4 新家族（62 → 66）

| 家族 id                     | 上游                                  | 组件                                                                                                 | 默认值（docs 为准）                                                                                        |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `minimax-h3-image`          | #2324 `docs/minimax_h3_image.md`      | Diffusion + 专用图像 VAE + Qwen3-VL-32B（复用 H3 TE）+ llm_vision 可选                               | euler / CFG 1 / 6 步 / sigmas `minimax-h3-image` / 1024² / 32 对齐                                         |
| `p-h3-image`                | #2272 `docs/p_h3_image.md`            | Diffusion + 单帧 VAE + Qwen3-VL-4B + text connector（`--embeddings-connectors`，可选：官方包已内置） | euler / CFG 1 / 8 步 / sigmas `p-h3-image` / 2912²（上游默认，提示小画布省显存）/ 32 对齐 / VAE tiling 256 |
| `hyperflow-h3-flash`        | #2299 `docs/minimax_h3.md` §HyperFlow | 同 MiniMax-H3 FL2VA 组件                                                                             | euler / CFG 1 / 6 步 / sigmas `hyperflow-h3-flash-6` / 864×480 / 24fps                                     |
| `hyperflow-h3-flash-ref2va` | 同上（Ref2VA checkpoint）             | 同 MiniMax-H3 Ref2VA 组件                                                                            | 同上 + ref_images 必需                                                                                     |

**sigmas 预设**：请求体 `custom_sigmas` 只认数值数组（预设名是 CLI 解析层），
所以把上游 `common.cpp` 的预设数值直接写进家族 `genDefaults.sample_params.custom_sigmas`：

```text
minimax-h3-image:      1.0, 0.9675236940383911, 0.8875485062599182, 0.75, 0.5327739119529724, 0.23200887441635132, 0.0
p-h3-image:            1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0
hyperflow-h3-flash-4:  1.0, 0.962575853, 0.755781889, 0.312497854, 0.0
hyperflow-h3-flash-6:  1.0, 0.982655942, 0.914642572, 0.674755692, 0.385223746, 0.159055337, 0.0
hyperflow-h3-flash-8:  1.0, 0.993909776, 0.9842875, 0.966063678, 0.923076928, 0.834942341, 0.696852028, 0.468753338, 0.0
```

调度长度即步数（上游语义），家族 generationHint 写明「步数由调度表决定」。

**识别规则**（`family.rs`，顺序敏感）：

- `minimax_h3_image` / `minimax-h3-image` 必须**先于**现有 `minimax_h3` 规则
  （否则图像权重被吞进视频家族）；
- `p-h3-image` / `p_h3_image` / `ph3-image` 新规则；`is_diffusion_model_name`
  补 `p-h3` / `p_h3` / `hyperflow`；
- `hyperflow` 先于 minimax 规则（文件名不含 minimax，但目录可能含）；
  带 `ref2va` 的归 ref2va 支；
- TE 分类不受影响（`qwen3vl` 规则已覆盖）；`minimax_h3_image_vae` 走现有
  vae 分类，`p-h3-image_vae` 需确认 vae 规则命中（含 `vae` 子串即可）；
- `p-h3-image_text_connector.safetensors` 归 `embeddings_connectors` 类别
  （现有 `connector` 关键词在 is_llm_encoder 里会误吞——需先按
  `text_connector` / `embeddings_connectors` 文件名特征分流，实施时验证）。

**尺寸/帧对齐**：两个图像家族进 `SIZE_SPATIAL_ALIGN`（32）；hyperflow 两支
复用 H3 的 `17k+5` 特判、`VIDEO_FRAME_MAX`（481）与帧预设。

### 3.5 Ref2VA 参考视频/音频（#2194，等待已久的升级）

**协议**：vid_gen 请求体新增

- `ref_videos`：`string[][]` —— 每个参考视频是一组 base64 帧（**JSON 通道固定
  按 24fps 解释**，`common.cpp::to_sd_vid_gen_params_t` 硬编码 24）；
- `ref_audios`：`string[]` —— base64 **WAV**（`load_wav_from_memory`，其它格式 400）；
- `ref_video_audios`：`string[]` —— 与 ref_videos 按序配对的音轨；
  校验 `ref_video_audios.size() <= ref_videos.size()`（含 CLI 路径合并计数）。
- capabilities `features_by_mode.vid_gen` 新增 `ref_videos / ref_audios /
ref_video_audios` 三个布尔（旧内核缺键 → 隐藏控件）。

**落点**：

1. `GenImages` 增加 `refVideos: string[][]` / `refAudios: string[]` /
   `refVideoAudios: string[]`；`buildRequestBody` vid_gen 分支按 feature 发送。
2. 图片输入面板（仅 ref2va 家族 + feature 开启时）：
   - 参考视频：选视频文件 → `<video>` + canvas **按 24fps 抽帧**（短边缩到
     ≤1024，JPEG 0.92，帧数上限 481 ≈ 20s，超限截断并提示）；
   - 参考音频 / 视频音轨：只收 `.wav`，读 base64；音轨数超过视频数时阻止提交。
3. `minimax-h3-ref2va` / `hyperflow-h3-flash-ref2va` 的 hint 更新（去掉
   「仅 sd-cli」措辞）；`requiredInputsByMode` 保持 ref_images 必需
   （上游 Ref2VA 语义：参考条件至少一路，界面以参考图为最低门槛）。
4. 互斥声明沿用（参考条件 vs 首尾帧）；`ref_videos`/`ref_audios` 加入互斥组。
5. 内存：帧数组进 job config 快照，受 `MAX_JOB_CONFIG_BYTES` 约束；
   481 帧 × ~100KB ≈ 48MB 上限，抽帧分辨率封顶就是为了这个。

### 3.6 MiniMax-H3 latent hires（#2249）

上游 H3 视频现在支持 `--hires` 二段采样（Latent 插值或学习型放大器）。
约束：**与首尾帧条件互斥**（内核直接失败）；学习型放大器训练域 1.2–2.0×、
拒绝缩小；宽高仍 32 对齐；帧数不变。

**落点**：H3 四族（fl2va/ref2va/hyperflow 两支）的 `exclusiveInputGroups`
增加 hires × init_image / end_image 声明；hires 面板对 vid 家族本就可用
（实施时确认），generationHint 补一句「二段采样不支持首尾帧」。
学习型放大器走现有 `--hires-upscalers-dir` 通道，不新增控件。

### 3.7 队列治理参数（#2316）

`--max-pending-jobs`（默认 64，须 >0）/ `--completed-ttl-seconds`（默认 600，
须 ≥0）是**真正的 sd-server 启动参数**。单用户 GUI 用默认值足够，不做面板
控件；写进「附加启动参数」时 `cli.rs::validate_args` 应给出取值校验与旧内核
不支持提示（加入现有 `--taesd-preview-only` 那组 match）。

**TTL 语义**：完成/失败任务 600s 后被清理，GET/cancel 回 **410 Gone**
（`expired_jobs` 墓碑保留 max(ttl,60)s）。Lumina 轮询只跟踪非终态任务，
404/410 聚合提示已实现（`useJobPolling.ts:76`），**无需改动**；登记备查。

## 4. 只需登记（P2）

| 项                                                      | 现状与裁定                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SeedVR2 / RelayVSR（#2300/#2285）                       | `-M vid_upscale` 是 **CLI-only** 模式，sd-server `supported_modes` 不含它；Lumina 全部走 HTTP，**不接**。权重会被扫描器当普通模型列出，README 已知限制写明 |
| Sol-H3-VAE（#2317）                                     | H3 视频的蒸馏解码器，`--vae` 槽位直接替换；时间分块默认 10/5 latent 帧、须 5 的倍数——H3 家族 generationHint 补一句；扫描器 vae 分类已覆盖                  |
| `minimax_h3_attn_chunk_budget`（#2292）                 | 走 `--model-args`（GiB，默认 2，0=关闭分组）；Lumina 的 model-args 通道已存在，不新增控件，README 提示写法                                                 |
| recipe `size_multiple` / `video_constraints` / 幂等加载 | Lumina 不消费 recipe（§5），仅登记；`already_loaded` 等字段不影响现有错误映射                                                                              |
| Chroma 独立版本 id / SDXL 独立 UNet 识别                | 内核张量级识别改进；Lumina 按文件名识别，不受影响                                                                                                          |
| 帧对齐文档化（api.md）                                  | 上游把 `4n+1` 笼统说法改成按家族表；Lumina `VIDEO_FRAME_ALIGN` 早已按源码实现（wan 4 / ltx 8 / H3 17k+5 / AnimateDiff≤32），**核对一致，无需改**           |
| Wan2.2 S2V 固定 16fps                                   | Lumina 无 wan-s2v 家族（音频驱动视频未适配），不适用                                                                                                       |
| `--list-devices` / auto-fit / layer-split 修复          | 启动参数语义不变，设备预检逻辑不受影响                                                                                                                     |
| 日志 sigma 打印（#2205）                                | 仅日志文本；logFormat 不解析，无影响                                                                                                                       |
| `--embeddings-connectors` 描述扩展                      | LTXAV → LTXAV/P-H3-Image；p-h3-image 家族自带该字段，ltxav 文案不动                                                                                        |

## 5. 战略项：recipe 体系（继续不接）

本轮 recipe 演进：`size_multiple`（UI 尺寸步进元数据）、`video_constraints`
（帧数/FPS 约束元数据）、recipe 内 `models` 默认选择、`models/load` 幂等
（`already_loaded: true`）。这些**全部服务于上游 WebUI 的 recipe 模型管理**，
不改变生成协议。Lumina 的家族体系（必需组件 + docs 默认值 + 尺寸对齐）与
recipe 的产品政策（20 步上限等）冲突依旧，上一轮 §5 的四条理由全部成立。
`video_constraints` 的帧对齐声明与 Lumina `VIDEO_FRAME_ALIGN` 是同一真相的
两种表达，继续以源码为准。

## 6. 工具链：本轮暴露的三个盲区

1. **键提取器只认 `load_if_exists`**：`ref_videos/ref_audios/ref_video_audios`
   走 `parse_image_array_json_field` / `parse_audio_array_json_field` /
   `parse_video_array_json_field`，漂移与覆盖模式都看不到。
   **修**：`extractJsonKeys` 追加这三个解析函数的键名提取。
2. **启动参数误报生成期参数**：`--control-type` 在 `SDGenerationParams`
   里，sd-server 启动只解析 `SDContextParams + SDSvrParams`。脚本现在把
   common.cpp 全部 `--x` 当启动参数。**修**：提取时区分
   `SDContextParams::get_options` / `SDSvrParams`（runtime.cpp）与
   `SDGenerationParams::get_options` 的文本区间，生成期参数只报「请求侧新增」
   不报「启动参数新增」。
3. **语义检查补两条**：`progress` 对象出现（api.md `progress.stage`）、
   `generation_info` 出现（api.md `sdcpp.generation/v1`）时提示界面落点，
   与现有时间戳/cancel/ADetailer 检查并列。

## 7. 验收清单

```bash
# 1. 机器检查（本地克隆，离线）
node scripts/upstream-diff.mjs --upstream <sdcpp> --since 95ff762 --ref 32d516c
node scripts/upstream-diff.mjs --coverage --upstream <sdcpp> --ref 32d516c

# 2. 前端
npm run check:types && npm test && npm run lint && npm run check:format
# 3. Rust
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
# 4. 版本与构建
npm run check:version && npm run build
```

手工验收（按新内核 `32d516c` 构建的 sd-server）：

| 场景                                      | 期望                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| 新内核出图 → 历史画廊「恢复参数」         | prompt/seed/采样参数完整恢复（新 schema）；旧图仍正常                 |
| 随机种子任务完成                          | 结果卡显示实际 seed；「应用此配置」带回该 seed                        |
| 生成中观察任务行                          | 阶段文案（条件编码/采样/VAE 解码/编码）+ 段内进度；旧内核回落日志进度 |
| SDXL Union + control_type=canne（非法）   | 提交前界面枚举拦截；合法值正常生成                                    |
| MiniMax-H3-Image 启动                     | 识别 minimax-h3-image，6 步 / CFG 1 / 1024²，参考图编辑可用           |
| P-H3-Image 启动                           | 识别 p-h3-image，8 步 / CFG 1，connector 可选                         |
| HyperFlow H3 Flash                        | 识别 hyperflow-h3-flash，6 步调度表生效                               |
| Ref2VA + 参考视频（24fps 抽帧）+ WAV 音轨 | 请求体带 ref_videos/ref_video_audios；音轨多于视频时阻止提交          |
| H3 视频 hires + 首帧                      | 互斥提示阻止提交                                                      |
| 附加启动参数 `--max-pending-jobs 0`       | 启动预检报错（须 >0）；旧内核报「不支持」                             |
| 完成任务放置 >10min 后查队列              | 410 聚合提示「任务已失效」，不崩溃不风暴                              |

## 8. 建议的提交拆分

1. `fix(metadata): 兼容 sdcpp.generation/v1 元数据 schema`（P0，双 schema 夹具）
2. `feat(jobs): 结构化进度与 generation_info 回显`（P1，types + JobQueue + ResultsGrid）
3. `feat(controlnet): control_type 选择器`（P1）
4. `feat(family): MiniMax-H3-Image / P-H3-Image / HyperFlow H3 Flash`（P1，含 H3 hires 互斥）
5. `feat(video): Ref2VA 参考视频/音频输入`（P1）
6. `chore(server): 队列参数预检与裁定登记`（P2，cli.rs + UPSTREAM-SYNC.md + README 限制）
7. `chore(sync): 对齐号更新到 32d516c`（**最后**：README + CHANGELOG + 本文落地状态 +
   upstream-diff.mjs 盲区修补）

## 9. 需要上游确认 / 留档的疑点

1. **ref_videos 的 fps 硬编码 24**：C API 每个参考视频自带 fps，JSON 通道却
   固定 24（`common.cpp`）。非 24fps 素材按 24fps 抽帧会变速——界面抽帧器
   按 24fps 采样以匹配协议，文档写明。建议上游在 JSON 协议里暴露 per-video fps。
2. **P-H3-Image 默认 2912²**：docs 示例尺寸，8.5MP 对消费级显卡极重；
   Lumina 按「docs 为准」口径采用，generationHint 明确提示缩小画布。
3. **cache 元数据丢失原始 option 串**：新 schema 只存结构化参数，恢复时
   未知键无法保留（旧 schema 有 requested_option）。映射器按已知键重建草稿，
   未识别参数丢弃并在注释里说明。
4. **`--control-type` 与 capabilities**：旧内核 defaults 无该键，界面据此
   隐藏控件；但「内核支持与否」与「模型是否 Union」是两件事，控件提示
   写明「仅 Union 模型必需，其它模型忽略」。

## 10. 落地状态（2026-11-11）

本轮按 §8 的拆分实施（对齐号放在最后）：

| 项                          | 状态 | 落点                                                                                                                                           |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 元数据双 schema          | 完成 | `sdcppMetadataToGenParams` 按 schema 分流 + `generationV1ToGenParams`（字符串 seed、cache_dit 归一、草稿重建、LoRA path 匹配）；双 schema 夹具 |
| P1 结构化进度               | 完成 | `JobProgress` 类型、`jobProgressSummary` / 阶段文案映射、JobQueue 阶段文案 + 段内进度条、GenerationUI 页头；旧内核回落日志解析                 |
| P1 generation_info 实际种子 | 完成 | 三处宽松类型、ResultsGrid 种子回显、applyConfig 第三参、下载文件名优先实际种子                                                                 |
| P1 control_type             | 完成 | GenParams + buildRequestBody（仅 img_gen 非空发送）、ImageInputsPanel 枚举选择器（capabilities 含键才显示）、新 schema 回填                    |
| P1 新家族 ×4                | 完成 | family.rs 识别/分类（text_connector→embeddings）+ 用例；families.data.ts 四条配置（数值 sigmas）、32 对齐、17k+5 帧网格、TAE 提示；README 66   |
| P1 H3 hires 互斥            | 完成 | RequiredInput 增 hires 伪输入、exclusiveInputConflicts 接受 params、四个 H3 视频家族声明；FL2VA generationHint 补 Sol-H3-VAE/attn 预算         |
| P1 Ref2VA 参考媒体          | 完成 | refMedia.ts（24fps 抽帧/WAV 校验/配对校验）、RefMediaSection、store/快照/模式切换/应用配置全链路、filterFamilyInputs 裁剪、字节预算计入        |
| P2 队列参数预检             | 完成 | cli.rs 三处登记 + 取值校验 + 新旧内核用例                                                                                                      |
| P2 裁定登记                 | 完成 | UPSTREAM-SYNC.md 裁定表（SeedVR2/RelayVSR、队列参数、attn 预算、recipe 演进）、README 已知限制                                                 |
| P2 工具链盲区               | 完成 | upstream-diff.mjs：parse_*_array_json_field 键提取、生成期/启动参数分流、progress 与 schema 换代语义检查；复跑输出与 §0 一致                   |
| 对齐号 / README / CHANGELOG | 完成 | README `32d516c` + 家族清单 66 + 对齐段落重写；CHANGELOG [Unreleased]；本文                                                                    |

验证：`npm run check:types`、`npm test`（550 passed）、`npm run lint`（0 errors）、
`cargo test`（family 33 / cli 15 及其余用例）均通过；
`node scripts/upstream-diff.mjs --since 95ff762 --ref origin/master` 现在报
2 个启动参数 + 4 个请求字段 + 2 条语义变化，`--control-type` 归入生成期信息栏；
`--coverage` 32 个字段全部有落点。

## 附：证据文件清单（上游 `32d516c`）

- `examples/server/api.md`（progress 对象、generation_info、control_type、
  ref_videos/ref_audios/ref_video_audios features、帧对齐表、recipe 新元数据）
- `examples/server/async_jobs.cpp` / `.h`（progress 发布、TTL 清理、410 墓碑、
  result_generation_info）
- `examples/server/runtime.cpp` / `.h`（--max-pending-jobs / --completed-ttl-seconds、
  ADetailer 门控 adetailer_enabled）
- `examples/server/routes_sdcpp.cpp`（features 三新键、/upscale generation_info、
  max_queue_size、410 路由）
- `examples/server/routes_sdapi.cpp` / `routes_openai.cpp`（generation_info 各通道）
- `examples/common/common.cpp`（control_type、ref_* 解析、vid_upscale 模式、
  sigmas 预设、旧元数据函数删除、seed 解析移入内核）
- `src/generation_info.cpp` / `.h`（sdcpp.generation/v1 序列化）
- `docs/generation_metadata.md`（新 schema 语义、容器元数据位置、LoRA 相对路径）
- `docs/minimax_h3_image.md` / `docs/p_h3_image.md`（新家族组件与默认值）
- `docs/minimax_h3.md`（Sol-H3-VAE、latent hires、attn_chunk_budget、HyperFlow）
- `docs/seedvr2.md` / `docs/relay_vsr.md`（CLI-only vid_upscale）
- `src/model_loader.cpp`（VERSION_P_H3_IMAGE / VERSION_MINIMAX_H3_IMAGE /
  VERSION_CHROMA、SDXL add_embedding 识别）
