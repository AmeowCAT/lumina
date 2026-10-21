# 与上游 `sd-server` HTTP API 的协议对齐 审查报告

> 审查者：api-alignment 组　范围：`/sdcpp/v1` 报文面（请求体 / 响应体 / 任务模型 / 能力探测 / 元数据）
> 上游：`C:\Users\Administrator\AppData\Local\Temp\lumina-audit\stable-diffusion.cpp` @ `d55cc0f`
> 上游官方 webui（第三方实现，用于三方对照）：`...\lumina-audit\sdcpp-webui`
> 本仓库：`D:\Project\AmeowCAT\lumina` @ `d442371`（只读审查，未改动任何源码）

## 0. 结论摘要（≤10 条）

1. **无 P0**。字段名/类型/单位层面 Lumina 与上游解析器**高度一致**：`from_json_str` 接受的 61 个键里，Lumina 会用到的键没有一个拼错、没有一个类型错；`sample_params`/`guidance`/`slg`/`hires`/`vae_tiling_params`/`lora` 的嵌套结构与上游逐字段吻合（§2.1 总表）。
2. **P1**：`vid_gen` 的 animated WebP 输出（`mime_type: "image/webp"`）在 Lumina 被无条件当视频塞进 `<video>`，**不可播放**；在「有 WebP、无 WebM」的构建里这甚至是 capabilities 报出的**默认视频格式**（§2.2）。
3. **P1**：PNG 元数据回填 LoRA **永远匹配不上**——上游元数据写 `name = 含扩展名的文件名`，capabilities 里 `name = stem`，Lumina 用 `name === name` 比较（§2.3）。
4. **P1**：`capabilities` 存在但缺 `defaults_by_mode`/`current_mode`（旧内核、裁剪响应、手搓内核）时，生成界面直接 `return null` → **白屏且无任何提示**，`App.tsx` 的兜底只覆盖「caps 拉取失败」不覆盖「200 但形状不同」（§2.4）。
5. **P2**：`features.*` 在两条路径上用了**相反的极性**——面板显隐用真值（缺键即隐藏），提交时禁用用 `=== false`（缺键即照发），同一个缺失键会得到「隐藏但仍生效」（§2.5）。
6. **P2**：`output_format` 从不按 `output_formats_by_mode` 校验，跨内核切换后 localStorage 里的旧值会让**每次提交都 400**，而 UI 里该值已不在选项内（§2.6）。
7. **P2**：`samplers[]`/`schedulers[]` 之外的陈值被**刻意保留并发送**，上游对未知枚举值是静默忽略，于是「界面显示 A、实际用默认」（§2.7）。
8. **P2**：上游 job 对象里的 `queue_position`（1 起）/`started`/`completed` **完全没有被取用**，队列位置与真实生成耗时都拿不到（§2.8）。
9. **P2**：视频 `temporal_tiling` / `extra_tiling_args`（`temporal_tile_frames`、`temporal_tile_overlap`）在类型里有、**无任何 UI**，长视频降内存的唯一手段不可达（§2.9）。
10. **f0aac52 之后 3 个提交对报文面零影响**：改动只落在 `src/model_loader*`、`src/name_conversion.cpp`、`src/model/adapter/lora.hpp`、`docs/moss_image.md`，`examples/server/**`、`examples/common/**` 一行未动，**不要求 Lumina 改任何协议代码**（§2.13）。

## 1. 审查范围与方法

**上游权威依据**（读全）：

| 上游文件 | 用途 |
|---|---|
| `examples/server/api.md`（1472 行） | 三种 API 的契约文档（行号见各处引用） |
| `examples/server/routes_sdcpp.cpp`（829 行） | `/sdcpp/v1` 真实实现：capabilities 形状、请求解析、状态码、错误体 |
| `examples/server/async_jobs.cpp`（432 行） | 任务状态机、job JSON、preview、cancel、队列上限、TTL |
| `examples/server/runtime.cpp`（411 行） | 输出格式枚举、LoRA 缓存与路径解析、`unix_timestamp_now` |
| `examples/common/common.cpp`（3318 行） | **真正的字段解析器** `from_json_str`（2096-2329）、`validate`（2581-2698）、`resolve`（2530-2579）、元数据生成（3032-3224） |
| `examples/common/common.h` | `SDGenerationParams` 默认值（201-335） |
| `thirdparty/stb_image_write.h` | PNG tEXt 关键字与长度上限 |

**上游官方 webui**（第三实现，只作对照，不作权威）：`src/lib/form-request.ts`、`form-capabilities.ts`、`form-defaults.ts`、`types.ts`、`App.vue`。

**本仓库**：`src/types.ts`、`src/lib/utils.ts`（`buildRequestBody` 等，全部请求体构造集中在此一处——grep `buildRequestBody` 只命中它）、`src/api.ts`、`src/hooks/useJobPolling.ts`、`src/hooks/useBlobUrlCache.ts`、`src/hooks/useVideoPoster.ts`、`src/components/generation/*`、`src-tauri/src/sdcpp.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/cli.rs`、`src-tauri/src/png_info.rs`。

**方法**：先读上游 C++ 解析器逐键列出「接受什么、什么类型、缺省怎么走」，再读 Lumina 的构体函数逐键比对，最后用上游 webui 做第三方投票；三者不一致时以 `routes_sdcpp.cpp` + `common.cpp::from_json_str` 的实际解析为准。未跑任何构建/测试命令（分工要求）。

**一条贯穿全文的关键事实**：`from_json_str` 用 `load_if_exists`（`common.cpp:2110-2136`）逐键读取，**类型不符就静静跳过、键名不认识就静静忽略，绝不报错**。所以「字段名写错」在 sd-server 上不会变成 400，而是**参数静默失效**。这条决定了本报告里多处「类型/命名」结论的严重级别要上调。

## 2. 问题清单

### 2.1 请求体字段三方核对总表（结论：一致的项）

上游解析基准：`common.cpp:2096-2329`。`—` = 该实现不发送该键。

| 上游字段（请求体） | 上游类型 / 缺省 | C++ 依据 | 上游 webui | Lumina 发送方式 | 结论 |
|---|---|---|---|---|---|
| `prompt` / `negative_prompt` | string | `common.cpp:2138-2139` | 同 | `utils.ts:754-755` 恒发 | 一致 |
| `clip_skip` | int，缺省 -1=未指定 | `common.cpp:2149` | 恒发（-1） | `utils.ts:764-765` 仅 `!== -1` 时发 | 一致（省略=沿用服务端启动值，比 webui 恒发 -1 更保真） |
| `width` / `height` | int，-1→512 | `common.cpp:2150-2151`，`2427-2429` | 512 | `utils.ts:756-757` 恒发 | 一致 |
| `seed` | int64，<0 → 随机 | `common.cpp:2157`，`2541-2544` | -1 | `utils.ts:758` + 提交前 `randSeed()`（`GenerationUI.tsx:401-405`）| 一致（Lumina 自己掷种子，便于复现） |
| `strength` | float 0..1 | `common.cpp:2159`，校验 `2601` | 0.75 | `utils.ts:766` | 一致 |
| `batch_count` | int，strict 下夹到 1..8 | `common.cpp:2152`，`2547` | 1 | `utils.ts:775`；UI 上限 `SizeSeedPanel.tsx:208` = `limits.max_batch_count` | 一致 |
| `qwen_image_layers` | int ≥0 | `common.cpp:2153`，校验 `2591` | — | `utils.ts:776-777` | 一致（webui 缺） |
| `image_preprocess` | `string \| array<string>`（分号拼接） | `common.cpp:2107-2108`，`2073-2094` | — | `utils.ts:769-772` 发数组 | 一致（webui 缺） |
| `ref_image_args` | string，**整体覆盖**服务端默认 | `common.cpp:2147` | — | `utils.ts:781-782` + `buildRefImageArgs`（`406-421`）自动带上启动期 `preset=` | 一致且比 webui 完整 |
| `increase_ref_index` | bool | `common.cpp:2165` | 恒 false | `utils.ts:783` | 一致 |
| `control_strength` / `ip_adapter_strength` | float | `common.cpp:2160-2161` | 0.9 / — | `utils.ts:784-785` | 一致 |
| `embed_image_metadata` | bool | `common.cpp:2166` | — | `utils.ts:786`（仅 img_gen） | 一致（见 §2.10 vid 侧缺口） |
| `sample_params.sample_steps` | int，strict 夹 1..100 | `common.cpp:2204`，`2548` | 20 | `utils.ts:738`；UI 上限 100（`SamplingPanel.tsx:178-181`）| 一致（UI 上限与内核夹取相同，用户不会遇到静默夹取） |
| `sample_params.sample_method` / `scheduler` | string，未知值静默忽略 | `common.cpp:2224-2235` | 过滤 `"default"` | `utils.ts:735-739` `noDefault()` 过滤 `"default"` | 一致（连「default 不该发」这个细节都和 webui 相同） |
| `sample_params.eta` / `flow_shift` | float，缺省跟后端 | `common.cpp:2207-2215` | 空串即省略 | `utils.ts:809-810` | 一致 |
| `sample_params.shifted_timestep` | int 0..1000 | `common.cpp:2210`，校验 `2644` | 0 | `utils.ts:811` | 一致 |
| `sample_params.custom_sigmas` | float[] | `common.cpp:2219-2223` | 恒 `[]` | `utils.ts:812` | 一致 |
| `sample_params.extra_sample_args` | string（`key=value`） | `common.cpp:2216-2218` | — | `utils.ts:751-752` + `buildExtraSampleArgs`（`268-295`）| 一致，且 Lumina 把 beta/lms 结构化字段正确降维成该串 |
| `sample_params.guidance.txt_cfg` | float ≥0 | `common.cpp:2238`，校验 `2606` | 7 | `utils.ts:740-742` | 一致 |
| `sample_params.guidance.img_cfg` | float\|null | `common.cpp:2241` | 空即省略 | `utils.ts:813-815` | 一致 |
| `sample_params.guidance.distilled_guidance` | float | `common.cpp:2244` | 3.5 | `utils.ts:746-750`（仅有限值才发） | 一致 |
| `sample_params.guidance.slg.{layers,layer_start,layer_end,scale}` | int[] / float | `common.cpp:2247-2261` | 恒发 | `utils.ts:816-829`（scale>0 才发完整对象，否则显式 `{scale:0}`） | 一致且更安全（显式关闭，见 §2.1 注） |
| `high_noise_sample_params.*` | 同 `sample_params`，无 `custom_sigmas` | `common.cpp:2268-2274` | 恒发（steps=-1） | `utils.ts:885-914` | 一致 |
| `hires.{enabled,upscaler,scale,target_width,target_height,steps,denoising_strength,custom_sigmas,upscale_tile_size}` | 见 `common.h:271-280` | `common.cpp:2168-2197`，校验 `2657-2682` | — | `utils.ts:844-859`（关时显式 `{enabled:false}`） | 一致（webui 完全不支持 hires，Lumina 领先） |
| `vae_tiling_params.{enabled,target_overlap,extra_tiling_args}` | bool/float/string | `common.cpp:2276-2302` | 发 enabled/尺寸/overlap，**不发** `extra_tiling_args` | `utils.ts:860-864` + `resolveVaeTilingForProtocol`（`530-542`） | 一致（webui 缺） |
| `vae_tiling_params.tile_size_w/h`、`rel_size_w/h`（#2059 像素协议） | int/float，0=内核 256px 默认 | 同 | 恒发 w/h | 见 `utils.ts:431-447` 按 caps 键名选协议 | 一致，且是**本报告唯一认可的「版本门控正确」实现**（见 §2.11） |
| `vae_tiling_params.tile_size_x/y`、`rel_size_x/y`（旧 latent 协议） | int/float | 旧内核解析器 | — | 同上，仅在 `latent` 协议下发 | 一致 |
| `cache_mode` / `cache_option` / `scm_mask` | string | `common.cpp:2144-2146` | 恒发（含 `scm_policy_dynamic`） | `utils.ts:866-877`（关时显式 `"disabled"`） | 一致；**Lumina 不发 `scm_policy_dynamic` 是对的**——上游解析器根本不存在该键（`common.cpp:2144-2147` 无它），webui 发了等于没发，api.md:957 把它列为请求字段是**上游文档错** |
| `lora[].path` / `.multiplier` / `.is_high_noise` | string/float/bool，`path` 必须能被解析器在 `--lora-model-dir` 里**按相对路径精确命中** | `common.cpp:1982-2020`，`runtime.cpp:316-321` | 三条恒发 | `utils.ts:831-842`（`is_high_noise` 仅 true 时发） | 一致（`path` 用的是 caps 给的相对路径，正确；详见 §2.3 关于 name/path 的对比） |
| `init_image` / `mask_image` / `control_image` / `ip_adapter_image` | base64 或 dataURL；通道 0/1/3 | `common.cpp:2308-2319`，`1936-1951` | dataURL | `utils.ts:795-800`，dataURL（`readFileAsDataUrl`） | 一致 |
| `ref_images` / `control_frames` | `array<string>`，顺序即语义 | `common.cpp:2322-2326` | 发 | `utils.ts:804-807` | 一致 |
| `end_image` | 3 通道 | `common.cpp:2316` | 发 | `utils.ts:801`（仅 vid） | 一致 |
| `video_frames` / `fps` | int >0；`4n+1` 归一 | `common.cpp:2154-2155`，校验 `2626-2632` | 33 / **16** | `utils.ts:789-790`，缺省 **33 / 24** | 一致但**缺省值漂移**，见 §2.6 备注 |
| `moe_boundary` / `vace_strength` | float | `common.cpp:2162-2163` | 0.875 / 1.0 | `utils.ts:791-792` | 一致 |
| `preview` / `preview_interval` | string / int（非正夹 1） | `routes_sdcpp.cpp:432-433`，`async_jobs.cpp:47-59` | 恒发 | `utils.ts:879-883`（`none` 时不发 interval） | 一致（枚举值 `none/proj/tae/vae` 见 `src/stable-diffusion.cpp:192-197`，Lumina `families.ts:56-61` 名称表同步） |
| `output_format` / `output_compression` | string（img: png/jpeg[/webp]；vid: webm/webp/avi）/ int 夹 0..100 | `routes_sdcpp.cpp:427-431,456-460`，`runtime.cpp:99-157` | 恒发 | `utils.ts:759-760` | 一致（但缺少与 caps 的复核，见 §2.6） |
| 响应 `result.images[].{index,b64_json}` | — | `async_jobs.cpp:188-196` | 用 | `types.ts:384-396` | 一致 |
| 响应 `result.{b64_json,mime_type,fps,frame_count,output_format}` | — | `async_jobs.cpp:179-186` | 用 | `types.ts:389-396` | 类型一致，**使用方式有缺口**（§2.2） |
| 响应 `preview.{pass,step,total_steps,b64_json}` | 仅 `generating` 时存在 | `async_jobs.cpp:213-223` | 用 | `types.ts:442-451`、`ResultsGrid.tsx:52-60` 注释正确说明「段内进度」 | 一致（含对 pass 语义的正确理解） |
| 响应 `error` 两形状 | HTTP 层 `{error:string[,message]}` vs job 内 `{code,message}` | `routes_sdcpp.cpp:662` vs `async_jobs.cpp:201-207` | 混用两者（`api.ts:18`） | `utils.ts:111-132` 分开解析 | **一致，且比上游 webui 更严格**（webui 只取 `.error \|\| .message`，遇到对象形状会打出 `[object Object]`） |
| `created` 单位 | **秒** | `runtime.cpp:407-411` | 秒 | `types.ts:457-459` 明确注明；`JobQueue.tsx:51-59`、`ResultsGrid.tsx:112` 按秒换算 | 一致（唯一被显式文档化的单位约定） |

> 注：`{scale:0}` 显式关闭 SLG 这一点（`utils.ts:824-829`、`903-910`）值得单独肯定——因为请求体是在 `default_gen_params` 之上合并（`routes_sdcpp.cpp:417`），省略字段会沿用服务端启动值，**只有显式发 0 才能关闭**。上游 webui 恒发整套 slg（`form-request.ts:48-56`），在服务端默认开启 SLG 时反而无法关闭。

### 2.2 vid_gen 的 animated WebP 结果被当作视频渲染，无法播放

- 级别：**P1**
- 位置：`src/components/generation/ResultsGrid.tsx:404-418`、`734-748`、`:24`；`src/hooks/useBlobUrlCache.ts:11-20`
- 现状：分支只看载荷形状——`if (entry.result?.images)` 走图片，否则 `if (entry.result?.b64_json)` 一律走视频：
  ```ts
  const mime = entry.result.mime_type || "video/webm";
  const url = getVideoUrl(entry.jobId, b64, mime);   // -> new Blob([...], {type: mime})
  ...<VideoTile url={url} />                          // <video src={url} ...>
  ```
- 问题：`vid_gen` 支持三种容器，`mime_type` 分别是 `video/webm`、**`image/webp`**、`video/x-msvideo`（`runtime.cpp:159-167`）。animated WebP 的 `mime_type` 是 `image/webp`，把它塞进 `<video>` 必然 `error`，`useVideoPoster` 也只会静默返回 null（`useVideoPoster.ts:76`）——用户看到的是**一个永远黑屏、无报错的播放器**。更严重的是：`supported_vid_output_formats()` 的顺序是 `webm? → webp? → avi`（`runtime.cpp:73-83`），capabilities 的 `defaults_by_mode.vid_gen.output_format` 取 `formats[0]`（`routes_sdcpp.cpp:343-345`），**在「编译了 libwebp 但没有 libwebm」的 sd-server 构建里，默认视频输出就是 animated WebP**——即用户什么都不改也会踩到。AVI 同理（WebView2 通常不能播 MJPG-AVI），上游 webui 对此有显式提示（`App.vue:925-926`），Lumina 没有。
- 上游依据：`api.md:1339-1344`（`webp` = animated WebP）、`api.md:1358-1364`（mime 映射表）、`runtime.cpp:159-167`；上游 webui `App.vue:125-133` 用 `mime_type !== "image/webp"` 判定走 `<img>`，`App.vue:113-124` 用 `mime_type.startsWith("video/")` 才给 `<video>`。
- 建议：在 `ResultsGrid` 引入 `isAnimatedImageResult(result) = result.mime_type === "image/webp"`，命中时走 `<img>`（浏览器原生播放 animated WebP）；`mime_type === "video/x-msvideo"` 时给「此容器浏览器多半不能播放，建议下载」的提示（复用上游文案）。改动集中在 `ResultsGrid.tsx`（两处分支 + `VideoTile` 旁边新增一个 `AnimatedImageTile`）与 `Lightbox.tsx:294` 的类型判定。
- 与 frontend-arch 组的重叠：他们指出的 `HistoryGallery.tsx:38` 前端硬编码 `VIDEO_EXTS`（含上游**从不产出**的 `mp4`、缺 animated webp 的图片归类依据）是同一类「按扩展名/mime 猜渲染器」的问题。两处应一起改：结果区按 `result.mime_type` 判、历史画廊按 `output_format`→mime 的反查表判，且 `webp` 必须归到图片通道（当前 `IMAGE_EXTS` 已含 webp，`HistoryGallery.tsx:39`，所以**已保存**的 animated webp 反而能正常播放——这会加剧用户困惑：刚落盘的文件能看，结果区里的同一份数据不能看）。

### 2.3 从 PNG 元数据恢复 LoRA 永远匹配不上（stem vs 文件名）

- 级别：**P1**
- 位置：`src/lib/utils.ts:664-680`（关键行 670）；测试固化了错误假设：`src/lib/__tests__/utils.test.ts:1152-1170`
- 现状：
  ```ts
  const found = availableLoras.find((a) => a.name === name);   // name 来自元数据
  ```
- 问题：两侧的 `name` 语义不同。
  - 元数据侧：`{"name", sd_basename(entry.first)}`（`common.cpp:3146`、`3153`），而 `sd_basename` 只是「取最后一个路径分隔符之后」（`examples/common/log.cpp:8-18`）→ 得到**含扩展名的文件名**，例如 `style.safetensors`。
  - capabilities 侧：`lora_entry.name = p.stem().u8string()`（`runtime.cpp:286`）→ 得到 **stem**，例如 `style`。
  于是 `availableLoras.find(a => a.name === "style.safetensors")` 恒为 `undefined`，**所有 LoRA 都被静默丢弃**，`out.lora` 不写入。用户「从历史图片恢复参数 → 再生成」得到的是**没有 LoRA 的图**，且没有任何提示。当前测试用的假数据两侧都是 `"style.safetensors"`，所以绿灯掩盖了该缺陷。
- 上游/对照依据：上游自身无此问题（元数据只写名字，不负责回填）；webui 不做元数据回填。这是 Lumina 独有路径的一致性缺陷。
- 建议：匹配时做归一化——`a.name === name || a.path.endsWith("/" + name)`；更稳的做法是匹配 `path` 的 basename（`runtime.cpp:290` 的 `rel` 形态）。同时把 `utils.test.ts:1152-1170` 的假数据改成真实形状（`availableLoras` 用 stem，元数据用带扩展名文件名）。

### 2.4 capabilities 缺 `defaults_by_mode`/`current_mode` → 生成界面白屏且无提示

- 级别：**P1**
- 位置：`src/components/generation/GenerationUI.tsx:284-292`、`:1003`；`src/App.tsx:117-125`；类型假设 `src/types.ts:336-339`
- 现状：
  ```ts
  let d = caps.defaults_by_mode?.[mode];
  if (!d) {
    const fallback = caps.current_mode || caps.supported_modes?.[0];
    if (!fallback) return;          // params 永远为 null
    setMode(fallback); return;
  }
  ...
  if (!caps || !params) return null;      // GenerationUI.tsx:1003
  ```
- 问题：这是「旧内核 + 新界面」的正面失效点。`App.tsx:86` 只要 `sdcppCapabilities()` **HTTP 成功**就 `setCaps(c)` 并进入 `phase="running"`（`App.tsx:119-121`）；`App.tsx:117-125` 的兜底注释明确只覆盖「可达但 caps 拉不到（重启换模型加载中）」，**不覆盖「200 但形状不同」**。因此一个只返回旧式顶层 `defaults`/`features`（或手工裁剪/魔改）的 sd-server，会让用户停在**空白生成页**，日志里没有任何错误。`types.ts:339` 把 `defaults_by_mode` 声明为 `Partial<Record<GenMode, GenParams>>` 而非可选键，也说明这条降级路径没有被当作真实场景处理过。
- 上游依据：`routes_sdcpp.cpp:350-359`（`defaults_by_mode` 只在 `supports_*` 为真时写入）、`:367-378`（`current_mode` 可能为 `""`，`types.ts:335-336` 已正确建模）；`api.md:486-491` 说顶层 `defaults`/`output_formats`/`features` 是**deprecated 兼容镜像**，正是为这种情形准备的——Lumina 完全没有读这三个兼容字段。
- 建议（最小改动，`GenerationUI.tsx` 单文件）：`d` 取 `defaults_by_mode?.[mode]`，退而取 `caps.defaults`（兼容镜像，`api.md:464`），再退而取家族预设 `familyDefaults(cfg, mode)`；`mode` 取 `current_mode || supported_modes[0] || familyPreferredMode(cfg)`。并在 `App.tsx` 增加「caps 无 `defaults_by_mode` 也无 `defaults`」的 toast（说明内核过旧），把白屏换成可解释状态。

### 2.5 `features.*` 的两套门控极性相反：缺键时「面板隐藏但仍生效」

- 级别：**P2**
- 位置：显示侧 `src/components/generation/GenerationParamsSheet.tsx:127-133`、`:210`、`:240`、`:247`；`src/components/generation/panels/ImageInputsPanel.tsx:156-157`；提交侧 `src/components/generation/GenerationUI.tsx:398-399`
- 现状：
  ```tsx
  {features.hires && (<HiresPanel .../>)}                     // 缺键 → 面板消失
  showVaeTiling={features.vae_tiling !== false}                // 缺键 → 显示
  ...(features.hires === false ? { hires: { enabled: false } } : {}),   // 缺键 → 照发
  ```
- 问题：同一个「键不存在」在 UI 与提交两侧得到相反结论。对 `features` 块缺失/裁剪的内核：`hires`、`lora`、全部图片输入面板都会被隐藏（truthy 判定），但 `params` 里持久化的 `hires`/`lora`/图片输入仍会被发送（`=== false` 判定不成立）。用户既看不到、也改不了，却仍在生效——这类「隐形生效」比直接报错难排查得多。`features.vae_tiling` 则相反（缺键显示），三处规则不统一。
- 上游依据：`routes_sdcpp.cpp:195-225` 的两个 `make_*_features_json()` **全是硬编码常量**（`img_gen` 恒为 true，唯一 false 是 `cancel_generating`），`api.md:624-650` 把它们列为「Fields returned」。也就是说 `features` 目前是**握手标记而非真实能力**，缺它的内核一定很旧。
- 建议：统一成一个判定函数（例如 `featureEnabled(features, key, fallback)`），并让 `GenerationUI` 的面板显隐与请求裁剪共用同一结果：决定隐藏，就必须同时从 `params` 里把该能力对应字段清空/禁用，避免「看不见但发出去」。

### 2.6 `output_format` 不按 capabilities 复核，跨内核切换后每次提交 400

- 级别：**P2**（同节含一条 P3 的 `fps` 缺省漂移）
- 位置：`src/components/generation/GenerationUI.tsx:284-299`（参数来源）、`:393-412`（提交）、`src/components/generation/panels/OutputPanel.tsx:28-33`、`src/components/generation/GenerationParamsSheet.tsx:257`
- 现状：参数由 `deepMerge(caps.defaults_by_mode[mode], JSON.parse(localStorage))` 得到（`GenerationUI.tsx:294-295` + `utils.ts:141-161`），提交时 `output_format` **原样透传**（`utils.ts:759`）。而 `OutputPanel` 的选项只来自 `output_formats_by_mode`，`value={outputFormat || "png"}` 也不做收敛。
- 问题：本地持久化按 **mode** 而不是按内核存（`localStorage["sdcpp:params:"+mode]`）。从「编译了 WebP 的内核」切到「没有 WebP 的内核」后，`webp` 仍是持久值 → 服务端 `assign_output_options` 直接拒绝，返回 `{"error":"invalid output_format, must be one of [png, jpeg]"}`（`runtime.cpp:107-121`），**每一次提交都失败**，而 UI 下拉里根本没有 `webp` 这一项、当前值还显示成占位符，用户完全看不出原因。`vid_gen` 侧更宽（`webm`/`webp`/`avi` 取决于编译开关，`runtime.cpp:126-157`）。
- 上游依据：`runtime.cpp:99-157`；上游 webui 有显式收敛动作（`App.vue:246-247`：`if (!validFormats.includes(form.output_format)) form.output_format = defaultOutputFormatForMode(mode)`）。
- 建议：在 `GenerationUI` 的「caps 就绪 / mode 切换」effect 里加一行与 webui 同款的收敛；或在 `buildRequestBody` 里接受 `outputFormats` 参数并回落第一个合法值。
- **附带（P3）缺省漂移**：`utils.ts:790` 写 `fps: params.fps || 24`，而上游 `SDGenerationParams::fps` 缺省是 **16**（`common.h:249`）、上游 webui 也用 16（`form-request.ts:161`、`form-capabilities.ts:47`）。当 `params.fps` 缺失/为 0（旧持久化、家族未给默认）时，Lumina 会把 24 强加给内核，做出与「按内核默认」不同的视频。`video_frames || 33` 则与上游 webui 一致。

### 2.7 陈旧的 sampler/scheduler 值被保留并发送，服务端静默忽略

- 级别：**P2**
- 位置：`src/components/generation/panels/SamplingPanel.tsx:64-69`、`:76-81`；`src/lib/utils.ts:735-739`
- 现状：caps 里没有当前值时，**刻意把当前值补进选项**：
  ```ts
  if (sampleMethod && sampleMethod !== "default" && !samplers.includes(sampleMethod)) {
    samplerOptions.push({ value: sampleMethod, label: SAMPLER_NAMES[sampleMethod] || sampleMethod });
  }
  ```
- 问题：这个「保留以便往返」的善意，配上上游「未知枚举静默忽略」（`common.cpp:2224-2235`：`str_to_sample_method` 不认识就 `if (tmp != SAMPLE_METHOD_COUNT)` 不写入）就变成**静默错配**：界面显示 `dpmpp_2m`，内核用的是模型默认采样器，出图结果与用户认知不符且无任何提示。`scheduler` 同理。这类问题在「换内核版本（采样器被改名/移除）」「家族预设写了个老名字」时出现。
- 上游依据：`common.cpp:2224-2235`、`runtime.cpp` 无校验；上游 webui 的 `preview_modes` 走相反策略（缺键就退回全量 `App.vue:96`），但 sampler 列表它只做 `capabilities.samplers || ["default"]`（`App.vue:86-87`），即**不存在陈旧值**（换服务端会重建表单）。
- 建议：保留选项但加可见标记（如「（当前内核不支持）」）并阻止提交；或提交时在 `buildRequestBody` 里与 `caps.samplers` 交集，取不到就省略该键并在 UI 提示「已回退到内核默认」。`preview` 已经有正确做法可参照（`utils.ts:696-701` 的 `resolvePreviewMode`，不在枚举内即回落 `none`）。

### 2.8 上游 job 的 `queue_position` / `started` / `completed` 完全未被使用

- 级别：**P2**
- 位置：`src/types.ts:453-472`（`Job` 接口缺这三个字段）；`src/components/generation/JobQueue.tsx:51-59`、`:114-117`
- 现状：`Job` 只声明 `id/kind/status/created/result/error/preview/prompt/config/pollFailures/lastPollSuccess`；耗时用 `created`（秒，入队时刻）+ 客户端 `lastPollSuccess`（毫秒，最近一次成功轮询）估算，全程 grep 不到 `queue_position`。
- 问题：两个真实损失。(a) **队列位置**：上游 `queue_position` 是 1 起的真实排队序号（`async_jobs.cpp:167-176`），Lumina 只能显示「N / maxQueue」个总数（`JobQueue.tsx:87-89`），用户在长队列里不知道还要等几个。(b) **真实生成耗时**：`started`/`completed` 都是内核时间戳（`async_jobs.cpp:163-164`、`378`、`408`），而 Lumina 的 `elapsed` 混入了排队等待与轮询抖动（2 s 间隔，`useJobPolling.ts:137`），同一任务显示的时间可能比实际采样时间多几十秒；在「删除任务后继续轮询」的 detached 路径（`useJobPolling.ts:311-343`，3 s 间隔）抖动更大。`created` 的秒级精度也意味着 1 s 粒度的误差无法消除。
- 上游依据：`async_jobs.cpp:157-176`；`api.md:421-434`（字段类型表）、`api.md:415`（`queue_position` 示例值 2）。
- 建议：`Job` 补三个可选字段（纯增量，不动现有逻辑），`JobQueue` 在 `status === "queued"` 时显示 `#queue_position`，终态耗时改用 `completed - started`（秒，缺任一端时退回现算法）。改动仅 `types.ts` + `JobQueue.tsx`。

### 2.9 视频 VAE 时间维分块（`temporal_tiling` / `extra_tiling_args`）无任何 UI

- 级别：**P2**
- 位置：`src/types.ts:239-251`（类型齐全）；UI 侧 grep 不到任何写入点（`src/components/generation/panels/AdvancedSamplingPanel.tsx` 只覆盖空间维 `tile_size_w/h`、`rel_size_*`）
- 现状：`VaeTilingParams` 完整声明了 `temporal_tiling` 与 `extra_tiling_args`，`resolveVaeTilingForProtocol`（`utils.ts:530-542`）也会原样发送；但没有任何控件/家族预设会设置它们，默认值来自 caps（`temporal_tiling:false`、`extra_tiling_args:""`），所以这两个字段**永远是关闭/空串**。
- 问题：长视频（`video_frames` 大）解码 OOM 的主要缓解手段就是时间维分块。上游文档明确给了两个键：`temporal_tile_frames`（别名 `temporal_tile_size`，默认 4）与 `temporal_tile_overlap`（默认 1），并说明 LTX/Wan 会保留跨块因果状态、Hunyuan/TAEHV 用重叠混合（`api.md:576-579`）。目前 Lumina 用户只能靠手改 localStorage 才能碰到。
- 上游依据：`api.md:560-568`（字段表已含 `temporal_tiling`）、`api.md:578-579`（`extra_tiling_args` 支持键）。
- 建议：在 `AdvancedSamplingPanel` 的 VAE 分块段加一个「视频时间维分块」开关（仅 `mode === "vid_gen"` 时显示）+ 两个数字框写入 `extra_tiling_args`（`temporal_tile_frames=4,temporal_tile_overlap=1`）。改动：`AdvancedSamplingPanel.tsx` 单文件 + `VaeTilingParams` 已有字段。
- 与 ux-a11y 组的「请求体已接但 UI 无控件」清单合并说明：他们列的 `vace_strength`/`shifted_timestep`/`cache_option`/`scm_mask`/SLG 细项/高噪 `img_cfg` 属于**协议侧已正确发送、缺的是控件**（我核对了发送路径，均已对齐上游解析器）；本节 `temporal_tiling`/`extra_tiling_args` 是同一类，但影响面不同——前一组缺控件只是「少调一个参数」，时间维分块缺失直接堵住长视频降内存路径。

### 2.10 `embed_image_metadata` 在 img_gen 恒为 true、在 vid_gen 完全不可控

- 级别：**P3**
- 位置：`src/lib/utils.ts:786`（仅 img_gen 分支）、`:788-793`（vid_gen 分支无此项）；grep 全仓无任何控件写 `embed_image_metadata`
- 问题：`from_json_str` 是全局读该键（`common.cpp:2166`），且 vid_gen 侧真的会用它决定是否往容器里写参数（`async_jobs.cpp:303-305`）。所以 (a) 用户无法关闭图片元数据（隐私场景：不想把 prompt 嵌进 PNG）；(b) 视频侧的元数据开关不可见——而它决定了「保存下来的视频能不能在历史画廊里恢复参数」（`png_info.rs:203-231` 只对 png/webp 解析）。注意 `capabilities.defaults_by_mode` 的 img_gen 默认里**没有** `embed_image_metadata`（`routes_sdcpp.cpp:140-166` 未列出），因此该值只能由客户端决定，Lumina 选择恒 true。
- 上游依据：`common.cpp:2166`、`async_jobs.cpp:269-273`（img）、`303-305`（vid）。
- 建议：`OutputPanel` 加一个「写入 PNG 元数据」开关（img_gen 才有），并在 vid_gen 时把它也发出去（上游解析器接受，只是文档未列）。低优先级，但隐私相关的开关值得给。

### 2.11 能力探测策略评估：三组合下的失效模式

Lumina 的策略是**三合一**：(1) `cli.rs` 用 `--help` 解析可用启动参数（`cli.rs:290-320`，`--version` 只用于显示：`cli.rs:304-311`、`CliCompatibility.tsx:58`，**从不参与任何门控**，这点是对的）；(2) HTTP `capabilities` 决定运行时能力；(3) `config/families.ts` 的家族预设 + `applyFamilyFeatureLimits`/`exclusiveInputConflicts`（`launchConfig.ts:337-341`、`392-408`）兜住「协议说支持但模型不支持」的空白。上游 webui 只有 (2)，且是纯乐观式：`preview_modes` 缺键时退回全量（`App.vue:96`），图片输入是**写死的静态清单**（`image-inputs.ts:3-22`，与模型完全无关）。

| 组合 | Lumina 现状 | 失效模式 / 严重度 | 上游 webui 对照 |
|---|---|---|---|
| **旧内核 + 新界面** | `preview` 缺 `preview_modes` → 关闭（`utils.ts:686-693`，保守，正确）；`upscale` 缺键 → 入口不可见（`GenerationUI.tsx:470-476`，正确）；`vae_tiling` 键名嗅探选协议（`utils.ts:431-447`，全仓最稳的一处）；**但** `defaults_by_mode` 缺失 → 白屏（§2.4），`features.*` 缺失 → 面板隐藏但字段照发（§2.5） | **P1**（白屏）+ **P2**（隐形生效） | `defaults_by_mode` 缺失时 `defaults={}` → 表单全默认值但可用（`form-capabilities.ts:34-35`）；`preview_modes` 缺失反而全开（可能发出内核不认识的 preview，被静默忽略） |
| **新内核 + 旧界面** | 新增**字段**（如 #2093 的 `preview`）不发送 → 功能缺省关闭，**不破坏**；新增**枚举值**（sampler/scheduler/output_format/preview_modes）由 caps 数组渲染，标签回落原名（`SamplingPanel.tsx:60-63`、`families.ts:56-61`），可用；新增**键值**在 `defaults_by_mode` 里会被 `deepMerge` 带进请求体，旧解析器静默忽略，无害 | 主要风险是**新的 mode 名**：`GenMode` 是封闭联合（`types.ts:123`），而 `api.md:463` 的措辞是「such as `img_gen` or `vid_gen`」——一旦上游新增第三种 mode，`App.tsx:100` 的 `setMode(c.current_mode)` 会写入一个 union 外的值，随后 `defaults_by_mode[新mode]` 为空 → 又落到 §2.4 的白屏路径。**P2（前瞻性）** | 同（`current_mode` 也是裸字符串，同样会空表） |
| **非官方魔改内核** | 最脆弱的一类：`from_json_str` 的「未知键静默忽略 + 类型不符静默跳过」（`common.cpp:2110-2136`）意味着 Lumina 发出的任何字段都可能变成空操作而无从发现；`features` 缺失 → §2.5；`defaults_by_mode` 裁剪 → §2.4；`loras[].path` 若不是「相对 `--lora-model-dir`」的形态，会被 `get_lora_full_path` 判空 → 整个提交 400（`runtime.cpp:316-321` + `common.cpp:2005-2008`）；Rust 侧还会按本地目录**改写 loras 列表**（`lib.rs:571-595`），若内核的 `--lora-model-dir` 不在 `model_dir` 下、而 `model_dir` 又恰好有 `loras/` 子目录，面板会把真正可用的 LoRA 全部过滤掉 | **P2**（三处叠加后「设置无效/列表为空/提交失败」都无解释） | 无过滤、无家族层，遇到魔改内核基本只是「发出去被忽略」 |

结论：**Lumina 的混合策略在方向上优于上游 webui**（webui 的 `features_by_mode` 实际是硬编码常量 `routes_sdcpp.cpp:195-225`，靠它判模型能力是幻觉；Lumina 用家族层补齐了这块，且 `vae_tiling` 的键名嗅探是真正意义上的「协议探测」）。真正需要补的是**降级基线**：现有实现把「新内核的完整形状」当唯一合法输入，缺键时没有一条统一的 fallback 链（三个候选来源：`defaults_by_mode[mode]` → `defaults` 兼容镜像 → 家族预设），并且在缺键时没有把「能力未知」告诉用户。

### 2.12 独立放大接口（`POST /sdcpp/v1/upscale`）：实现正确，两处可改进

- 级别：**P3**（现状无错，属打磨）
- 位置：`src/components/generation/GenerationUI.tsx:492-556`、`UpscaleDialog.tsx:173-192`；`src-tauri/src/sdcpp.rs:184-195`（600 s 专用超时）、`27`
- 已核对正确的点：① `tile_size` 只在 `> 0` 时发送（`GenerationUI.tsx:509`），因此「0 = 用内核 `--upscale-tile-size`」的说法成立——上游是 `std::max(32, body.value("tile_size", default))`（`routes_sdcpp.cpp:518`），**显式发 0 会被夹到 32**，省略才是内核默认；② `repeats` 由 UI 限定 1-4（`UpscaleDialog.tsx:36-39`），与服务端夹取一致（`routes_sdcpp.cpp:519`）；③ 输出格式只列 `png/jpeg/webp` 并与 caps 求交（`UpscaleDialog.tsx:84-90`）；④ 入口双门控 `caps.upscale === true && image_upscale 模型存在`（`GenerationUI.tsx:472-476`），与 `routes_sdcpp.cpp:408` + `:542` 的语义一致；⑤ 8192 上限来自 caps（`GenerationUI.tsx:1258-1259`）而非硬编码；⑥ 同步阻塞 + 不可取消已被 UI 文案与 `upscaleBusy` 锁覆盖（`GenerationUI.tsx:496-501`、`UpscaleDialog.tsx:193-197`）。
- 可改进：① **没有超时反馈**：`reqwest` 侧给了 600 s（`sdcpp.rs:27`），而该请求还要排在生成的任务锁后面（`routes_sdcpp.cpp:568` 注释「One GPU」），一次「生成中 + 4× 放大 8K」可以让模态框静默等十分钟以上，界面上只有一句静态文案；建议按 `upscaler`+源图尺寸给一个粗估下界，或至少在等待期间显示已用时长。② **倍率不可预知**：上游 `capabilities.upscalers[]` 只有 `name/model/image_upscale`（`routes_sdcpp.cpp:322-327`、`api.md:514-518`），**没有倍率**；而 `/sdapi/v1/upscalers` 是有的（`routes_sdapi.cpp:521-529` 的 `scale` 字段）。所以 Lumina 无法在点「开始放大」之前告诉用户输出尺寸、也无法预判会不会撞 8192 上限（`UpscaleDialog.tsx:189-192` 只能给固定文案）。若愿意为此接一次 sdapi 面，这是**唯一**值得考虑接另一套 API 的理由（见 §2.14）。

### 2.13 f0aac52 之后 3 个提交的复核：不要求任何界面改动

`git diff --stat f0aac52..HEAD` 的完整文件清单：

```
 README.md                  |  1 +
 docs/moss_image.md         |  3 ++
 src/model/adapter/lora.hpp | 43 ++++++++-
 src/model_loader.h         |  2 ++
 src/model_loader_files.cpp | 18 +++++
 src/model_manager.cpp      | 73 +++++++++++++-----
 src/name_conversion.cpp    | 32 +++++++++
```

**`examples/server/**` 与 `examples/common/**` 一行未改**，即 `/sdcpp/v1` 的请求/响应/capabilities/错误体**零变化**。

| 提交 | 实质改动 | 是否需要 UI/协议改动 |
|---|---|---|
| `95b3090` MOSS 拆分 QKV + host 侧批量加载（#2160） | `name_conversion.cpp` 新增 `convert_moss_image_dit_name()`（`.proj.q/k/v.weight` → 合并的 `qkv`）；`model_manager.cpp`/`model_loader_files.cpp` 加批量加载；`docs/moss_image.md` 新增官方 **GGUF** 下载链接（Base/SFT） | **否**。协议面无关。唯一值得转给 cli-families 组确认的点：MOSS 现在有 `.gguf` 分发形态，而 Lumina 的 MOSS 识别是文件名关键字匹配（`family.rs:152`、`:444-446`，覆盖 `moss-image`/`moss_image`/`mossimage`），对 `moss-image-base-Q4_K_M.gguf` 这类命名**看起来仍然命中**，但该家族的「必需组件」校验是否只认 safetensors 目录布局需要他们核一下 |
| `ab8d5ea` Diffusers 格式 MiniMax-H3 LoRA（#2159） | `lora.hpp`：新增读取 safetensors 元数据里的 **`alpha`**，`scale_value = alpha/rank`（原先恒 1.0，仅当存在 per-tensor `scale` 时才覆盖）；MiniMax-H3 的 SwiGLU `lora_up` 做 `[value,gate]`→`[gate,value]` 半块交换；`name_conversion.cpp` 新增 `convert_diffusers_dit_to_original_minimax_h3()` | **否**（请求体 `lora[].{path,multiplier,is_high_noise}` 语义未变）。两点提示：(a) 该提交**改变了带 `alpha` 元数据的 LoRA 的实际强度**，同一 LoRA「升级内核前后出图不同」，属预期行为但会在 issue 里被当成 bug；(b) `alpha` 解析失败会 `return false` 直接判该 LoRA 加载失败（`lora.hpp` 新增分支），客户端只会看到「LoRA 没生效」——Lumina 目前对 LoRA 未生效没有任何可见反馈（见 §2.7 同类问题） |
| `d55cc0f` docs | 只改 `docs/moss_image.md` 的下载链接 | **否** |

结论：**README 声明对齐 `f0aac52` 仍然成立**，三个提交不需要界面跟进；建议只是把 README 的对齐提交号更新为 `d55cc0f` 并说明「报文面自 f0aac52 未变」。

### 2.14 另两套 API（`/sdapi/v1`、`/v1`）的可用性评估：不建议接入

逐一比对后，结论是**不接**，理由均为「sdcpp 面已有等价物或更强」：

| 另一套 API 的能力 | sdcpp 面对应 | 结论 |
|---|---|---|
| `POST /sdapi/v1/txt2img`、`/img2img`（`routes_sdapi.cpp:476-482`） | `/sdcpp/v1/img_gen`（异步 + 参数更全） | sdapi 是**同步**的，接了等于退化成阻塞调用；且其字段是 A1111 命名，需要一层反翻译 |
| `GET /sdapi/v1/{loras,samplers,schedulers,sd-models,options}`（`:484-603`） | `capabilities` 的 `loras/samplers/schedulers/model` | 全冗余。`/sdapi/v1/options` 只回 `samples_format` 与 `sd_model_checkpoint`（`:597-603`），无信息量 |
| `GET /sdapi/v1/progress`（`:605+`） | 每任务的 `preview` + `queue_position` | sdapi 的**全局** `job_count`/`job_no`/`eta_relative`（`:632-645`）确实 sdcpp 没有，但它是「本进程最近一个任务」的全局量，多客户端/多任务时会串；Lumina 的按 job 轮询更适合自己（且 §2.8 补上 `queue_position` 后就够了） |
| `GET /sdapi/v1/upscalers` 的 **`scale`**（`:521-529`） | `capabilities.upscalers[]` **无倍率** | **唯一有真实价值的差异**（§2.12）。但为它接一整套 API 不划算；更小的做法是本地估算（源图尺寸 × 已知 ESRGAN 通常是 ×4）或用 `/v1/models` 那种轻量探测方式单点取一次 |
| `POST /v1/images/generations`、`/v1/images/edits`（`routes_openai.cpp:260`、`:334`） | 同上 | OpenAI 形状没有 Lumina 需要的信息；`/v1/images/edits` 是 multipart，解析成本更高 |
| `GET /v1/models`（`routes_openai.cpp:253-256`，`id: "sd-cpp-local"`） | `capabilities` | Lumina **已经在用它做心跳**（`sdcpp.rs:44-56`、`:86-97`），且比 `capabilities` 便宜得多（后者每次都触发 LoRA 全量递归扫描，见 `sdcpp.rs:44-47` 的注释与 `runtime.cpp:254-314`）——这处已对齐得很好，值得保留 |

反向检查「sdcpp 面缺而 sdapi 面有」的字段：只有上表的 `upscalers[].scale` 一项。反向检查「sdapi 面缺而 sdcpp 面有」：`preview`、异步 job、`vae_tiling_params`、`hires`、`image_preprocess`、`ref_image_args`、`lora.is_high_noise`、`cache_*` 全在 sdcpp 面，说明当初选 `/sdcpp/v1` 做主通道是对的。

## 3. 待验证假设（无充分证据，未混入上方结论）

1. **上游引入各 capabilities 键的确切版本无法确认**：审计用的克隆是 **shallow**（`git rev-list --count HEAD` = 60，最老提交就是 `4c3cf75`，#2058 2026-09-25），所有 `git log -S` 都触底到该边界。因此 §2.11 里「旧内核」的具体时间点无法给出；本报告的结论只依赖**当前 HEAD 的形状**与「缺键即不满足」这一代码事实，不依赖版本考古。
2. **PNG 元数据 64 KiB 截断**：`stb_image_write.h:1533` 把 tEXt 长度夹在 `0xFFFF`。若 prompt+negative+完整 SDCPP JSON 超过约 64 KB（超长 prompt 用户的现实场景），元数据会被截断、`extract_sdcpp_metadata`（`png_info.rs:26-30`）解析失败 → 历史画廊「恢复参数」静默无反应。未构造 64 KB prompt 实测，列为待验证。
3. **`scm_policy_dynamic` 是上游文档错还是实现漏**：`api.md:821`、`:957`、`:1180` 三处把它列为请求字段，但 `from_json_str` 不解析（`common.cpp:2144-2147`），真正的开关只有启动参数 `--scm-policy`（Lumina 的注释 `utils.ts:870-873` 已如此判断，与实现一致）。若上游日后补上解析，Lumina 需要重新开启该字段的发送。建议 Lead 把这条作为「已知上游文档缺陷」上报，不必改代码。
4. **`ad_model`/`ad_prompt`/`extra_ad_args` 在 HTTP 路径上是死键**：`from_json_str:2140-2143` 会解析它们，但 `to_sd_img_gen_params_t()`（`common.cpp:2713+`）从不使用 `ad_model_path`（全文件 grep 只有 2140/2692/2950/3092/3256 出现），ADetailer 只能通过 `-M adetailer` 的 CLI 模式跑。因此「Lumina 没暴露 ADetailer」**不是缺口**；但它是「会被静默接受的空键」的又一例证，支持 §2.7 的风险判断。未实测通过 `/sdcpp/v1/img_gen` 带 `ad_model` 是否真的无效果，列为待验证。
5. **PhotoMaker / PuLID / `ref_video*` / `ref_audio*` / `circular*` 完全无 HTTP 通路**：`SDGenerationParams` 里有这些字段（`common.h:257-269`）、也进入 `sd_img_gen_params_t`（`common.cpp:2749-2758`），但 `from_json_str` 不解析其中任何一个。即**上游从头就没打算让它们走 HTTP**，Lumina 只能在 CLI 启动时用；这类功能若用户询问「GUI 里为什么没有」，正确回答是「上游协议不支持」而非「Lumina 缺功能」。是否已写进 README「已知限制」需 Lead 与文档组核对（我未逐行核 README）。**与 cli-families 组结论一致**：他们独立核出 `examples/server/**` 对 PuLID/PhotoMaker 零引用、`include/stable-diffusion.h:416-417` 只是生成级参数——即这两项是「CLI 启动期可设、请求期不可设」，两条路径互不冲突。
6. **`limits.max_width/max_height` 服务端并不校验**：`validate()`（`common.cpp:2581-2698`）里没有任何 width/height 范围检查，`routes_sdcpp.cpp:390-399` 只是把常量广播出去。Lumina 用输入框 `min/max` 夹取（`SizeSeedPanel.tsx:123-140`），但 `alignSizeUp` 之后的实际提交值没有二次夹取（`GenerationUI.tsx:395-396`）；极端情况下（家族对齐基数大 + 上限附近）是否会超出 4096 未构造用例验证。
7. **`preview` 的性能代价没有量化**：`preview != none` 时每一步都会 PNG 编码 + base64（`async_jobs.cpp:13-40`），`preview_interval` 默认 1。Lumina 默认关闭（`preview` 缺省 `"none"`，`utils.ts:880` 恒发），这点是安全的；但 UI 文案「可能增加耗时」（`SamplingPanel.tsx:206-208`）的具体量级未测。

## 4. 与其它组可能重叠的点（Lead 合并用）

| 重叠点 | 我的结论（协议侧） | 建议归属 |
|---|---|---|
| `features.*` 门控极性不一致（§2.5） | 显示侧在 `GenerationParamsSheet`，提交侧在 `GenerationUI`；同一根因，建议由**一组**统一改 | frontend-arch 主，api-alignment 提供判定表 |
| capabilities 缺 `defaults_by_mode` → 白屏（§2.4） | 根因是「无降级链」，落在 `GenerationUI.tsx` + `App.tsx`；我给的 fallback 链需要 `familyDefaults`（`launchConfig.ts:213`） | frontend-arch 主 |
| animated WebP / AVI 不可播（§2.2） | 涉及 `ResultsGrid`、`Lightbox`、`useBlobUrlCache`；本质是「按 mime 选渲染器」的一次重构 | frontend-arch 主（我给上游 webui 的参考实现位置） |
| `Job` 缺 `queue_position`/`started`/`completed`（§2.8） | `types.ts` 增量 + `JobQueue` 展示 | frontend-arch / ux-a11y |
| Rust 侧改写 capabilities 的 `loras` 列表（`lib.rs:571-595`） | 协议层看这是「代理层修改响应体」，对魔改内核可造成 LoRA 面板空表；属后端行为 | backend-rust 主 |
| `--hires-upscalers-dir` 被设成 `modelDir`（`launchConfig.ts:148`） | 决定独立放大是否可用（也决定 `upscalers[]` 会扫到大量非 ESRGAN 模型）；参数取舍属 CLI 组 | cli-families 主 |
| `fps` 缺省 24 vs 上游 16（§2.6 附带） | 若家族预设都显式给了 fps 则影响面很小；需 cli-families 确认 `families.ts` 的视频家族覆盖度 | cli-families 主，我保留协议侧证据 |
| MOSS 的 GGUF 分发形态（§2.13） | `family.rs:152` 关键字匹配看似仍命中，但组件/布局校验未核 | cli-families 主 |
| **`/sdcpp/v1/upscale` 无可取消、无进度**（§2.12） | 属产品层面的取舍（README 可能已述），我只确认协议侧无法取消 | ux-a11y / 由 Lead 判定是否为「已知限制」 |
| 无 CI/lint → 「未知键静默忽略」这类协议漂移无法被测试捕获 | 建议加一条**契约快照测试**：用固定 caps 夹具跑 `buildRequestBody`，断言请求键集合与上游 `from_json_str` 的键集合一致（本仓库 `src/lib/__tests__/utils.test.ts` 已有类似结构，但夹具用的假 caps 与真实形状不符，正是 §2.3 的漏网原因） | build-test 主，我给键清单 |
