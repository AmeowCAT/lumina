# CLI 启动参数覆盖 与 模型家族数据对齐 审查报告

> 审查对象：`D:\Project\AmeowCAT\lumina` @ `d442371`（v0.8.6）
> 上游对照：`stable-diffusion.cpp` @ `d55cc0f`（本仓库 README 声明对齐 `f0aac52`）
> 审查人：cli-families 组。只做静态阅读，未运行 `npm` / `cargo`，未改动任何源码。

## 0. 结论摘要

1. **P1**：`--pulid-weights` / `--photo-maker` 在 sd-server 面上是**死组件**——权重能加载，身份条件永远不生效，且没有任何报错；同时这两个组件位挂在了**上游不支持它们的家族**上（Flux-only 的 PuLID 挂在 SD/SDXL，SDXL-only 的 PhotoMaker 也挂在 SD）。
2. **P1**：`distilled-sd` 的默认 `1 步 / CFG 1 / 512×512` 只对 SDXS 成立；对同族的 SSD-1B / Vega / tiny-SD 会直接出糊图，而上游文档明确这几类是 out-of-the-box 的常规蒸馏模型。
3. **P2**：`mage-flow`（Base）默认 20 步，与自身 `hint`（“Base 模型建议 30 步”）、文件头注释（“Base / Edit 版 30 步”）和上游 `docs/mage_flow.md`（30 steps）三处矛盾。
4. **P2**：真正“无法通过任何途径设置”的启动参数只有 `--listen-ip` / `--listen-port`（被 `build_args` 硬拒，属有意设计），其余 152 个长期参数都能经「附加启动参数」透传；另有 16 个是 sd-cli 专属、对 sd-server 不适用。
5. **P2**：约 20 个有实际意义的启动参数只能靠手写「附加启动参数」，其中包括 PuLID/PhotoMaker 的**全部**身份参数，用户实际上无法在不重启内核的前提下换 ID。
6. **P2**：`family.rs` 用裸子串匹配，误判面明确：`anima` ⊂ `animation`、`wan` ⊂ `wand/swan/taiwan`、`lens` ⊂ `lenses`；且 `flux-1-dev` 这一常见写法**没有任何规则命中**，会静默落到 `custom`。
7. **P2**：README 声称「58 个家族」，代码实际 60 个（+ 自定义）；漏掉的是 `llada-image(-turbo)` 与 `sensenova-u1`——恰好是两个启动条件最特殊的家族。
8. **P3**：`--threads`、`--mmap`、`--eager-load`、`--split-mode`、`--params-backend`、`--rpc-servers` 等无控件；`--rpc-servers` 对多机用户是硬需求。
9. **P3**：`families.ts` 缩进 1 tab / 2 tab 混用（941–1017 行整块 2 tab），仓库无格式化配置。
10. **家族数据总体质量高**：抽样 12 个家族（含全部最新家族）逐项核对上游 docs，除上述 3 条外组件/默认值/对齐/禁用特性均一致；「58 家族」全部可用，无占位家族。

## 1. 审查范围与方法

**上游参数面机械抽取**

| 来源 | 数量 | 说明 |
|---|---|---|
| `examples/common/common.cpp` 长选项字面量 | **156** 个 `--*` | 用正则扫全部 `"(--[A-Za-z0-9_-]+)"` 字面量，覆盖 `ArgOptions` 手工表 + `manual_options.push_back` |
| `examples/server/runtime.cpp` | 5 个 | `--listen-ip` / `--listen-port` / `--serve-html-path` / `--color` / `--help`（`runtime.cpp:193-212`） |
| `examples/cli/main.cpp` | 21 个 | sd-cli 专属（`--mode`、`--output`、`--imat-in/out` 等，`cli/main.cpp:67-209`） |

**Lumina 侧机械抽取**：`families.ts` 的 `F(key,label,arg,cat,...)` 第 3 参（arg，共 250 处调用、18 种参数名）、第 4 参（cat，共 15 种取值）、`fixedArgs`（62 处，只有 `flash-attn` 与 `rng`）、`launchConfig.ts`、`diagnostics.ts`、`cli.rs`、`server.rs::build_args` / `PATH_VALUE_ARGS`。

**家族抽样（12 个，全部核对上游 docs + 上游代码）**：`flux3-klein` / `flux3-klein-base`、`moss-image`、`iris`、`llada-image` + `llada-image-turbo`、`sensenova-u1`、`qwen-image-2.1`、`minimax-h3-fl2va` + `minimax-h3-ref2va`、`ltx25`、`hunyuan-video`、`zimage-l2p`、`ideogram`、`wan-a14b`、`distilled-sd`、`minit2i`、`ming-image`、`mage-flow`×4、`sdxl`/`sd`（特殊组件）、`pid`、`pixart-*`（实际 20 个，超出要求）。

---

## 2. 问题清单

### 2.1 PuLID / PhotoMaker 在 sd-server 面上是死组件，且挂错家族

- **级别：P1**
- **位置**：`src/config/families.ts:641`、`src/config/families.ts:684`（pulid）；`src/config/families.ts:640`、`src/config/families.ts:683`（photo-maker）
- **现状**：

  ```ts
  // families.ts:639-641（sdxl）
  F("control-net", "ControlNet (可选)", "control-net", "control_net"),
  F("photo-maker", "PhotoMaker (可选)", "photo-maker", "photo_maker"),
  F("pulid-weights", "PuLID (可选)", "pulid-weights", "pulid"),
  ```

  ```ts
  // families.ts:683-684（sd）
  F("photo-maker", "PhotoMaker (可选)", "photo-maker", "photo_maker"),
  F("pulid-weights", "PuLID (可选)", "pulid-weights", "pulid"),
  ```

- **问题**：三层错误叠加。

  1. **PuLID 只支持 Flux 架构**。上游 `src/extensions/pulid_extension.cpp:110-118`：

     ```cpp
     void before_diffusion(DiffusionParams& params, int /*step*/) const {
         if (!enabled || id_embedding.empty()) return;
         if (auto* flux_extra = std::get_if<FluxDiffusionExtra>(&params.extra)) { ... }
     }
     ```

     只在 `FluxDiffusionExtra` 分支注入 → SD/SDXL 上永远不生效。`docs/pulid.md` 首段也写明 “on top of Flux.1 (schnell or dev) models”。而 `families.ts` **恰恰只在 sd / sdxl 上提供该组件位，`flux` / `kontext` 家族没有**（`families.ts:424-429`、`442-451` 的 fields 仅 diffusion-model/vae/clip_l/t5xxl）。**方向完全反了**。

  2. **PhotoMaker 只支持 SDXL**（`docs/photo_maker.md`：“currently PhotoMaker **ONLY** works with **SDXL**”），却同时挂给 `sd`。

  3. 即使家族对了，在 sd-server 下也永远不生效：身份参数是**单次生成参数**而非上下文参数——`include/stable-diffusion.h:416-417` 把 `pm_params` / `pulid_params` 放在 `sd_img_gen_params_t` 里；`examples/server/` 全部源码对 `pulid` / `pm_` **零引用**（对 `examples/server/*.cpp` grep `pulid|pm_id|photo_maker` 无任何命中），`src/stable-diffusion.cpp:531` 每个请求都把 `pulid_params` 重置为 `{nullptr, 1.0f}`。PuLID 缺 `id_embedding_path` → `id_embedding.empty()` 直接 return；PhotoMaker 缺 ID 图 → `src/extensions/photomaker_extension.cpp:216-218` 打一条 WARN（`"Provided PhotoMaker model file, but NO input ID images"` / `"Turn off PhotoMaker for this request"`）后关闭自己。

  **对用户的后果**：用户看到「PuLID (可选)」「PhotoMaker (可选)」两个下拉，选了权重、检查单全绿、启动成功、出图——出来的就是普通 SD 图，人脸不走样、身份不注入，且**日志里只有一条容易被忽略的 WARN**（PuLID 连 WARN 都没有）。这是“宣称支持但永不生效”，比缺功能更难排查。

- **上游/对照依据**：`docs/pulid.md`、`docs/photo_maker.md`、`src/extensions/pulid_extension.cpp:90-118`、`src/extensions/photomaker_extension.cpp:216-218`、`include/stable-diffusion.h:221-222`（ctx 级权重路径）vs `:317-322`（生成级 ID 参数）、`examples/server/**` 无引用。
- **建议（最小改动）**：
  - 二选一：**(a) 移除** `sd`/`sdxl` 上的 `photo-maker`、`pulid-weights` 组件位，并在 `README 已知限制` 增加一条「PuLID / PhotoMaker 依赖单次生成参数，sd-server 的 HTTP 协议未开放，界面不提供」（与 ADetailer 同款处理，见 README:118）；**(b) 保留但降级**为「权重位 + 明确 NO-GO 提示」：在 `FamilyConfig` 里给这两个字段加 `unsupportedReason`，`buildLaunchConfig` 命中时把原因塞进 `missing`（复用现有 `unsupported` 机制，`families.ts:219-224`），让检查单直接 NO-GO 而不是静默无效。
  - 若将来上游在 `/sdcpp/v1` 开放 `pulid_id_embedding` / `pm_id_images`，再把 `pulid-weights` 移到 `flux` / `kontext`。改动文件：`src/config/families.ts`、`src/lib/launchConfig.ts`、`README.md`。

### 2.2 `distilled-sd` 默认 1 步 / CFG 1 / 512×512 对 SSD-1B、Vega、tiny-SD 是错误的

- **级别：P1**
- **位置**：`src/config/families.ts:1846-1857`
- **现状**：

  ```ts
  "distilled-sd": {
      name: "Distilled SD",
      hint: "SSD-1B / SDXS / 蒸馏模型",
      mode: "img",
      fields: [F("model", "完整模型", "model", "model")],
      genDefaults: { seed: -1, width: 512, height: 512,
          sample_params: { sample_steps: 1, guidance: { txt_cfg: 1 } } },
  },
  ```

- **问题**：`1 步 / CFG 1` 是 **SDXS 专属**且“mandatory”的参数组合（`docs/distilled_sd.md`：“Both options `--cfg-scale 1` and `--steps 1` are mandatory here”，指 SDXS-512-DreamShaper / SDXS-512-0.9）。同一文档明确说 SSD-1B 与 Vega “can be used out-of-the-box, unlike the models described in next sections”——它们是**常规蒸馏 SDXL**，仍需要 CFG 与二三十步；且 SDXL 架构的默认分辨率是 1024，不是 512。由于 `detect_family` 把 `ssd-1b` / `bk-sdm` / `sdxs` 三类全部映射到 `distilled-sd`（`family.rs:350-351`），**SSD-1B / tiny-SD 用户一进生成页就被填上 1 步 / CFG 1 / 512²**，出来的是噪点或糊图，且不会有任何报错。这是“明显错误的生成结果”，符合简报 P0 的一半条件，但用户可手动改回，故定 P1。
- **上游/对照依据**：`docs/distilled_sd.md`（SDXS 段 vs SSD-1B/Vega 段）。
- **建议**：拆两族或按名字分档最稳妥；最小改动是在 `genDefaults` 里改为中性值（`steps: 20, cfg: 7, 1024×1024`）并在 `hint`/`generationHint` 里写明「SDXS 系列必须手动改成 1 步 + CFG 1」。改动文件：`src/config/families.ts`（必要时加 `detect_family` 分支，`src-tauri/src/family.rs:350-351`）。

### 2.3 `mage-flow`（Base）默认步数与自身说明、上游文档三方矛盾

- **级别：P2**
- **位置**：`src/config/families.ts:1258-1280`
- **现状**：

  ```ts
  // 1258-1259
  // Mage-Flow 默认参数来自官方模型卡（microsoft/Mage-Flow）：非 Turbo cfg 5.0，
  // Turbo 4 步 / cfg 1.0；RL 版 20 步、Base / Edit 版 30 步；尺寸需为 16 的倍数。
  "mage-flow": {
      name: "Mage-Flow",
      hint: "T2I：Diffusion + Mage-VAE + Qwen3-VL（Base 模型建议 30 步）",   // 1262
      genDefaults: { ... sample_params: { sample_steps: 20, ... } },        // 1276
  },
  ```

- **问题**：同一个 family 里 `hint` 说 30 步、注释说「Base 版 30 步」、代码填 20 步。上游 `docs/mage_flow.md:15`：“Use 30 steps for Base models and 4 steps with `--cfg-scale 1` for Turbo models.” `mage-flow-edit`（Base 版编辑）填的正是 30（`families.ts:1320`），只有纯 T2I 的 Base 填了 20——看起来是复制 RL 档的参数时漏改。20 步对 Base 模型是欠采样，出图偏糊。
- **上游/对照依据**：`docs/mage_flow.md:15`；本仓库 `families.ts:1320`（同族 Edit Base 用 30）作为内部不一致的第二证据。
- **建议**：`families.ts:1276` 改 30，或把注释里的 RL 档明确拆成独立家族/独立提示。改动文件：`src/config/families.ts` 一处。

### 2.4 CLI 参数覆盖矩阵（含真正不可设置的清单）

- **级别：P2**
- **位置**：`src-tauri/src/server.rs:232-338`（拼装与 extraArgs 解析）、`src-tauri/src/cli.rs:439-604`（启动前校验）、`src/lib/launchConfig.ts:107-206`、`src/lib/diagnostics.ts:42-61`
- **现状**：Lumina 只有 3 条通道能影响 sd-server 的 argv：①`families.ts` 的 `fields`+`fixedArgs`（模型组件）；②`launchConfig.ts`/`diagnostics.ts` 里 17 个写死的结构化键；③`extraArgs` 文本框（`Dashboard.tsx:1414-1423`，占位符 `例如 --threads 8 --mmap`）。
- **extraArgs 实际支持什么写法**（务必按实现判断，不能按直觉）：`server.rs:95-119` 的 `split_args` 支持空格分隔 + 单/双引号包裹，未闭合引号报错；`server.rs:269-278` 把 `--key=value` **拆成两个 token**（因为上游 `parse_options` 是精确字符串匹配，`--k=v` 会 unknown argument）；`server.rs:285-293` 对 `-m=` 同样拆开；值型参数即使以 `--` 开头也不误判（`cli.rs:551-580` 注释明确）。布尔开关直接写 `--mmap`。
- **问题**：见下表。**唯一真正“任何途径都设不了”的是 `--listen-ip` / `--listen-port`**——被硬拒（`server.rs:256-265`，还挡住 `--listen-port=` 变体），理由是启动器自己代理所有请求。这是有意的安全设计，并且已被作者写进「遇到问题先看这里」（`README.md:91`：“`--listen-port` / `--listen-ip` 写在附加启动参数里会被拒绝，界面所有请求都靠这个端口代理”）与「已知限制」（`README.md:114`：“监听地址固定 `127.0.0.1`，只有端口可配”）。按简报“不要重复已知限制”的要求，这里只登记一条事实供 Lead 判断工作量：**它同时关闭了 `--listen-ip 0.0.0.0` 的局域网共享能力**，界面上没有“仅供本机 / 允许局域网”的开关，也没有把选定地址回传给内核的方式（`server.rs:233-238` 写死）。

**覆盖矩阵**（✅=专用控件 · ⚠️=只能写 extraArgs · ❌=不可设置 · —=对 sd-server 不适用）

| 上游参数 | 分类 | 证据 |
|---|---|---|
| `--model` `--diffusion-model` `--high-noise-diffusion-model` `--uncond-diffusion-model` | ✅ | `families.ts:637/854/1477`（家族组件位） |
| `--vae` `--clip_l` `--clip_g` `--clip_vision` `--t5xxl` `--llm` `--llm_vision` | ✅ | `families.ts:426-428/736-737/471-472` |
| `--audio-vae` `--embeddings-connectors` `--control-net` `--ip-adapter` `--motion-module` | ✅ | `families.ts:1396/1399/639/650/676` |
| `--taesd` (`--tae` 别名) | ✅（**自动注入，非手写**） | `families.ts:2067-2080` 给除 FakeVAE 外**每个**家族 push 一个 `taesd` 可选位；`server.rs:125-133` 两别名都做路径校验 |
| `--lora-model-dir` `--embd-dir` `--hires-upscalers-dir` | ✅（半自动） | `launchConfig.ts:145-149` 一律指向 `modelDir`，不可单独指定 |
| `--backend` `--offload-to-cpu` `--type` `--max-vram` `--tokenizer` `--sage-attn` `--conditioning-cache-size` `--vae-format` `--ref-image-args` `--log-level` `--linear-scale` `--attn-scale` `--flash-attn` | ✅ | `launchConfig.ts:150-166,187-196`、`diagnostics.ts:42-61`、`families.ts:406,474` 等 `fixedArgs` |
| `--params-backend` `--split-mode` `--threads` `--mmap` `--eager-load` `--disable-prefetch` `--disable-segmented-compute` `--control-net-cpu` `--clip-on-cpu` `--vae-on-cpu` `--auto-fit` `--batched-cfg` `--conv-direct` `--force-sdxl-vae-conv-scale` `--tensor-type-rules` `--model-args` `--lora-apply-mode` `--rng` `--sampler-rng` `--prediction` `--rpc-servers` `--serve-html-path` `--color` `--verbose` | ⚠️ | 无控件；但 `server.rs:232-338` 全量透传（只挡 listen 与校验绝对路径）。`cli.rs:180-204` 只把其中 17 个登记为“取值型” |
| `--pulid-id-embedding` `--pulid-id-weight` `--pm-id-images-dir` `--pm-id-embed-path` `--pm-style-strength` | ⚠️（且**无论如何都不生效**，见 2.1） | 无控件；`server.rs:160-161` 仅校验路径存在性 |
| `--ad-model` `--ad-prompt` `--ad-negative-prompt` `--extra-ad-args` | ⚠️（**内核忽略**，见 2.7） | `server.rs:153` 甚至会校验 `ad-model` 路径存在，给人“被支持”的错觉 |
| `--sigmas` `--hires-sigmas` `--skip-layers` `--skip-layer-start/end` `--high-noise-*` `--img-cfg-scale` `--slg-scale` `--qwen-image-layers` `--eta` `--flow-shift` `--timestep-shift` `--guidance` `--strength` `--control-strength` `--ip-adapter-strength` `--vae-tiling` `--vae-tile-size` `--vae-relative-tile-size` `--vae-tile-overlap` `--temporal-tiling` `--circular*` `--hires*` `--cache-mode` `--cache-option` `--batch-count` `--video-frames` `--fps` `--seed` `--steps` `--width` `--height` `--prompt` `--negative-prompt` `--ref-image*` `--moe-boundary` `--vace-strength` `--increase-ref-index` `--scm-*` `--disable-image-metadata` `--list-devices` | — | 生成期参数，走 `/sdcpp/v1` 请求体（`examples/server/api.md:541-954` 请求字段表）；`--list-devices` 由 Lumina 自己用于探测（`server.rs:561`） |
| `--listen-ip` `--listen-port` | ❌ | `server.rs:256-265` 显式 `bail!`；`server.rs:233-238` 写死 `127.0.0.1` |
| `--mode` `--output` `--image` `--metadata-format` `--preview*` `--taesd-preview-only` `--imat-in` `--imat-out` `--convert-name` `--output-begin-idx` `--compression-quality` `--metadata-raw/brief/all` | — | 定义在 `examples/cli/main.cpp:67-211`，sd-server 的 help 里没有；`cli.rs:164` 要求 help 同时含 `--model` 与 `--listen-port` 才认作 server 帮助，否则判 unknown |

### 2.5 「附加启动参数」是唯一逃生舱：无输入期校验、无补全、无分模型提示

- **级别：P2**
- **位置**：`src/components/dashboard/Dashboard.tsx:1410-1427`、`src-tauri/src/server.rs:247-305`、`src-tauri/src/cli.rs:439-604`
- **现状**：单个 `<input type="text">`，提示语「最后追加到 sd-server 命令行，同名值优先于控件；启动前按实际内核预检，不会改写保存值」。
- **问题**：
  - **可发现性**：`--bug` 级的拼写错误（`--taesd` → `--taesd=x`、`--flash-attn yes`）只能靠“启动前预检”兜住，而预检只覆盖硬编码的十几个名字（`cli.rs:475-548`）。其余参数（`--threads abc`、`--rpc-servers` 写错端口）会一路送进内核，在启动瞬间由 sd-server 打一条 usage 后退出——用户看到的是“启动失败”而不是“第几个参数错了”。
  - **同一事实写两处**：结构化控件的值与 extraArgs 里的同名参数都进 argv，靠“extra 在后、后者覆盖”隐式取胜（`server.rs:240-245` 注释）。但上游并非所有参数都是“后者覆盖”（例如 `-r/--ref-image` 是累加），用户把 `--ref-image` 写进 extraArgs 会与面板里的参考图**叠加**而不是覆盖。
  - **分模型快照会继承**：`extraArgs` 存在 `ModelConfigSnapshot` 里（`settings.rs:112`），切模型时若未清空，A 家族的 `--model-args` 会带到 B 家族——这是同一机制的必要代价，但没有任何“该参数与当前家族无关”的提示。
  - **不可分模型的硬参数**：PuLID/PhotoMaker 的 ID 参数（2.1）、`--rpc-servers`（多机用户刚需，`docs/rpc.md`）、`--threads`（弱机性能调优的第一步）都只能手写。
- **建议**：①在 extraArgs 输入框旁把“内核 `--help` 里存在但 Lumina 无控件”的参数做成可点选的 `datalist`（`cli.rs` 已经把全部选项名解析进 `CliCapabilities.options`，直接复用，零额外探测）；②把 `validate_args` 的“名字是否被内核声明”这条通用检查扩展到**所有**以 `--` 开头的 token（目前只对白名单名字做 `caps.supports()` 判断），这样 `--thread`（少个 s）这类错拼能在启动前变成可读错误。改动文件：`src-tauri/src/cli.rs`、`src/components/dashboard/Dashboard.tsx`。

### 2.6 `family.rs` 裸子串匹配的误判面

- **级别：P2**
- **位置**：`src-tauri/src/family.rs:62-360`（`detect_family`），关键几条：`:314-316`（anima）、`:338-349`（wan）、`:323-328`（lens）、`:226-231`（pixart）
- **现状**：

  ```rust
  // family.rs:314-316
  if has_any(&t, &["anima"]) { return "anima"; }
  // family.rs:338
  if has_any(&t, &["wan"]) { ... }
  ```

  `has_any` 就是 `s.contains(p)`（`family.rs:7-9`），且 `t` 是**整条小写路径**（含所有父目录名）。
- **问题**：
  1. `anima` ⊂ `animation` → 任何路径含 `animation`（例如 `D:\models\my_animation_pack\...`、`stable-diffusion-animation-v2.safetensors`）都会被判成 Anima 家族，进而要求 VAE+Qwen3 组件，用户会看到“缺组件”的 NO-GO。
  2. `wan` ⊂ `wand` / `swan` / `taiwan` / `want`；`lens` ⊂ `lenses`；`krea`（在 `is_diffusion_model_name` 里，`family.rs:516`）过于宽泛。
  3. 因为 `t` 含父目录，**目录名会抢家族**：`D:\models\flux2\sdxl_finetune.safetensors` 会先命中 `flux2`（`family.rs:164`），尽管文件是 SDXL。
  4. **`flux-1-dev` 无规则命中**：规则只认 `flux1-` / `flux.1-` / `flux1_`（`family.rs:167`），漏了 `flux-1`（连字符）与 `flux_1`（下划线）。这类文件会一路掉到底部 `sd`/`custom`，**不报错**，只是组件清单变成 `custom` 的 8 个全量槽位。
- **上游/对照依据**：上游没有“家族识别”概念（从权重张量自动判定版本，`src/model_loader.cpp:512` 一带按 tensor 名字判定版本），所以这类误判在 GUI 层是纯新增风险，只能靠文件名启发式。
- **缓解现状**：有手动覆盖（`Dashboard.tsx:975-978` 的下拉 + `settings.family_override`），所以误判可恢复；这也是它只算 P2 的原因。
- **建议**：把 `anima`/`wan`/`lens`/`krea` 这类短词从“裸子串”改成“按 `[^a-z0-9]` 切 token 后整 token 相等”（`is_iris` 里已有现成写法可复用，`family.rs:44-49`），并补 `flux-1` / `flux_1` 规则。改动文件：`src-tauri/src/family.rs`。

### 2.7 硬缺口逐项评估（该不该做）

- **级别：P1–P3 汇总（逐项见表内“判断”列）**
- **位置**：`src/config/families.ts:640-641,683-684`、`src-tauri/src/server.rs:125-172`、上游 `examples/server/api.md`、`docs/{pulid,photo_maker,adetailer,ip_adapter,rpc,imatrix,backend_probe}.md`

| 能力 | 上游是什么形态 | sd-server 面 | Lumina 现状 | 判断 |
|---|---|---|---|---|
| **PuLID** (`docs/pulid.md`) | `--pulid-weights`(ctx) + `--pulid-id-embedding`/`--pulid-id-weight`(**单次生成**参数，`include/stable-diffusion.h:317-322`) | HTTP 无字段，`examples/server/**` 零引用 | sd/sdxl 有权重位（错家族） | **不该以现状保留**。要么移除，要么降级为 NO-GO 提示（见 2.1）。真要做必须等上游开放请求字段 |
| **PhotoMaker** (`docs/photo_maker.md`) | `--photo-maker`(ctx) + `--pm-id-images-dir`/`--pm-id-embed-path`/`--pm-style-strength`(生成级) | 同上，零引用；缺 ID 图时 `photomaker_extension.cpp:216-218` 自行关闭 | sdxl + sd 有权重位 | **同上**，且 `sd` 上一并删掉（SDXL-only） |
| **IP-Adapter 多图** | `--ip-adapter`(ctx) + `ip_adapter_image`/`ip_adapter_strength` | **已支持**（`api.md:629`、`:899-902`） | 权重位 ✅（`families.ts:650-657`、`:693-700`），请求字段由 api-alignment 组覆盖 | **不需要新工作**；只剩「多图」上游本身是单图（`ip_adapter_image` 是单值），不要自行扩展 |
| **ControlNet** | `--control-net`(ctx) + `control_image`/`control_strength`/`control_video` | **已支持**（`api.md:1098`） | 权重位 ✅（`families.ts:639`、`:674`），`disabledFeatures` 可为家族关掉 | **不需要新工作** |
| **ADetailer** (`docs/adetailer.md`) | 只有 `-M adetailer` 模式（`cli/main.cpp:196-199`）+ `--ad-*` 参数 | **完全不存在**；`--ad-model` 被 common 解析后无人消费 | 无控件，但 `server.rs:153` 把 `ad-model` 列入路径校验名单 | **明确不该做**。README:118 已正确声明“上游 `/sdcpp/v1` 不开放 ADetailer”。建议顺手把 `ad-model` 从 `PATH_VALUE_ARGS` 移除，避免给出“被支持”的假信号 |
| **AnimateDiff** | `--motion-module`(ctx)，生成时 `-M vid_gen` | 支持（视频请求体 + 按加载模型决定是否广告 `vid_gen`，`routes_sdcpp.cpp:243`/`:335`） | 完整 ✅ | 链路是通的：`families.ts:676-682` 的 `motion-module` 字段 → `sd` 家族 `genDefaultsByMode.vid_gen`（`families.ts:709-727`）→ 模式开关由服务端 `supported_modes` 决定（`routes_sdcpp.cpp:335`）。README:117 的 16 帧限制来自上游训练上下文，非缺陷。**唯一未核实的环节**：AnimateDiff 场景下 sd-server 是否真的把 `VID_GEN` 放进 `supported_modes` 取决于上游版本表，`runtime.cpp:170-181` 只是返回 `"loaded model does not support vid_gen"` 的兜底分支 |
| **`--mode convert`** | sd-cli 专属（`cli/main.cpp:196-199`，值域含 `convert`） | 无 convert 路由 | — | **明确不该做**。它是离线权重量化工具，与“启动一个服务跑推理”的产品定位正交；真要做应做成独立小工具而不是塞进启动参数。README 未承诺，无需改动 |
| **`--rpc`** | `--rpc-servers` + `--backend RPC0` | 支持（ctx 参数） | ⚠️ 仅 extraArgs | **该做，但优先级 P3**：多机拆卡用户能自己写，但 `--backend` 控件是下拉（`Dashboard.tsx:1146-1160` 只给 `cuda/vulkan/…`），RPC0 这类设备名要靠“自定义 --backend”输入框 + extraArgs 两处配合，路径不直观。最小改动：`--backend` 候选列表合并 `--list-devices` 实际输出（当前 `server.rs:561` 已调用过该命令） |
| **imatrix** | `--imat-in`/`--imat-out`，sd-cli 专属（`cli/main.cpp:209`、`docs/imatrix.md` 全篇 sd-cli） | 无 | — | **不应由 GUI 提供生成期采集**；若做，只应作为「量化工具」独立页面 |
| **`backend_probe`** | 纯 C++ 内部机制（`docs/backend_probe.md` 是给贡献者的开发文档，没有 CLI 开关） | 无 | — | **不该做**，没有可暴露的面；用户能调的是 `--flash-attn` / `--conv-direct` 的模式串，已支持 |
| **`--high-noise-*`** | 启动默认 + 请求级 `high_noise_sample_params` | **已支持**（api.md） | `wan-a14b` 的 `genDefaults.high_noise_sample_params` ✅（`families.ts:880-887`） | 不需要新工作 |

### 2.8 README 的家族清单漏了两个家族，且数量与实际不符

- **级别：P2**（文档 = 用户判断“这个模型能不能用”的唯一入口，漏项的恰好是两个启动条件最特殊的家族）
- **位置**：`README.md:105-107`
- **现状**：`<summary>已适配的模型家族（58 个，外加"自定义"）</summary>`，正文枚举从 Flux.1 到 MOSS-Image。
- **问题**：
  - `FAMILY_CONFIG` 实际有 **61 个键**（60 个家族 + `custom`；以 `fields: [` 的出现次数计数 61，`name:` 同为 61，`mode: "img"|"vid"` 为 62 减去第 201 行的类型声明）。
  - 清单里**没有 `llada-image` / `llada-image-turbo`（LLaDA-Image）**，也**没有 `sensenova-u1`（SenseNova U1.5）**。README 全文对 `LLaDA` / `SenseNova` 零提及（grep `README.md` 无命中）。
  - 连带后果：这两个家族的**启动前置条件没写进「已知限制」**——LLaDA-Image 强制外部 `tokenizer.json`（`families.ts:246-247` 在 `EXTERNAL_TOKENIZER_FAMILIES` 里），而 `README.md:123` 只写了 MOSS-Image 的 tokenizer 要求；SenseNova U1.5 的“仅 non-thinking 文生图、宽高需 32 对齐、不支持参考图/编辑”（`families.ts:407-408`）也完全没提。
- **建议**：`README.md:105` 改成「60 个」，清单补 LLaDA-Image（50 步 / Turbo）与 SenseNova U1.5，「已知限制」补两条（LLaDA 需 LLaDA2 tokenizer；SenseNova 仅文生图 + 32 对齐）。

### 2.9 一组有实际意义但无控件的启动参数

- **级别：P3**
- **位置**：同 2.4 的 ⚠️ 行；典型用户会碰到的：`server.rs:232-338`
- **问题**：按“用户会不会想调”排序：`--threads`（弱 CPU 上最常调）、`--rpc-servers`（多机）、`--mmap`（大模型目录内存）、`--params-backend`（把参数放 CPU，8GB 卡刚需，且 `cli.rs:458-467` 已经把它纳入 auto-fit 冲突判断却又不给入口）、`--split-mode`、`--eager-load`、`--no-*` 系列。这些上游都有，Lumina 一个控件都没有；`--params-backend` 尤其别扭——代码里专门处理了它的语义（`cli.rs:446-467`），UI 却只能靠用户读源码才知道要手写。
- **建议**：把 `--threads`（数字输入）与 `--params-backend`（同 `--backend` 的模块分配输入框）提到「启动参数」区，其余保持 extraArgs + 2.5 的 datalist 补全即可。

### 2.10 `families.ts` 缩进 1 tab / 2 tab 混用

- **级别：P3**
- **位置**：`src/config/families.ts:941-1017`（`minimax-h3-fl2va` / `minimax-h3-ref2va` 整块 2 tab），`:1019-1040`（`zimage`）回到 1 tab，`:2067-2080` 又是 1 tab + 4 空格混排
- **现状**：`941:		// docs/minimax_h3.md ...`（2 tab）与 `419:	},`（1 tab）同处一个对象字面量。
- **问题**：仓库无 prettier / eslint（简报 §1 已述），这种偏差不会被工具纠正；`minimax` 两块正好是最新、最常被复制粘贴当模板的家族定义，后续新增家族会继续分叉。`zimage`（`families.ts:1019`）甚至从 2 tab 块里“缩进回退”，阅读时容易误判它是上一层的属性。
- **建议**：仅记录，不要求本轮修；若 Lead 要开维护性条目，这就是现成证据。

### 2.11 `SIZE_SPATIAL_ALIGN` 漏了 Mage-Flow 的 16 对齐要求

- **级别：P3**
- **位置**：`src/config/families.ts:334-358`
- **现状**：表中收录 `sensenova-u1`(32)、`minimax-h3-*`(32)、`qwen-image-2.1`(32)、`llada-image*`(32)、pixart(16)、`ming-image`(16)、`zimage-l2p`(16)、`iris`(16)、`moss-image`(16)，**没有 mage-flow 四族**。
- **问题**：上游 `docs/mage_flow.md:15`：“Image dimensions must be multiples of 16”。`alignSizeUp`（`families.ts:361-365`）对未登记家族原样返回，所以用户手填 1000×1000 时不会被就近/向上对齐到 1008；`scaleSize` 会退化用 16 兜底（`families.ts:380`），只有「自定义像素」这条路径会漏。影响面很小，故 P3。
- **建议**：把 `mage-flow` / `mage-flow-turbo` / `mage-flow-edit` / `mage-flow-edit-turbo` 四条加进 `SIZE_SPATIAL_ALIGN`，值 16。

### 2.12 核对结论：`--taesd` 不是缺口（对 Lead 疑问的更正）

- **级别：信息（不是问题）**
- **位置**：`src/config/families.ts:1956-1980`（`FAKE_VAE_FAMILIES`）、`src/config/families.ts:2067-2080`（注入循环）、`src/config/families.ts:1982-2058`（按家族给出该用哪份 TAE 权重的提示表）
- **现状**：

  ```ts
  for (const [family, config] of Object.entries(FAMILY_CONFIG)) {
      if (FAKE_VAE_FAMILIES.includes(family)) continue;
      if (config.fields.some((field) => field.arg === "taesd")) continue;
      config.fields.push(F("taesd", "TAE 快速解码 (可选)", "taesd", "taesd", false, TAE_HINT_BY_FAMILY[family] || DEFAULT_TAE_HINT));
  }
  ```

- **结论**：**`--taesd` 有专门控件，且是对全部非 FakeVAE 家族自动注入的第 9 个组件位**，`buildLaunchConfig` 会把它写进 `args.taesd`（`launchConfig.ts:124-131` 遍历 `fields`）。7 个 FakeVAE 家族（`chroma-radiance`/`hidream`/`minit2i`/`sensenova-u1`/`zimage-lp`/`iris`）被显式排除，理由写在 1965-1968 行，与上游 `create_tae` 的优先级一致。**不是 P1，无需改动**；`README.md:94` 的“换 TAE 解码”说法有实现支撑。

### 2.13 核对结论：扫描器有而家族无槽位的 7 个 cat，逐个结论

- **级别：信息（对 Lead 疑问的更正）**
- **位置**：`src-tauri/src/family.rs:532-720`（`classify_file` 返回 20 类）、`src/components/dashboard/Dashboard.tsx:217,225,1014`（按 `field.cat` 过滤候选文件）
- **结论**（`cat` 实际取值比 Lead grep 到的多两种——`ip_adapter`（`families.ts:654,697`）与 `motion_module`（`families.ts:679`）**是**家族槽位，只是写在多行 `F(` 调用里，单行 grep 抓不到）：

  | 扫描器 cat | 是否有家族槽位 | 结论 |
  |---|---|---|
  | `taesd` | ✅ 自动注入 61 个家族 | 见 2.12，无需改动 |
  | `ip_adapter` | ✅ `sdxl:650`、`sd:693` | 权重入口存在；“有输入框没权重入口”的担心不成立 |
  | `motion_module` | ✅ `sd:675` | AnimateDiff 链路完整（见 2.7） |
  | `uncond_model` | ✅ `ideogram:1474-1479` | 已覆盖（上游 `docs/ideogram4.md` 要求 `--uncond-diffusion-model`） |
  | `high_noise_model` | ✅ `wan-a14b:859-864` | 已覆盖 |
  | `lora` | ❌（正确） | LoRA 是**请求级**结构化字段（`api.md:234`，`loras` 数组），由 `LoraPanel.tsx` 提交，不该做家族槽位；`--lora-model-dir` 由 `launchConfig.ts:146` 自动指向模型目录 |
  | `upscaler` | ❌（正确） | 同一逻辑：`GET /sdapi/v1/upscalers` 从 `--hires-upscalers-dir` 扫描（`api.md:333`），放大通过 `POST /sdcpp/v1/upscale` 触发（`api.md:60`） |

### 2.14 上游 `f0aac52` 之后的 3 个提交是否需要界面改动

- **级别：信息**
- **位置**：上游 `git log`（`d55cc0f` → `f0aac52`）
- **结论**：
  - `95b3090`（MOSS split QKV + host 侧批量加载，#2160）：纯权重加载路径，**无需界面改动**；Lumina 的 `moss-image` 组件清单（`families.ts:613-617`）不变。
  - `ab8d5ea`（Diffusers 格式 MiniMax-H3 LoRA，#2159）：LoRA 走请求级 `lora` 数组（`api.md:234`），Lumina 的 `LoraPanel` 已通用，**无需改动**；只是 `lora-apply-mode` 的默认行为不变。
  - `d55cc0f`（文档）：`docs/moss_image.md` 更新后仍与 `families.ts:619-620` 的 16 对齐/CFG 3.0 一致，**无需改动**。
  - 结论：**当前版本门控不需要因为这三个提交调整**；风险主要是「未来上游把 `--tokenizer` 改成多值或把 `pulid`/`pm` 放进 HTTP」这类形态变化，靠 `cli.rs` 的 `--help` 探测只能发现“参数有没有”，发现不了“语义变没变”。

---

## 3. 待验证假设

1. **`--conditioning-cache-size 0` 的真实语义**：`launchConfig.ts:160-166` 与 `cli.rs:519-524` 都接受 `0` 并注释“0 表示关闭条件缓存”，但我没有在 `docs/caching.md` 里逐字确认 0 = 关闭（只确认了它是非负整数）。若实际是“无上限”，默认值建议会不同。
2. **`--flash-attn on` 用于 SenseNova 是否优于 `off,diffusion=on`**：`families.ts:406` 是所有 `fixedArgs` 里唯一写 `"on"` 的（其余 47 处都是 `"off,diffusion=on"`，13 个家族 `fixedArgs: {}`）。可能是作者按上游 `docs/sensenova_u1.md` 的 CUDA 示例有意为之，但我没找到上游对“Sensenova 需要全模块 FA”的明确说明。
3. **`ltx25` 的 121 帧 @24fps**：`families.ts:1464-1465` 的默认值，我在 `docs/ltx2.md` 只读到 LTX-2.3 的 33 帧示例，没读到 2.5 的 121 帧出处（文件我只读了前 70 行）。若 2.5 也是 33 帧起步，默认值偏大。
4. **`ideogram` 的 CFG 7**：`families.ts:1492`。上游 `docs/ideogram4.md` 的示例命令**没有** `--cfg-scale`，7 这个值我没找到上游依据（可能是官方模型卡的值）。
5. **`--disable-image-metadata` 在 sd-server 下是否被消费**：common.cpp 里有定义（`common.cpp:1392`），但我在 `examples/server/**` 没找到使用点；若确认只有 sd-cli 消费，它应归入「不适用」而非「仅 extraArgs」。
6. **`--hires-upscaler` 的模型名解析与 `--hires-upscalers-dir` 的配合**：`api.md:333` 说 model-backed upscaler 从 `--hires-upscalers-dir` 顶层扫描，而 Lumina 把该目录硬绑到 `modelDir`（`launchConfig.ts:148`）。如果用户的放大器放在别处，独立放大（README:119 的 ✨ 按钮）会看不到它——需要跑一次实测确认。
7. **`detect_family` 对 `minimax-h3` 双变体的目录级判定**：`family.rs:116-121` 只看路径里有没有 `ref2va`。若用户把两个变体放在同一目录、文件名只写 `model.safetensors`，会一律判成 FL2VA。

## 4. 与其它组可能重叠的点（Lead 合并用）

| 重叠点 | 本报告位置 | 建议归属 |
|---|---|---|
| `CliCapabilities` 的 `--help` 解析、能力探测策略的局限 | 2.4、2.14 | **api-alignment**（能力探测与版本门控是它的主题；本文只从“能否覆盖参数”角度引用） |
| `extraArgs` 透传在 `server.rs::build_args` 的正确性（`--k=v` 拆分、引号、路径校验） | 2.5 | **backend-rust**（`server.rs` 属它） |
| `Dashboard.tsx` 的组件配置 UI / 检查单 NO-GO 逻辑 | 2.1、2.5、2.9 | **frontend-arch**（我只给“缺哪个控件、为什么”，不评价组件结构） |
| `families.ts` 巨型文件（2083 行）+ 无格式化 | 2.10 | **frontend-arch / build-test**（可维护性） |
| README 家族清单与「已知限制」的准确性 | 2.8 | **build-test**（文档类） |
| `--backend` 候选列表应合并 `--list-devices` 实测输出 | 2.7（`--rpc` 行） | **backend-rust**（`server.rs:561` 已调用该命令） |
| PuLID / PhotoMaker / ADetailer 是否可由 HTTP 面支持 | 2.1、2.7 | **api-alignment**（判定依据是 `api.md` 字段表，我引用了结论，建议它复核一遍字段表以确认上游未新增） |
