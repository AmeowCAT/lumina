# 上游同步分析：`d55cc0f` → `95ff762`（2026-10-24）

对齐号：README 当前写的是 `d55cc0f`（2026-10-18）。上游 `master` 现在是
`95ff762`（2026-10-23，`fix: update ggml to fix SageAttention builds on older GPUs #2199`），
两者之间有 **24 个提交**，其中 **14 个改动了 `examples/server/**` 或 `examples/common/**`**，
另有 1 个新增模型家族和 1 套新的模型管理 API。

本文只做判断与落点分析，不改源码。P0 项附补丁草案，可直接照抄。

## 0. 结论

**需要同步，而且不是「只更新对齐号」那一档。**

| 结论                            | 依据                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 有 1 处**会静默算错**的协议变更 | 任务时间戳 `created/started/completed` 从**秒**改成**毫秒**（随 #2176 落地），Lumina 的两处耗时显示会变成 1000 倍或 0 |
| 有 1 处**交互语义**变更         | 生成中任务现在可以取消（`cancel_generating` 变 `true`，接口 409 → 200），Lumina 的 200 分支会误报「该任务已结束」     |
| 有 1 条**已过期的裁定**         | ADetailer 的 `ad_*` 四个字段不再是死键；`--ad-model` 也不再是「解析后无人消费」                                       |
| 新增 1 个模型家族               | Fibo 2.0 Dev / Edit Turbo（#2180），家族数 60 → 62                                                                    |
| 有 2 个新启动参数               | `--taesd-preview-only`、`--model-dir`（后者语义升级，不再是单纯的文件目录）                                           |
| 有 1 处**静默行为**变化         | 启动参数里写了 `--ad-model` 的用户，从此每次 `img_gen` 都会自动跑一次检测 + 局部重绘                                  |
| 战略项                          | recipe 模型管理（6 个新端点、108 个内置 recipe、进程内换模型）——**本轮不建议接**，理由见 §5                           |

机器检查的现状（已跑）：

```text
$ node scripts/upstream-diff.mjs --upstream <clone> --since d55cc0f --ref master
⚠ 上游新增的启动参数（2）
  --taesd-preview-only
  --model-dir

$ node scripts/upstream-diff.mjs --coverage --upstream <clone> --ref master
ℹ 已登记为「有意不接」的字段（5）:
  ad_model / ad_negative_prompt / ad_prompt / extra_ad_args — "只在 sd-cli 的 -M adetailer 通道可用，/sdcpp/v1 不消费"
✓ 未覆盖字段都已登记
```

第二条的 `✓` 是**假绿**：字段确实「有落点」（登记在 `KNOWN_UNSUPPORTED` 里），但登记理由
已经被 #2164 推翻。这正是 §6 要补的盲区。

## 1. 上游变化分组

| 组                | 提交                                                                      | 影响面                                                                                                  |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 模型管理 / recipe | `0518b343` #2176、`f18dbfce` #2188                                        | **时间戳单位**、`--model-dir`、6 个新端点、`capabilities.runtime`、503/409/422 错误码、LoRA 多根目录 ID |
| ADetailer         | `845646b0` #2164                                                          | `ad_*` 请求字段生效、`--ad-model` 启动即生效、`--backend detector=…`                                    |
| 取消生成中任务    | `e779d4f1` #2190                                                          | `cancel_generating=true`、cancel 200 + `cancel_requested`                                               |
| 新家族            | `2e2ba3fa` #2180                                                          | Fibo 2.0 Dev / Edit Turbo + `docs/fibo2.md`                                                             |
| 预览 / TAE        | `a0c8508e` #2184                                                          | `--taesd-preview-only` 进入共享上下文参数（sd-server 也认）                                             |
| 设备枚举          | `b15c8aac` #2182                                                          | `--list-devices` 现在包含 `--rpc-servers` 的远端设备                                                    |
| 视频              | `baf45b49` #2177、`40b17884` #2196                                        | `ref_image_args` 对 `vid_gen` 生效；Wan2.2 TI2V 5B 支持 `temporal_decode_frames`                        |
| 尺寸              | `deaeed6a` #2189                                                          | MiniT2I 强制 512×512                                                                                    |
| 采样默认          | `269045e9` #2172                                                          | `custom_sigmas: []` 现在表示「未指定」                                                                  |
| 其他              | `a068716f` #2162、`9b7da273` #2167、`939895f0` #2076、`cd7f9860` #2198 等 | LoRA auto 判定、OpenAI 编辑路由、日志 ETA、模型工厂重构；对界面无直接协议影响                           |

## 2. 必须处理（P0）

### 2.1 任务时间戳：秒 → 毫秒

**证据**

- `examples/server/api.md`：`created`、`started`、`completed` 的示例从 `1775401200` 改成
  `1775401200000`，并新增一句「integer Unix timestamps in **milliseconds**」。
- `examples/server/async_jobs.h`：`created_at = unix_timestamp_now_ms()`。
- `examples/server/runtime.cpp`：`unix_timestamp_now()` 改名 `unix_timestamp_now_ms()`，
  `duration_cast<milliseconds>`。
- 该改动藏在 **#2176（recipe 模型管理）** 里，按 PR 标题根本看不出来。

**Lumina 现状**（`src/types.ts:547-560` 那段注释是明确按「秒」写的）

| 位置                                                           | 现有逻辑                                                                                        | 新内核下的结果               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| `src/lib/utils.ts:433` `jobElapsed`                            | `beginSec = started ?? created`；`endedAt = completed * 1000`；`ms = endedAt - beginSec * 1000` | 8.5 s 显示成 `141m40s`       |
| `src/components/generation/ResultsGrid.tsx:180` `elapsedLabel` | `completedAt / 1000 - created`，再 `Math.max(0, …)`                                             | 恒为 `0 秒`                  |
| `src/components/generation/GenerationUI.tsx:577` 放大结果      | `created: Math.floor(completedAt / 1000)`（秒）                                                 | 合成任务与真实任务单位不一致 |
| `src/hooks/useJobPolling.ts:282`                               | `created: d.created` 原样进结果条目                                                             | 同上                         |

**兼容策略**：旧内核仍在野外，不能直接改单位。加一个归一化函数，按量级判定
（秒级时间戳 ≈ 1.7e9，毫秒级 ≈ 1.7e12；阈值取 `1e11`，秒制要到公元 5138 年才越界）。

```ts
// src/lib/utils.ts
/** 内核任务时间戳：上游 #2176 起是毫秒，旧内核是秒。 */
export function toEpochMs(value?: number | null): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e11 ? value : value * 1000;
}

export function jobElapsed(job: Job, terminal: boolean): string {
  if (job.status === "queued") return "";
  const begin = toEpochMs(job.started ?? job.created);
  if (begin == null) return "";
  const ended = toEpochMs(job.completed) ?? (terminal ? job.lastPollSuccess : undefined);
  if (terminal && ended == null) return "";
  const ms = (ended ?? Date.now()) - begin;
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}
```

`ResultsGrid.elapsedLabel` 同样改成 `toEpochMs(created)` 再与 `completedAt` 相减；结果条目
的 `created` 建议在 `ingestCompletedJob` 处一次性归一成毫秒（结果只在内存，没有历史包袱），
`GenerationUI` 的合成放大任务直接写 `created: completedAt`。

**测试**：`src/lib/__tests__/utils.test.ts:1622` 附近那组夹具要拆成「毫秒新内核」「秒级旧内核」两套；
`src/components/generation/__tests__/ResultsGrid.test.tsx:125` 的 `created: 1000 / completedAt: 4000`
要么改成毫秒，要么明确标注为旧内核兼容用例。

### 2.2 取消生成中任务：409 → 200

**证据**

- `routes_sdcpp.cpp`：`cancel_generating` 两种 mode 都改成 `true`；对 `Generating` 状态返回
  `200` + 作业对象（带 `cancel_requested: true`），不再返回
  `409 {"error":"job is currently generating and cannot be interrupted yet"}`。
- `async_jobs.cpp`：新增 `JobCancellationMonitor`，通过 `sd_cancel_generation` 真正打断采样；
  被取消的任务最终落到 `status=cancelled`、`error.code=cancelled`。
- `make_async_job_json` 新增 `cancel_requested` 字段。

**Lumina 现状**

- `JobQueue.tsx:153-163` 的按钮显隐已经读 `features_by_mode[kind].cancel_generating`，
  新内核会自动出现「取消」按钮——这部分**无需改动**。
- `GenerationUI.tsx:643-697` 的 `cancelJob` 拿到 200 后只看 `status`：新内核返回的是
  `generating`，于是走到 `if (s !== "cancelled")` 分支，弹出
  **「该任务已结束，无需取消」**——语义正好相反。同时没有记录「已请求中断」，
  用户会重复点。

**补丁草案**

```ts
// types.ts: Job 增加
/** 已发出中断请求，内核会在下一个检查点停止（上游 #2190）。 */
cancel_requested?: boolean;

// GenerationUI.cancelJob 的 200 分支：先处理"已受理但仍在生成"
const d = body as Partial<Job> | null;
if (d?.cancel_requested && d.status === "generating") {
  setJobs((j) => j.map((x) => (x.id === id ? { ...x, cancel_requested: true } : x)));
  toast("已请求中断，将在当前采样步结束后停止");
  return;
}
```

`JobQueue` 里给 `j.cancel_requested && generating` 的状态标签加「中断中…」、按钮置灰；
409 分支保留给旧内核。

### 2.3 ADetailer：裁定过期 + 静默生效

**证据**

- #2164（`docs/adetailer.md`、`runtime.cpp::apply_server_adetailer`、`async_jobs.cpp`）：
  `--ad-model` 配置了检测器时，**每次原生异步 `img_gen` 与 OpenAI 兼容生成结束后**都会跑
  检测 + 局部重绘；请求体里的 `ad_prompt` / `ad_negative_prompt` / `extra_ad_args` 会被消费。
- 检测器只认**启动参数** `--ad-model`；请求体里的 `ad_model` 不用于选检测器
  （`apply_server_adetailer` 读的是 `runtime.default_gen_params->ad_model_path`）。
- 服务端侧尺寸上限 4096、ADetailer 步数 1–100，超限在生成前就 400。

**Lumina 里已经过期的三处**

| 位置                              | 现在写的                                               | 实际                                                                      |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `scripts/upstream-diff.mjs:73-79` | `ad_*`「`/sdcpp/v1` 不消费」                           | 已消费（prompt / extra args），且 `--ad-model` 会触发后处理               |
| `README.md:120`                   | 「上游 `/sdcpp/v1` 不开放 ADetailer，界面里没有」      | 已开放（服务端侧）                                                        |
| `src-tauri/src/args.rs:84-86`     | 「`--ad-model` … HTTP 面是死键，刻意不登记为路径参数」 | 现在是活键；不登记会导致「附加启动参数」里的检测器路径不做路径校验/白名单 |

**处理选项**

| 选项 | 内容                                                                                                                                                                                            | 成本  | 建议       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| A    | 只更正文档与裁定：README 已知限制、`UPSTREAM-SYNC.md` 裁定表、`KNOWN_UNSUPPORTED` 理由、`args.rs` 注释并把 `ad-model` 加入 `PATH_VALUE_ARGS`；面板里对「附加启动参数含 `--ad-model`」给一条提示 | 0.5 h | **本轮做** |
| B    | 完整接入：检测器选择（扫描/分类 `adetailer` 类别）+ 启动参数 + 每次生成的 prompt/extra args + 结果元数据回填                                                                                    | 1–2 d | 下个 minor |
| C    | 只暴露启动参数（不做面板），把 `--ad-model` 变成控制台里的一行路径设置                                                                                                                          | 0.5 d | B 的降级版 |

**为什么 A 不能省**：现在任何按旧 README 把 `--ad-model` 写进「附加启动参数」的用户，
升级内核后会在**不知情**的情况下每次生成都多跑一次人脸/物体修复，出图结果和耗时都会变，
而界面没有任何提示。

### 2.4 `--taesd-preview-only`（新启动参数）

**语义**（`docs/taesd.md`、`common.cpp`）：TAE 只用于**采样过程预览**，最终图仍由完整 VAE 解码。
该开关原来在 `sd-cli` 侧，本次移进共享上下文参数，`sd-server` 也接受。

**为什么值得接**：Lumina 现在选「TAE 快速解码」就等于最终图也走 TAE（质量下降）；
有了这个开关，可以「预览用 TAE、出图用 VAE」。对 60 个家族里绝大多数（除 FakeVAE 家族）
都成立，`families.data.ts:2059` 那段自动补 TAE 字段的逻辑正好覆盖到。

**落点**：`Settings` / `ModelConfigSnapshot` 增加 `taesdPreviewOnly?: boolean` →
`launchConfig.ts` 追加 `args["taesd-preview-only"] = true` → 控制台「运行后端」面板加开关
（仅当该模型选配了 TAE 时可用）→ README 预览一节补一句。约 0.5 d（含测试）。

**注意**：老内核不认这个参数，`cli.rs` 的帮助解析会把它判成「不支持」，需要在
`validate_args` 的已知新参数列表里放行并给出人话提示（现有机制已经能做，见
`cli.rs:853` 附近那组用例）。

## 3. 应处理（P1）

### 3.1 视频参考图参数：`ref_image_args` 现在对 `vid_gen` 生效

- #2177 把 `ref_image_args` 透传给视频管线；MiniMax-H3 在 `vid_gen` 里认
  `ref_image_size=match|max`（`docs/minimax_h3.md`），`max` = 2048 px 短边，代价是每步都
  attend 参考 latent，明显更慢。
- Lumina 只在 `mode === "img_gen"` 分支里拼 `ref_image_args`（`utils.ts:1450-1460`），
  `vid_gen` 分支完全不发 → 视频参考图尺寸只能靠启动参数，界面无入口。
- 建议：`BuildRequestBodyOptions` 增加视频侧入口，在 MiniMax-H3 Ref2VA 的参考图行旁加
  「参考图尺寸：匹配画布 / 最高 2048」选择，拼成 `ref_image_size=max`（与启动 preset 合并）。
  约 0.5 d。

### 3.2 新家族：Fibo 2.0 Dev / Edit Turbo（#2180）

组件（`recipes/fibo2-*.json` + `docs/fibo2.md`）：

| 槽位              | 必需            | 说明                                                                     |
| ----------------- | --------------- | ------------------------------------------------------------------------ |
| `diffusion_model` | 是              | `fibo2_dev_int8_convrot` / `fibo2_edit_turbo_int8_convrot`               |
| `llm`             | 是              | Qwen3-VL 4B                                                              |
| `llm_vision`      | GGUF 编码器必需 | mmproj                                                                   |
| `vae`             | 是              | FLUX.2 VAE（`flux2_ae`）                                                 |
| `tae`             | 否              | recipe 没写；`fibo2.cpp` 的 `vae_kind = FLUX2`，`taef2` 可能可用，需实测 |

默认值：Dev `euler / CFG 5 / 20 步 / 1024²`；Edit Turbo `euler / CFG 1 / 4 步` + 参考图。
参考图 preset 由内核按模型定义自动选 `fibo2`（`ref_image_preset = "fibo2"`），界面无需传
`--ref-image-args`；宽高 16 对齐（`geometry = {1,128,3}`）。

落点清单：

1. `src-tauri/src/family.rs::detect_family`：加 `fibo2` / `fibo-2` / `fibo_2` 规则，置于
   `flux` 系列之后（避免被 `flux2` 子串规则误吞）。
2. `is_diffusion_model_name` 加 `fibo2`；否则模型文件只能靠 500 MB 体积兜底进 `model` 列表。
3. `src/config/families.data.ts`：两个条目（Dev / Edit Turbo），Edit Turbo 用
   `requiredInputsByMode.img_gen = ["ref_images"]`；`fixedArgs: {}`（不要把
   `flash-attn off,diffusion=on` 抄过来，上游没这个要求）。
4. README：家族清单 + 数字（60 → 62）。
5. `families.data.ts` 的 TAE 自动补字段逻辑会顺带给它加 TAE，建议实测 `taef2` 是否能解码
   Fibo2 latent；不能就显式排除。

约 1 d（含识别/分类/启动用例）。

### 3.3 MiniT2I 尺寸被内核强制 512×512（#2189）

`src/pipeline/request.cpp` 在 `GenerationRequest::resolve` 最前面把宽高硬改成 512×512 并打
`align to fixed size 512x512 for MiniT2I` 警告。Lumina 的 MiniT2I 默认值本来就是 512
（`families.data.ts:1811`），但**用户可以改**——改了以后内核静默改回，界面显示与实际
输出不一致，日志里每次多一条警告。

建议给 `FamilyConfig` 加 `fixedSize?: { width: number; height: number }`，`SizeSeedPanel`
在该家族下锁定两个输入并给出说明；hires 段不受影响（内核先夹基准尺寸再解析 hires）。
约 0.5 d。

**上游自身的不一致（需要留意）**：`docs/minit2i.md` 仍写 `100 步 / CFG 6`，而
`recipes/minit2i.json` 写 `20 步 / CFG 2.5`。上游 `examples/server/README.md` 明确写了
recipe 的步数默认值「capped at 20」，所以**不要照着 recipe 改 Lumina 的默认值**，
保持 docs 的 100/6 更合理。这类「recipe 与 docs 不一致」以后还会出现，建议在同步清单里
明确一条：**默认值以 docs/ 为准，recipes 只用于组件与能力声明**。

## 4. 只需登记（P2）

| 项                                               | 现状                                                                                                                                                                                 | 建议                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--list-devices` 现在包含 RPC 设备（#2182）      | `server.rs:246` 的探测不带 `--rpc-servers`，配了 RPC 的用户写 `--backend rpc0` 会被 `find_backend_error` 误杀                                                                        | 探测时若 `caps.supports("--rpc-servers") == true` 就追加该参数；**探测失败要当作非致命**（`print_devices()` 在 RPC 不可达时 `exit 1`，不能因此拒绝启动）                                    |
| `--model-dir` 语义升级                           | `UPSTREAM-SYNC.md:40-46` 的裁定理由还停留在「服务端文件目录 / Load models 界面」                                                                                                     | 理由改成「模型根 + `recipes/` 根 + `/sdcpp/v1/models/*` 的 ID 基准」；继续不接是成立的（Lumina 自己扫描并显式传 `-m`），但要知道内核启动时会无条件扫一遍 `<exe目录>/models`，没有文件数上限 |
| Wan2.2 TI2V 5B `temporal_decode_frames`（#2196） | `AdvancedSamplingPanel` 已有 `temporal_tile_frames` / `temporal_tile_overlap` 两个结构化控件                                                                                         | 加第三个数字框（仅 `wan-ti2v`），键名 `temporal_decode_frames`，默认 1，越大越吃显存                                                                                                        |
| `capabilities` 新增字段                          | `generation_features`、`runtime`（state/recipe/revision/load_elapsed_seconds）、`loras[].display_path`、`sample_params.custom_sigmas`、`vid_gen.ref_image_args`、`cancel_generating` | 类型补 `runtime` / `generation_features`（只读、暂不用）；其余会被 `deepMerge` 吃掉，无副作用。`custom_sigmas: []` 在旧内核上也不发（`buildRequestBody` 只发长度 ≥2 的数组）                |
| 日志 ETA（#2076）                                | 进度行新增 `- ETA mm:ss`                                                                                                                                                             | 可选：`logFormat` 不做解析也不影响；进度条的 ETA 本来就是本地估算                                                                                                                           |

## 5. 战略项：recipe 模型管理（本轮不建议接）

上游这套东西的体量：`GET /sdcpp/v1/recipes`、`GET /model-files`、`POST /models/refresh|load|unload`、
`GET /models/status`，108 个内置 recipe，`--model-dir` 可重复，模型可在**同一进程内**换。

**收益**：换模型不用重启进程、不用重新绑端口、不用重跑 CLI 预检；`load_elapsed_seconds`
和 `revision` 能给出可观测的加载进度。

**代价/冲突**：

1. `models/load` 只接受 **`model-files` 返回的文件 ID**（相对模型根），拒绝绝对路径。
   Lumina 现在整套扫描器 + 组件路径（`-m/--vae/--llm/...`）都要改成「传 `--model-dir` + 用 ID」。
2. recipe 是**按任务**切分的（`flux1-canny` / `flux1-depth` / `flux1-fill` 是同一家族的三份
   recipe），Lumina 是**按家族**组织的；直接照搬会把一个家族拆成多个 UI 预设。反过来，
   recipe 里也有 Lumina 有意不支持的槽位（`photo_maker`、`pulid_weights`——上游 `/sdcpp/v1`
   仍未开放身份参数），以及 `features` / `disabled_features` 与 `FAMILY_CONFIG.disabledFeatures`
   两套真相。
3. 一旦走「无模型启动」，`/v1/models` 返回空数组，Lumina 的心跳（`is_sd_server_models_shape`
   要求 `data[0].id == "sd-cpp-local"`）会判不可达；`/sdcpp/v1/capabilities` 在加载期间返回
   503 `model_loading`，需要新增错误分支。
4. Lumina 的卖点之一是「家族必需组件 + 默认值 + 尺寸对齐」，recipe 只覆盖了其中的组件声明，
   默认值还有 20 步上限这类政策差异。

**建议**：本轮只做兼容层——把 503 `model_not_loaded` / `model_loading`、409 `model_busy`、
422 `model_load_failed` 的文案补进 `extractApiError` 的映射（纯前端，0.2 d），不引入
`/models/*` 流程。下一轮再评估「进程内换模型」是否值得用 recipe 的 ID 体系换掉进程重启。

## 6. 工具链：`upstream-diff.mjs` 的四个盲区

本次两个「机器没报、但必须处理」的项，正好对应四类盲区：

1. **只比 key 的增删，不比语义/单位。** 时间戳秒→毫秒在 `api.md` 里只是示例数字变了。
   建议加一条硬检查：扫 `examples/server/runtime.cpp` 里 `unix_timestamp_now_ms`
   是否存在、`api.md` 是否出现 "**milliseconds**"，与对齐提交对比，命中就输出
   「任务时间戳单位已变，检查 types.ts / jobElapsed」。
2. **`KNOWN_UNSUPPORTED` 的理由会腐烂。** 现在 `ad_*` 的理由指向「`/sdcpp/v1` 不消费」。
   建议给每条登记加 `verifiedAt: "<sha>"`，并允许写一条可执行断言（例如
   `assert: "async_jobs.cpp 不含 apply_server_adetailer"`）；断言不成立就报
   「登记理由已过期」，而不是静默 `✓`。
3. **不看 `capabilities.features` 的布尔值变化。** `cancel_generating` 从 `false` 变 `true`
   直接改变了按钮语义。建议把 `routes_sdcpp.cpp` 里两个 `features_json` 的键值快照成
   结构化输出，和上一版对齐号比较。
4. **不看 recipe 与家族默认值的漂移。** 108 个 recipe 是上游给的「组件 + 默认值」机器可读版本，
   但默认值有 20 步上限政策，不能直接当基准。建议做一个**映射表**（family → recipe id，
   只覆盖 40 个左右能对上的），比较 `width/height/cfg/steps/sampler`，输出「差异待人工裁定」，
   而不是自动判定为错误。MiniT2I 的 100 vs 20 就是需要人工裁定的例子。

顺带修两处小问题：

- `scripts/upstream-diff.mjs` 的 `--upstream` 模式在 Windows + 大仓库上会对每个文件
  `git show`，本机实测 3 个文件正常，但整仓 `git grep` 会卡住（blobless clone 逐个取 blob）。
  建议把 `git grep` 换成对已知文件列表的 `git show`。
- `KNOWN_UNSUPPORTED.upscale_repeats` 的理由「界面未暴露」容易被误读：界面里确实有
  「重复次数」（独立放大接口的 `repeats`），但生成请求体的 `upscale_repeats` 是
  hires 二次放大的重复次数，两回事。理由写清楚，避免下一个人删错。

## 7. 验收清单

```bash
# 1. 机器检查（本地克隆，离线）
node scripts/upstream-diff.mjs --upstream <sdcpp> --since d55cc0f --ref 95ff762
node scripts/upstream-diff.mjs --coverage --upstream <sdcpp> --ref 95ff762

# 2. 前端
npm run check:types && npm test && npm run lint
# 3. Rust
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

手工验收（按新内核 `95ff762` 构建的 sd-server）：

| 场景                                       | 期望                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| 完成一个 8–10 s 的任务                     | 任务行与结果卡片显示 `8s`/`9s`，不是 `141m` 或 `0 秒`               |
| 用旧内核（`d55cc0f`）跑同一用例            | 仍显示秒级正确耗时                                                  |
| 生成中取消                                 | 按钮出现；点击后提示「已请求中断」，状态最终 `cancelled`            |
| `--ad-model` 写在附加启动参数              | 面板有提示；生成后结果图确实是修复版（或按 B 选项有显式开关）       |
| Fibo 2.0 Dev 启动                          | 识别为 `fibo2`，组件齐备，1024² / CFG 5 / 20 步                     |
| Fibo 2.0 Edit Turbo                        | 要求参考图，4 步 / CFG 1                                            |
| MiniT2I 改尺寸                             | 界面锁定 512×512，日志无 `align to fixed size` 警告                 |
| 选 TAE + `--taesd-preview-only`            | 预览走 TAE，最终图与非 TAE 一致                                     |
| MiniMax-H3 视频 + 参考图尺寸=max           | 请求体带 `ref_image_args: "ref_image_size=max"`，耗时上升、细节更稳 |
| 配了 `--rpc-servers` 再写 `--backend rpc0` | 不再被前端预检误杀                                                  |

## 8. 建议的提交拆分

1. `fix(jobs): 兼容毫秒级任务时间戳`（P0，含单测；改 types 注释）
2. `fix(jobs): 处理生成中取消的 200 + cancel_requested`（P0）
3. `chore(docs): 更正 ADetailer 裁定与 --model-dir 说明`（P0，含 `args.rs` 的 `ad-model` 路径登记）
4. `feat(ui): TAE 仅用于预览`（P1）
5. `feat(family): Fibo 2.0 Dev / Edit Turbo`（P1）
6. `fix(family): MiniT2I 固定 512×512`（P1）
7. `feat(video): 参考图尺寸与 temporal_decode_frames`（P1/P2）
8. `chore(sync): 对齐号更新到 95ff762`（**放在最后**：先修完再改对齐号，否则脚本会把同一批
   变更反复报出来，也无法用 `--since` 验证）

## 9. 需要上游确认 / 留档的疑点

1. **MiniT2I**：docs 100 步 / CFG 6 vs recipe 20 步 / CFG 2.5。Lumina 保持 docs。
2. **ADetailer 的 `ad_model` 请求字段**：解析但不用于选检测器（只认启动 `--ad-model`），
   `api.md` 没明说，容易让客户端以为能按请求换检测器。建议在 `api.md` 补一句，或本地
   README 记下这个坑。
3. **`--model-dir` 的启动扫描**：`refresh_model_catalog` 对每个根下的类别目录做
   `recursive_directory_iterator`，没有深度/文件数上限，且 `initialize_server_models` 失败会让
   进程退出。Lumina 启动 sd-server 时 cwd 是 exe 目录，如果那里恰好有 `./models`，启动会变慢。
   可考虑在 README 的「启动就退出」一节加一条排查提示。
4. **`ref_image_args` 在 `vid_gen` 里覆盖启动 preset**：服务端把请求字段整体赋值（不是合并），
   所以视频侧一旦发这个字段，就必须把启动期 `preset=…` 一并带上——和 img_gen 现有
   `buildRefImageArgs` 的注意事项完全一致，实现时直接复用该函数。

## 10. 落地状态（2026-10-24）

本轮按 §8 的拆分实施，未创建 git commit：

| 项                      | 状态 | 落点                                                                                                                                                              |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 时间戳毫秒兼容       | 完成 | `toEpochMs` + `jobElapsed` / `elapsedLabel` / `ingestCompletedJob` / 合成放大任务；秒/毫秒双夹具                                                                  |
| P0 生成中取消           | 完成 | `Job.cancel_requested`、`cancelJob` 的「已受理」分支、JobQueue「中断中…」+ 按钮置灰                                                                               |
| P0 ADetailer 裁定更正   | 完成 | README 已知限制、`UPSTREAM-SYNC.md` 裁定表、`KNOWN_UNSUPPORTED` 理由、`args.rs` 把 `ad-model` 纳入路径预检、`validate_args` 老内核拒绝 / 新内核给出自动后处理警告 |
| P1 TAE 仅用于预览       | 完成 | `taesdPreviewOnly`（Settings + 快照 + Rust serde）、`--taesd-preview-only`、控制台开关（未选 TAE 时禁用）                                                         |
| P1 Fibo 2.0 家族        | 完成 | `family.rs` 识别/分类 + 用例、`fibo2` / `fibo2-edit` 两条家族配置、README 清单 62                                                                                 |
| P1 MiniT2I 固定尺寸     | 完成 | `FamilyConfig.fixedSize` + `resolveGenerationSize`、尺寸面板只读展示、提交与参数拉回                                                                              |
| P1 视频参考图尺寸       | 完成 | `ref_image_size` 选择器（MiniMax-H3）、`vid_gen` 透传 `ref_image_args`、字符串键读写工具 + 用例                                                                   |
| P1 Wan 组解码帧数       | 完成 | `temporal_decode_frames` 数字输入（仅 `wan-ti2v`）                                                                                                                |
| P2 `--list-devices` RPC | 完成 | 设备预检在「未找到」时按 `--rpc-servers` 补探一次，失败保留原错误、不误杀                                                                                         |
| P2 工具链               | 完成 | `upstream-diff.mjs` 新增「语义变化」检查：时间戳毫秒、`cancel_generating`、ADetailer 后处理                                                                       |
| P2 `--model-dir`        | 登记 | 继续不接，裁定理由已更新（模型根 + recipe 根 + 文件 ID 基准）                                                                                                     |
| P2 日志 ETA             | 不做 | 仅日志文本；进度条 ETA 仍由前端本地估算                                                                                                                           |
| 战略项 recipe 管理      | 不做 | 只保留对 503 `model_not_loaded` / `model_loading` 等错误码的兼容位（后续如接入再补文案）                                                                          |

验证：`npm run check:types`、目标用例、`cargo clippy --all-targets -- -D warnings`、
`cargo test`（110 passed）均通过；`node scripts/upstream-diff.mjs --since d55cc0f` 现在会同时
报出三条语义变化。

## 附：证据文件清单（上游 `95ff762`）

- `examples/server/api.md`（时间戳单位、取消语义、6 个模型管理端点、recipe 特性声明）
- `examples/server/runtime.cpp` / `runtime.h`（`unix_timestamp_now_ms`、`apply_server_adetailer`、`--model-dir`、`k_max_generation_dimension`）
- `examples/server/async_jobs.cpp` / `.h`（取消监视器、`cancel_requested`、毫秒时间戳）
- `examples/server/routes_sdcpp.cpp`（`cancel_generating=true`、`generation_features`、`runtime`、`display_path`、`custom_sigmas`）
- `examples/server/model_catalog.cpp` / `.h` / `routes_models.cpp`（recipe、模型根、状态机）
- `examples/common/common.cpp`（`--taesd-preview-only`、`--list-devices`+RPC、`custom_sigmas` 空数组语义）
- `examples/cli/main.cpp`（`--taesd-preview-only` 迁移）
- `docs/adetailer.md`、`docs/fibo2.md`、`docs/minimax_h3.md`、`docs/wan.md`、`docs/taesd.md`、`docs/model_config.md`
- `examples/server/recipes/*.json`（108 个，含 `fibo2-dev` / `fibo2-edit-turbo` / `minit2i`）
- `src/pipeline/request.cpp`（MiniT2I 512 硬夹）、`src/model/integrations/fibo2.cpp`（Fibo2 定义）
