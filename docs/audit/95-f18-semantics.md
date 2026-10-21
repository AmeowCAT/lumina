# 95 · F-18 前置研究：`cache_option` / `scm_mask` / SLG 的精确语义

> 目的：给 F-18（缓存与跳层引导缺少可配置控件）提供**可直接照做**的实现依据。
> 上游：`stable-diffusion.cpp` @ `d55cc0f`（本地克隆 `%TEMP%\lumina-audit\stable-diffusion.cpp` 仍在，未使用 web_fetch 兜底）
> 本仓库：`D:\Project\AmeowCAT\lumina` @ 分支 `fix/audit-2026-10`（只读，未改任何代码）
> 本文只回答「参数是什么、控件该长什么样、字段该叫什么」，不重复 F-18 的问题描述。

## 0. 一页速查（每个参数一行）

| 参数           | 上游类型 / 本质                                                                                                                                                             | 建议控件                                                                                  | 取值域 / 校验                                                                                                          | 建议 TS 字段名（请求体键）                                                                                                         | Lumina 现状                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cache_option` | **不是枚举**，是 `key=value` 列表串（逗号分隔，**同名键在不同 cache_mode 下含义不同**）                                                                                     | **结构化子控件**（按 `cache_mode` 动态渲染若干数值/开关），不是纯文本框；底层仍拼成字符串 | 每个键见 §2.2；逗号分隔；**`=` 两侧不能有空格**；未知键 → 400                                                          | `cache_option: string`（保留现有 `GenParams.cache_option`），另加结构化草稿字段 `cacheOptions?: Record<string, number \| boolean>` | 已有请求体发送（`utils.ts:1068`）、**零控件**，只能从 PNG 元数据恢复                                            |
| `scm_mask`     | **字符串**，逗号分隔的 `0/1` 序列（按**步索引**逐位生效，不是布尔、不是路径）                                                                                               | 文本框 + 即时正则校验（或「生成规则」按钮）                                               | `^[01](,[01])*$`；长度 ≤ 步数才有意义；仅 `dbcache`/`taylorseer`/`cache-dit` 生效。**非法内容会让 sd-server 崩溃**     | `scm_mask: string`（保留 `GenParams.scm_mask`）                                                                                    | 已有发送（`utils.ts:1069`）、**零控件**                                                                         |
| SLG            | 数值 `scale`（**0 = 关闭**）+ 整数数组 `layers`（**空 = 关闭**）+ 两个 0..1 的**步数分数** `layer_start`/`layer_end`；bool 形式只存在于 `extra_sample_args` 的 `slg_uncond` | `Slider`（scale）+ `NumberInput`×2（start/end）+ 逗号整数文本框（layers）                 | `scale`: 浮点，任意非 0 生效（0 关）；`layers`: 正整数、**非空**；`layer_start < layer_end`，均在 0..1；DiT 模型才生效 | `sample_params.guidance.slg.{scale,layers,layer_start,layer_end}`（已有 `SlgGuidance`）                                            | 只有 `scale` 滑杆（`AdvancedSamplingPanel.tsx:119-132`），`layers`/`start`/`end` **无处可改**；高噪段完全无控件 |

> 这三项的请求体字段**全都已经接通**（`utils.ts:1016-1029`、`1066-1077`），F-18 的实现量集中在 UI + 校验，不需要动 Rust、不需要动协议层。

## 1. 来源与方法

| 依据                 | 位置                                                                                                                                   | 作用                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 请求体解析器（权威） | `examples/common/common.cpp:2096-2329`（`from_json_str`），其中 cache 分支 `2144-2146`、cache option 解析 `2431-2528`                  | 决定「发什么键、什么类型、什么算错」                                                                     |
| 参数默认值（权威）   | `src/stable-diffusion.cpp:283-309`（`sd_cache_params_init`）、`454-467`（`sd_sample_params_init`）、`examples/common/common.h:236-244` | 决定「不发时内核用什么」                                                                                 |
| 消费端（语义）       | `src/runtime/sample-cache.cpp`、`src/runtime/cache_dit.hpp`、`src/runtime/guidance.cpp`、`src/pipeline/diffusion_engine.cpp`           | 决定「实际怎么用、什么条件下静默失效」                                                                   |
| CLI 帮助文本         | `examples/common/common.cpp:1806-1820`（cache/scm）、`1284-1326`（SLG）、`1778-1784`（skip layers）                                    | 上游自己写下的取值域，对本文件最友好                                                                     |
| 用户文档             | `docs/caching.md:15-149`                                                                                                               | 交叉验证（与源码一致；默认值以 `INFINITY` 哨兵形态存在于结构体，运行期按模式解析成 0.2/1.0，见 §2.2 注） |
| 公开文档             | `examples/server/api.md:569-572`、`954-957`、`1318-1321`                                                                               | **只列了类型，没列取值域**——所以本文的取值域全部来自源码，不来自 api.md                                  |

关键前置事实：`sd-server` 把 `SDGenerationParams::get_options()` 也并入了命令行解析（`examples/server/main.cpp` 的 `parse_args`：`options_vec = { svr_params.get_options(), ctx_params.get_options(), default_gen_params.get_options() }`），而每个请求的起点是 `request.gen_params = *runtime.default_gen_params`（`examples/server/routes_sdcpp.cpp:417`）。**所以这三类参数都有「启动期默认值」和「请求期覆盖」两层**，且请求期总是覆盖启动期（见 §5.3）。

## 2. `cache_option`

### 2.1 它不是枚举，是 `key=value` 逗号列表

- CLI 帮助原文：「named cache params (key=value format, comma-separated). easycache/ucache: threshold=,start=,end=,decay=,relative=,reset=; dbcache/taylorseer/cache-dit: Fn=,Bn=,threshold=,warmup=; spectrum: w=,m=,lam=,window=,flex=,warmup=,stop=」——`common.cpp:1810-1811`。
- 解析实现：`common.cpp:2434-2494`。`std::getline(ss, token, ',')` 按**逗号**切分（`2437`），每段 `token.find('=')` 切键值（`2438`），键值**都不做 trim**（`2443-2444`）。
- 因此：`;` **不是**分隔符（和 `extra_sample_args` 支持 `,`/`;` 两种不同，见 `utils.ts:262`、`321` 的对照实现）；`threshold = 0.3`（`=` 两侧带空格）会得到键 `"threshold "` → 未知键 → 400。

> 唯一「枚举」性质的是**另一个字段** `cache_mode`（`disabled`/`easycache`/`ucache`/`dbcache`/`taylorseer`/`cache-dit`/`spectrum`，校验在 `common.cpp:2496-2515`；Lumina 的 `CACHE_MODES` 已与之逐值对齐：`src/config/families.data.ts:167-175`）。上游 `examples/server/routes_sdcpp.cpp:33-63` 有个 `parse_cache_mode()` 枚举解析函数，**全仓无人调用**，是死代码，不要被它误导。

### 2.2 全部合法键 → 目标字段 → 默认值

解析器写得比 CLI 帮助更宽松：下面 14 个键是**并集**，任何 `cache_mode` 下都接受（写入一个当前模式可能不读的字段）。

| 键（大小写） | 写入字段                                                                   | 默认值（`sd_cache_params_init`）                                                     | 生效模式                     | 源码                                                                                         |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `threshold`  | `easycache`/`ucache` → `reuse_threshold`；其余 → `residual_diff_threshold` | `INFINITY`（**哨兵**：运行期按模式解析成 easycache 0.2 / ucache 1.0，见下） / `0.08` | 全部                         | `common.cpp:2446-2451`、`stable-diffusion.cpp:286,294`、`sample-cache.cpp:5-15`              |
| `start`      | `start_percent`                                                            | `0.15`                                                                               | easycache/ucache             | `common.cpp:2452-2453`、`stable-diffusion.cpp:287`                                           |
| `end`        | `end_percent`                                                              | `0.95`                                                                               | easycache/ucache             | `common.cpp:2454-2455`、`stable-diffusion.cpp:288`                                           |
| `decay`      | `error_decay_rate`                                                         | `1.0`                                                                                | easycache/ucache             | `common.cpp:2456-2457`、`stable-diffusion.cpp:289`                                           |
| `relative`   | `use_relative_threshold`（数值 ≠0 即真）                                   | `true`                                                                               | easycache/ucache             | `common.cpp:2458-2459`、`stable-diffusion.cpp:290`                                           |
| `reset`      | `reset_error_on_compute`（数值 ≠0 即真）                                   | `true`                                                                               | easycache/ucache             | `common.cpp:2460-2461`、`stable-diffusion.cpp:291`                                           |
| `Fn` / `fn`  | `Fn_compute_blocks`（`std::stoi`）                                         | `8`                                                                                  | dbcache/taylorseer/cache-dit | `common.cpp:2462-2463`、`stable-diffusion.cpp:292`                                           |
| `Bn` / `bn`  | `Bn_compute_blocks`（`std::stoi`）                                         | `0`                                                                                  | 同上                         | `common.cpp:2464-2465`、`stable-diffusion.cpp:293`                                           |
| `warmup`     | `mode==spectrum` → `spectrum_warmup_steps`；否则 → `max_warmup_steps`      | `4` / `8`                                                                            | 全部                         | `common.cpp:2466-2471`、`stable-diffusion.cpp:295,307`                                       |
| `w`          | `spectrum_w`                                                               | `0.40`                                                                               | spectrum                     | `common.cpp:2472-2473`、`stable-diffusion.cpp:302`                                           |
| `m`          | `spectrum_m`（`std::stoi`）                                                | `3`                                                                                  | spectrum                     | `common.cpp:2474-2475`、`stable-diffusion.cpp:303`                                           |
| `lam`        | `spectrum_lam`                                                             | `1.0`                                                                                | spectrum                     | `common.cpp:2476-2477`、`stable-diffusion.cpp:304`                                           |
| `window`     | `spectrum_window_size`（`std::stoi`）                                      | `2`                                                                                  | spectrum                     | `common.cpp:2478-2479`、`stable-diffusion.cpp:305`                                           |
| `flex`       | `spectrum_flex_window`                                                     | `0.50`                                                                               | spectrum                     | `common.cpp:2480-2481`、`stable-diffusion.cpp:306`                                           |
| `stop`       | `spectrum_stop_percent`                                                    | `0.9`                                                                                | spectrum                     | `common.cpp:2482-2483`、`stable-diffusion.cpp:308`                                           |
| 其它任意键   | —                                                                          | —                                                                                    | —                            | `LOG_ERROR("unknown cache parameter")` + `return false` → 提交 400（`common.cpp:2484-2487`） |

**不能通过 `cache_option` 调的缓存字段**（只存在于结构体/CLI 之外，无键）：`taylorseer_n_derivatives`=1、`taylorseer_skip_interval`=1、`max_cached_steps`=-1、`max_continuous_cached_steps`=-1（`stable-diffusion.cpp:296-299`）。→ UI 不必为它们留位置。

### 2.3 同名键的语义漂移（实现时必须按模式分派）

这是本节最重要的一条，直接决定控件形态：

| 键                                   | `easycache` / `ucache`           | `dbcache` / `taylorseer` / `cache-dit` | `spectrum`                            |
| ------------------------------------ | -------------------------------- | -------------------------------------- | ------------------------------------- |
| `threshold`                          | → `reuse_threshold`（0.2 / 1.0） | → `residual_diff_threshold`（0.08）    | → `residual_diff_threshold`（用不到） |
| `warmup`                             | → `max_warmup_steps`（8）        | → `max_warmup_steps`（8）              | → **`spectrum_warmup_steps`（4）**    |
| `start`/`end`                        | ✅ 生效                          | ✗ 写入但该模式不读                     | ✗                                     |
| `Fn`/`Bn`                            | ✗                                | ✅ 生效                                | ✗                                     |
| `w`/`m`/`lam`/`window`/`flex`/`stop` | ✗                                | ✗                                      | ✅ 生效                               |

依据：`common.cpp:2446-2483` 的各分支条件 + `sample-cache.cpp:105-146`（只有 CACHEDIT 路径读 `Fn/Bn/residual_diff_threshold/max_warmup_steps`）、`sample-cache.cpp:148-167`（spectrum 路径读 `spectrum_*`）、`sample-cache.cpp:41-97`（easycache/ucache 路径读 `reuse_threshold/start_percent/end_percent`）。

**结论：不要给用户一个「原样写 key=value」的自由文本框**——那等于要求用户背下这张表，而且写错模式（例如 easycache 下去调 `Fn`）会**静默无效果**（不报错，因为键合法）。应按所选 `cache_mode` 渲染对应的 3–7 个带标签控件，由代码拼串。

### 2.4 取值合法性（客户端应当拦下的）

| 规则                              | 上游行为                                                                                                                                                                                     | 建议校验                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 数值解析                          | `std::stof` / `std::stoi`，包在 `try/catch` 里（`common.cpp:2488-2491`），失败 → 400 `invalid generation parameters`                                                                         | 客户端先转成数字再拼串，永不发出非法字面量                              |
| `threshold`（easycache/ucache）   | `validate()`：`reuse_threshold < 0` → 400（`common.cpp:2611-2616`）                                                                                                                          | `>= 0`，推荐滑杆 0–3、step 0.05                                         |
| `threshold`（dbcache 系）         | 无范围校验                                                                                                                                                                                   | `>= 0`，推荐 0–1、step 0.01                                             |
| `start`/`end`（easycache/ucache） | 400 要求 `0 <= start < end <= 1`（`common.cpp:2617-2622`）；运行期还有一道静默兜底 `has_valid_cache_percent_range` → 只打 LOG_WARN 并**整体禁用缓存**（`sample-cache.cpp:29-39`、`185-190`） | 两个滑杆 0–1 step 0.01，联动保证 `start < end`（提交前仍校验一次）      |
| `decay`                           | 文档 0–1（`docs/caching.md:41`），代码无校验                                                                                                                                                 | 滑杆 0–1 step 0.05                                                      |
| `relative`/`reset`                | 数值 ≠ 0 即真（`common.cpp:2458-2461`），**`std::stof` 所以 `relative=true` 会抛异常→400**                                                                                                   | 用开关，拼成 `0`/`1`（**不要拼 true/false**）                           |
| `Fn`/`Bn`                         | `std::stoi` → `warmup=4.5` 会被截成 4（`stoi` 不报错）                                                                                                                                       | 整数输入框，≥0；`Fn` 推荐 0–32，`Bn` 推荐 0–32                          |
| `w`/`flex`/`stop`/`lam`           | 无校验                                                                                                                                                                                       | `w` 0–1 step 0.01；`flex` 0–2 step 0.05；`stop` 0–1 step 0.01；`lam` >0 |
| `m`/`window`                      | `stoi`                                                                                                                                                                                       | 整数 `m` 1–8、`window` 1–16                                             |
| 空串 / 尾随逗号                   | `cache_option=""` 合法（表示不覆盖，`common.cpp:2517`）；**尾随逗号**被 `getline` 吞掉，无害；**连续逗号**产生空段 → 缺 `=` → 400（`common.cpp:2439-2442`）                                  | 由代码拼串天然规避                                                      |

> 注：`docs/caching.md:38` 写 ucache `threshold` 默认 1.0、`:64` 写 easycache 0.2 —— 与实现一致，但那是 `INFINITY` **哨兵在运行期按模式解析**出来的值（`sample-cache.cpp:5-15`），不是 `sd_cache_params_t` 的出厂值（`INFINITY`）。UI 显示默认值时应显示 1.0 / 0.2，不要显示 `inf`。

### 2.5 生效条件

1. `cache_mode` 必须是 6 个非 `disabled` 之一；`cache_option` 在 `cache_mode=disabled` 时**仍会被解析**（`common.cpp:2517` 无条件），所以把 `cache_option` 留着而关掉 `cache_mode` 不会有副作用，但也没有意义。
2. 模式与模型架构不匹配时**静默失效**（只有日志）：`init_easycache_runtime` 要求 DiT（`sample-cache.cpp:45-48`）、`init_cachedit_runtime` 要求 DiT（`sample-cache.cpp:108-111`）、`init_spectrum_runtime` 要求 UNET 或 DiT（`sample-cache.cpp:152-155`）；ucache 只对 UNET 有意义（`docs/caching.md:19`）。→ UI 应在选中模式后给出「该模式对当前模型家族可能不生效」的提示。

### 2.6 建议实现（字段 + 控件）

```
GenParams（已有 cache_mode / cache_option）
+ cacheOptions?: {              // 结构化草稿，纯粹是 UI 中间态，不直接进请求体
    threshold?: number; start?: number; end?: number; decay?: number;
    relative?: boolean; reset?: boolean;
    Fn?: number; Bn?: number; warmup?: number;
    w?: number; m?: number; lam?: number; window?: number; flex?: number; stop?: number;
  }
→ 发送前由 buildCacheOption(cache_mode, cacheOptions) 拼成 cache_option 字符串
```

- 控件：`AdvancedSamplingPanel` 在「缓存」`Select`（现 `AdvancedSamplingPanel.tsx:309-319`）下方，按 `cache_mode` 条件渲染 3–7 个 `Slider`/`NumberInput`/`Toggle`。
- 「恢复默认」按钮：清空 `cacheOptions` → 不发 `cache_option`（让内核用哨兵默认），而不是把默认值显式写进串。
- 反向解析（PNG 元数据恢复）：元数据只写 `requested_option` 原文（`common.cpp:3180`），因此需要一个 `parseCacheOption(string) -> cacheOptions` 的对称函数，把串拆回控件；解析不了的键**保留原串**（类似 `parseExtraSampleArgs` 的 `utils.ts:302-345` 策略）。
- 建议新增纯函数放在 `src/lib/utils.ts`（与 `buildExtraSampleArgs` 同区），并配单测：三组模式的键集合、空格/非法值拒绝、`relative/reset` 输出 `0/1`。

## 3. `scm_mask`

### 3.1 类型与语法

- 类型：**字符串**（`std::string scm_mask`，`common.h:243`；JSON 键 `scm_mask` 是 string，`api.md:571`）。**不是 bool，不是路径。**
- 语法：逗号分隔的 `0/1` 整数序列，`1 = 该步计算`、`0 = 该步可缓存`（CLI 原文 `common.cpp:1814-1815`，文档同 `docs/caching.md:107-113`）。
- 解析：`parse_scm_mask()`（`src/runtime/cache_dit.hpp:558-575`）按 `,` 切分后 `std::stoi(token)` 直接入 `vector<int>`。
- 长度**不必等于步数**：消费端只在 `step_index < mask.size()` 时按索引取值（`cache_dit.hpp:260-262`、`744-746`），**短于步数时后面的步不受掩码约束**，长于步数时多余项被忽略。→ 不报错、不补全，UI 不必强制长度。
- 语义是**按步索引逐位对应**（第 k 位管第 k 步），不是「模式重复」。

### 3.2 生效条件（很窄）

| 条件                         | 依据                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仅 `cache-dit` 路径消费      | `sample-cache.cpp:122-123` 只在 `init_cachedit_runtime` 里调用；该函数仅由 `mode ∈ {dbcache, taylorseer, cache-dit}` 触发（`sample-cache.cpp:196-203`，与 `dbcfg.enabled` 的 `:115` 一致） |
| 非空才用                     | `sample-cache.cpp:122`：`scm_mask != nullptr && strlen(...) > 0`                                                                                                                           |
| 与 `scm_policy_dynamic` 联用 | `cache_dit.hpp:260-262` 决定该步是否「允许缓存」；policy 再决定「允许缓存时是否还要过阈值」                                                                                                |

→ `cache_mode` 为 `easycache`/`ucache`/`spectrum` 时给 `scm_mask` 填什么都没用（也不会崩，因为根本不会被解析）。UI 应只在三个 block-level 模式下显示该输入框。

### 3.3 ⚠️ 非法内容会让 sd-server 崩溃（本文件最高优先级的实现约束）

- `parse_scm_mask` 直接 `std::stoi(token)`，**无 try/catch**（`cache_dit.hpp:565-572`）。非数字（`1,x,0`）、空段（`1,,0`）、超范围都会抛 `std::invalid_argument`/`std::out_of_range`。
- 调用链：`generate_image()` → `diffusion_engine.cpp:2474` `init_sample_cache_runtime()` → `init_cachedit_runtime()` → `parse_scm_mask()`。
- 该代码跑在**工作线程**里：`examples/server/main.cpp:119` `std::thread async_worker(async_job_worker, ...)`，而 `examples/server/async_jobs.cpp` 全文**没有任何 try/catch**（该文件 grep `try|catch` 零命中），`execute_img_gen_job`（`async_jobs.cpp:228-293`）也没有。
- 结论：`std::thread` 里逸出的异常 → `std::terminate()` → **整个 sd-server 进程消失**，任务队列、模型全部丢失，Lumina 侧只会看到所有轮询 404/连接失败。
- 对比：`cache_option` 的 `std::stof` 有 try/catch（`common.cpp:2488-2491`）→ 400；`scm_mask` 没有 → 崩溃。**两者的健壮性完全不同，不能用同一种「随便填，服务端会校验」的心态处理。**

**客户端必须硬校验**：`/^[01](,[01])*$/`（不允许空格、空段、其它数字）。建议在 `onChange` 就地校验并禁用「生成」，而不是等 400（这个场景等不到 400，服务端会先死）。

### 3.4 `scm_policy_dynamic`：请求体里是死键，只有启动参数能用

- 请求体解析器**没有**这个键：`common.cpp:2144-2147` 只读 `cache_mode`/`cache_option`/`scm_mask`/`ref_image_args`。`api.md:821`、`957`、`1180` 把它列为请求字段属**上游文档错误**。
- 真实开关：CLI `--scm-policy dynamic|static`（`common.cpp:1818-1820`），解析器 `common.cpp:1641-1655`（只接受 `dynamic`/`static`，其它值 → 报错并中止启动）；默认 `true`（`stable-diffusion.cpp:301`）。
- 两种策略的实际差别（若将来要做成启动参数，文案得说清）：`dynamic` = 掩码标记「可缓存」的步**仍要过阈值检查**；`static` = 掩码标记「可缓存」的步**直接跳过计算**（`cache_dit.hpp:262-267`：`can_cache_this_step = true; return;`）。`static` 画质风险明显更高，与 `docs/caching.md:115-119` 的描述一致。
- Lumina 现状 **正确**：显式不发送该键，并在注释里写明了原因（`utils.ts:1070-1073`）。→ F-18 不要给 `scm_policy_dynamic` 做请求体控件；若要做，只能做成**启动参数**（见 §5.3 的覆盖风险）。

### 3.5 建议实现

```
GenParams.scm_mask: string（已有）
```

- 控件形态：`TextInput` + 右侧「校验状态」。占位符示例：`1,1,1,1,0,0,1,0,0,0,1,0`（取自 `docs/caching.md:110`）。
- 校验：`^[01](,[01])*$`；长度提示「与实际步数一致才有意义（当前 N 步）」，仅提示不阻断。
- 可选增强：一个「按模式生成掩码」的小弹层（输入「计算段/缓存段」交替长度，如 `1,2,1,3` → 展开成对应长度的 0/1 串）。上游有一个 `generate_scm_mask(compute_bins, cache_bins, total_steps)`（`cache_dit.hpp:577-606`）可作蓝本：**最后一步强制为 1**（`:601-603`）。
- 只在 `cache_mode ∈ {dbcache, taylorseer, cache-dit}` 时渲染（§3.2）。

## 4. SLG（skip layer guidance）

### 4.1 上游的真实参数名与形态

| 通道                | 参数                                                                                                                 | 形态                                                                 | 依据                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| JSON 请求体         | `sample_params.guidance.slg.scale`                                                                                   | float，**0 = 关闭**                                                  | `common.cpp:2258-2260`                                                                                          |
| JSON 请求体         | `sample_params.guidance.slg.layer_start` / `layer_end`                                                               | float（**总步数分数 0..1**，不是步号）                               | `common.cpp:2252-2257`                                                                                          |
| JSON 请求体         | `sample_params.guidance.slg.layers`                                                                                  | `array<integer>` → **写入独立的 `skip_layers`**，不是 slg 结构体字段 | `common.cpp:2249-2251`、`2738-2741`                                                                             |
| JSON 请求体         | `high_noise_sample_params.guidance.slg.*`                                                                            | 同上（高噪阶段，用于 Wan/Hunyuan 这类双 DiT）                        | `common.cpp:2268-2274`                                                                                          |
| `extra_sample_args` | `slg_uncond=true\|false`                                                                                             | bool（唯一真正的「开关」形式）                                       | `src/runtime/guidance.cpp:55-65`；字面量接受 `1/true/yes/on` 与 `0/false/no/off`（`src/core/util.cpp:553-568`） |
| CLI                 | `--slg-scale`（默认 0）、`--skip-layer-start`（0.01）、`--skip-layer-end`（0.2）、`--skip-layers`（默认 `[7,8,9]`）  | float/int/list                                                       | `common.cpp:1284-1294`、`1778-1780`                                                                             |
| CLI（高噪）         | `--high-noise-slg-scale`、`--high-noise-skip-layer-start`、`--high-noise-skip-layer-end`、`--high-noise-skip-layers` | 同上                                                                 | `common.cpp:1316-1326`、`1782-1784`                                                                             |

- **没有 `--slg` 这种布尔开关**，也没有 `--skip-layer-guidance`。名字是 `--slg-scale`（缩放）而不是 `--slg`（开关）——搜索上游时别按 `--slg` 精确定位。
- 出厂默认（`stable-diffusion.cpp:459-462` + `common.h:236`）：`scale=0`、`layer_start=0.01`、`layer_end=0.2`、`layers=[7,8,9]`。

### 4.2 取值域与生效条件（实现时的硬约束）

| 约束                        | 行为                                                                                                                        | 依据                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `scale == 0`                | 关闭（`has_skiplayer` 为假）                                                                                                | `diffusion_engine.cpp:2490`                         |
| `scale != 0`                | 生效，**负值也算非 0**（符号会翻转修正方向；上游不拦）                                                                      | 同上；`2924`                                        |
| `layers` 为空               | **关闭**（即使 scale != 0）                                                                                                 | `diffusion_engine.cpp:2490`、`guidance.cpp:309-311` |
| 模型不是 DiT                | **静默失效** + 一条 LOG_WARN「SLG is incompatible with this model type」                                                    | `diffusion_engine.cpp:2491-2494`                    |
| 生效步数窗口                | `start_step = int(layer_start * N)`、`stop_step = int(layer_end * N)`，仅 `start_step < step < stop_step`（**严格不等号**） | `guidance.cpp:313-315`                              |
| `layer_start >= layer_end`  | 永不生效（无报错）                                                                                                          | 同上                                                |
| `layer_start/end` 超出 0..1 | `<0` → 从第 0 步就开；`>1` → 直到最后一步（换算后自然成立）                                                                 | 同上                                                |
| `layers` 语义               | 直接作为「跳过的 block 索引」传给 `run_condition`，索引原点由内核定义（默认 [7,8,9] 是 SD3.5-medium 的经验值）              | `diffusion_engine.cpp:2505-2508`、`2927-2932`       |

CLI 帮助里「a value of 2.5 is nice for sd3.5 medium」（`common.cpp:1285`）就是唯一的官方量纲提示——即 `scale` 的实用区间大约 1–3，不是 0–100 那种大尺度。

### 4.3 高噪段（vid_gen）现状

- 上游支持 `high_noise_sample_params.guidance.slg.*`（`common.cpp:2268-2274`）。
- Lumina 的 `HighNoisePanel.tsx` **完全没有 SLG 控件**（grep `slg|SLG|layer` 零命中），而 `utils.ts:1103-1110` 仍然会发 `{scale:0}`（或展开一个永远不带 layers 的对象）。→ 高噪 SLG 目前不可达，且**发出去的 `{scale:0}` 会把服务端启动的 `--high-noise-slg-scale` 覆盖成关闭**（见 §5.3）。

### 4.4 建议实现（控件 + 字段）

```
SampleParams.guidance.slg（已有 SlgGuidance: layers?/layer_start?/layer_end?/scale）
HighNoiseSampleParams.guidance.slg（同结构，已有类型）
```

| 控件                        | 绑定                                                | 取值/校验                                  | 备注                                                                                                                                     |
| --------------------------- | --------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Slider`「SLG 强度」        | `...slg.scale`                                      | 0–10、step 0.1，**0 = 关闭**               | 已有（`AdvancedSamplingPanel.tsx:119-132`），文案建议补「0 关闭；SD3.5-medium 约 2.5」                                                   |
| `NumberInput`「起始步比例」 | `...slg.layer_start`                                | 0–1、step 0.01、默认 0.01                  | 新增；与 end 联动校验 `start < end`                                                                                                      |
| `NumberInput`「结束步比例」 | `...slg.layer_end`                                  | 0–1、step 0.01、默认 0.2                   | 新增                                                                                                                                     |
| `TextInput`「跳层列表」     | `...slg.layers`                                     | `/^\d+(,\d+)*$/`，每项 0–255，默认 `7,8,9` | 新增；解析成 `number[]`；空串 = 不发该键（**不要发 `[]`，那等于关闭 SLG**）                                                              |
| `Toggle`「无条件 SLG」      | `sample_params.extra_sample_args` 里的 `slg_uncond` | `1/0`                                      | 可选；属 `extra_sample_args` 自由文本管辖，若做开关需与现有文本框合并（`buildExtraSampleArgs` 的 `utils.ts:272-298` 已支持自由文本兜底） |

同时建议把 `AdvancedSamplingPanel` 的 SLG 区做成「仅 DiT 家族显示」：家族层已有 `DISTILL_FAMILIES` 这样的判别表（`src/config/families.data.ts:182`，配注释说明每个家族的引擎判别依据），可仿照新增 `SLG_FAMILIES`（SD3/SD3.5/Flux/… 里的 DiT 家族）。若不做家族限制，至少加一行提示「非 DiT 模型上会被内核静默忽略」（`diffusion_engine.cpp:2491-2494`）。

## 5. Lumina 现状核对

### 5.1 请求体：三项**都已接通**，只缺 UI

| 项                              | 发送位置                         | 触发条件                                            | 结论                                                                                                                                                                |
| ------------------------------- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache_mode`                    | `src/lib/utils.ts:1066-1076`     | 恒发；非 disabled 时发所选值，否则显式 `"disabled"` | ✅ 完整；`Select` 已列全 7 个模式（`AdvancedSamplingPanel.tsx:309-319` + `families.data.ts:167-175`）                                                               |
| `cache_option`                  | `src/lib/utils.ts:1068`          | 仅 `cache_mode !== "disabled"` 且非空               | ⚠️ 仅能由「PNG 元数据恢复」写入（`utils.ts:824`）或手改 localStorage；**无控件**                                                                                    |
| `scm_mask`                      | `src/lib/utils.ts:1069`          | 同上且非空                                          | ⚠️ 同上（`utils.ts:825`）；**无控件、无校验 → 崩溃风险见 §3.3**                                                                                                     |
| `scm_policy_dynamic`            | 显式不发（`utils.ts:1070-1073`） | —                                                   | ✅ 与上游解析器一致（正确）                                                                                                                                         |
| `slg.scale`                     | `src/lib/utils.ts:1016-1028`     | `scale > 0` 发完整对象，否则发 `{scale:0}`          | ⚠️ 只支持正数（上游允许负值）；已有滑杆                                                                                                                             |
| `slg.layers`                    | `src/lib/utils.ts:1019`          | `slg.layers \|\| [7,8,9]`                           | ⚠️ caps 默认值会带真实 `layers`（`routes_sdcpp.cpp:117`），所以通常不是硬编码；但**caps 缺键时会用 [7,8,9] 覆盖服务端 `--skip-layers`**，建议改为「缺省则省略该键」 |
| `slg.layer_start` / `layer_end` | `src/lib/utils.ts:1020-1021`     | `?? 0.01` / `?? 0.2`                                | ⚠️ 同类型：**无控件**，靠 caps 默认值                                                                                                                               |
| 高噪 SLG                        | `src/lib/utils.ts:1103-1110`     | 恒发 `{scale:0}`                                    | ⚠️ 完全不可达（无控件）                                                                                                                                             |

### 5.2 启动参数：三项都**没有结构化控件**，但可通过「额外参数」透传

- `src-tauri/src/args.rs` 中**零命中** cache/scm/slg（grep 无结果）；`build_args` 是通用拼装器：除 `--listen-ip/--listen-port` 被硬拦（`args.rs:214-219`）外，其余键原样输出，`extra_args` 字符串先分词再追加到最后（`args.rs:195-233`）。
- `src/lib/launchConfig.ts` 里与缓存相关的只有 `--conditioning-cache-size`（`launchConfig.ts:141-165`），那是**条件结果缓存**，与本节三个参数无关（见 `docs/caching.md:5-13`）。
- 因此「额外启动参数」里手写 `--cache-mode easycache --slg-scale 2.5` 是**能启动**的。但这引出一个必须写进 UI 文案的坑 ↓

### 5.3 ⚠️ 请求体永远覆盖启动参数（会让「启动期设置」看起来无效）

`routes_sdcpp.cpp:417` 每个请求都从 `*runtime.default_gen_params` 拷贝，`from_json_str` 再用请求值覆盖。而 Lumina 恒发：

- `cache_mode`：非启用时显式发 `"disabled"`（`utils.ts:1074-1076`，注释是对的）→ **启动参数 `--cache-mode easycache` 会被每条请求打回 disabled**；
- `slg`：恒发 `{scale:0}`（`utils.ts:1028`）→ **启动参数 `--slg-scale 2.5` 会被打回 0**；
- 高噪：恒发 `{scale:0}`（`utils.ts:1110`）→ **`--high-noise-slg-scale` 同理**。

结论（写进 F-18 的实现说明）：这三项**必须以请求体控件为主**，不要指望启动参数；若保留启动参数写法，UI 需要提示「界面会覆盖启动值」。这也反过来说明 F-18 做请求体控件的方向是**唯一正确**的。

## 6. 实现清单（按文件）

| #   | 文件                                                         | 改动                                                                                                                                                                                                                          | 说明                                                                                               |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `src/lib/utils.ts`                                           | 新增 `buildCacheOption(mode, opts): string \| undefined`、`parseCacheOption(str)`、`validateScmMask(str): string \| null`、`parseLayers(str): number[] \| undefined`；`buildRequestBody` 的 cache 段改为用 `buildCacheOption` | 纯函数，便于单测；与既有 `buildExtraSampleArgs`/`parseExtraSampleArgs`（`utils.ts:272-345`）同风格 |
| 2   | `src/lib/utils.ts:1019-1021`                                 | `slg.layers/layer_start/layer_end` 改为「有值才发」，缺省省略，不再硬编码兜底                                                                                                                                                 | 避免用 [7,8,9]/0.01/0.2 覆盖服务端启动值；与 `cache_option` 的「留空 = 用内核默认」策略一致        |
| 3   | `src/types.ts`                                               | `GenParams` 加 `cacheOptions?: CacheOptions`（UI 草稿，见 §2.6）；给 `SlgGuidance` 补注释说明 0/空 = 关闭                                                                                                                     | 类型层改动最小                                                                                     |
| 4   | `src/config/families.data.ts`                                | 新增 `CACHE_OPTION_FIELDS: Record<cacheMode, FieldSpec[]>`（标签/字段名/类型/最小/最大/步长/模式专属），供 UI 渲染与校验共用                                                                                                  | 一处定义、UI 与 `buildCacheOption` 共用，避免两处漂移                                              |
| 5   | `src/components/generation/panels/AdvancedSamplingPanel.tsx` | 缓存模式下动态渲染 `CACHE_OPTION_FIELDS`；`scm_mask` 文本框（仅三个 block 模式）；SLG 补 start/end/layers                                                                                                                     | 现有「缓存」Select 之后                                                                            |
| 6   | `src/components/generation/panels/HighNoisePanel.tsx`        | 补高噪 SLG 的 4 个控件（复用同一份 SLG 子组件）                                                                                                                                                                               | 现在完全没有                                                                                       |
| 7   | `src/lib/__tests__/utils.test.ts`                            | 新增：三组模式的键集合、`relative/reset` 输出 `0/1`、未知/空格/非法值拒绝、`scm_mask` 正则、SLG 缺省省略                                                                                                                      | 与 §2.4、§3.3 一一对应                                                                             |

**不需要改**：`src-tauri/**`（无 Rust 侧参与）、`src/api.ts`（命令不变）、`launchConfig.ts`（除非决定把 `scm_policy_dynamic` 做成启动参数，见 §3.4）。

## 7. 风险与待验证

1. **`scm_mask` 崩溃可用性影响（P0 级，需写进实现验收）**：仅当 `cache_mode ∈ {dbcache,taylorseer,cache-dit}` 且 `scm_mask` 含非数字/空段时触发（`cache_dit.hpp:565-572` + `main.cpp:119` + `async_jobs.cpp` 无 try/catch）。**未实际构造崩溃用例验证**（本轮只读源码、未运行内核）；建议实现时先按 §3.3 硬校验，把风险消灭在客户端。
2. **`layers` 索引原点未定**：`run_condition(..., &skip_layer_guidance.layers())`（`diffusion_engine.cpp:2927-2932`）内部怎么用这些索引（0 起/1 起、是否对 block 数取模）未继续追到 block 层实现。UI 只需原样透传整数，**不要**自行 +1/-1；文档里也不要写「第几层」这类会被解读的话术，用「跳层索引（默认 7,8,9）」。
3. **`cache_options` 的反向解析边界**：元数据 `cache.requested_option` 是用户原样输入的回显（`common.cpp:3180`），历史 PNG 里可能存着旧内核接受的键；解析失败时应**保留原串并提示**，不要静默丢弃（否则「恢复参数」会悄悄改掉缓存设置）。
4. **`cache_mode` 与 caps 的联动**：`capabilities.defaults_by_mode[*].cache_mode` 来自服务端启动值（`routes_sdcpp.cpp:159`），若服务端以 `--cache-mode easycache` 启动，Lumina 首次进界面会显示 easycache（因为 params 从 caps 初始化）——但一旦用户没动过缓存、提交时 `params.cache_mode` 就是 `"easycache"`，此时 `cache_option` 为空、`scm_mask` 为空，行为正确。此路径未实测，建议实现后加一条回归用例。
5. **高噪 SLG 的实际收益**：上游只说明 `--high-noise-slg-*` 存在，未在任何 `docs/*.md` 给出推荐值。做控件时不要给「推荐值」文案，只给范围。
