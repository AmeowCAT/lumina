# 流光 Lumina 全面审查报告（总报告）

> 审查对象：`D:\Project\AmeowCAT\lumina`，git `master` @ `d442371`，版本 `0.8.6`
> 审查日期：2026-10-18
> 上游基准：`leejet/stable-diffusion.cpp` @ `d55cc0f`（2026-10-18）、上游官方 GUI `leejet/sdcpp-webui`（MIT）
> 分领域详细报告见同目录 `10-` `20-` `30-` `40-` `50-` `60-` 六份文件；本文件是**决策层**，只做结论、排序与路线图。

---

## 0. 执行摘要

### 0.1 一句话判断

**代码质量与文档质量都在同类项目之上，真正的问题不是"bug 多"，而是"与上游高速漂移的同步成本没有工程护栏"，外加若干"宣称支持但实际不生效 / 数据会丢"的具体缺陷。**

前端 `tsc --noEmit` 零错误、`any` 零处、363 个测试全通过、最大 chunk 145 kB；Rust 侧 `cargo clippy` 除 2 条外零命中、89 个测试通过、设置写入做了 `ReplaceFileW(WRITE_THROUGH)` 级别的原子化。这些不是"看起来还行"，而是明显高于同类 Tauri 桌面客户端的平均水平。

问题集中在三个方向：
1. **10 条 P1 里有 5 条属于"静默无效"**——界面说成功，实际不生效或结果不对，且都没有任何报错：PuLID/PhotoMaker 死组件、`distilled-sd` 错误默认值、`-l` 绕过监听守卫、animated WebP 黑屏、LoRA 元数据回填永不匹配。这类问题最伤信任，也最难排查。
2. **上游漂移没有任何自动化护栏**：60 个家族、156 个 CLI 参数、约 30 个请求体字段、8 组"同一事实写两遍"的结构，全靠人工跟随；上游 README 自己写着 "API and command-line option may change frequently"，实测一天 3 个提交。
3. **没有任何 CI**：`cargo fmt` 不通过、`clippy -D warnings` 不通过、lockfile 已被手改过、当前版本连 git tag 都没有。

### 0.2 结论计数

| 组 | 报告 | P0 | P1 | P2 | P3 | 合计 |
|---|---|---:|---:|---:|---:|---:|
| Rust 后端与 Tauri 安全边界 | `10-backend-rust.md` | 0 | 2 | 12 | 8 | 22 |
| 前端架构 / 状态 / 性能 / 内存 | `20-frontend-arch.md` | 0 | 1 | 11 | 5 | 17 |
| 上游 HTTP API 协议对齐 | `30-api-alignment.md` | 0 | 3 | 6 | 2 | 11（另 1 条附带） |
| CLI 参数覆盖 / 家族数据 | `40-cli-families.md` | 0 | 2 | 5 | 3 | 10（另 3 条更正/信息） |
| 交互 / 无障碍 / 国际化 / 同类 GUI | `50-ux-a11y.md` | 0 | 2 | 14 | 7 | 23 |
| 构建 / 依赖 / 测试 / 发布 / 文档 | `60-build-test.md` | 0 | 0 | 6 | 11 | 17 |
| **合计** | | **0** | **10** | **54** | **36** | **100**（另 4 条更正/附带） |

没有 P0：没有任何一条会"打开即崩、必丢数据、必失败"。10 条 P1 里 5 条是"用户会以为成功但结果不对"（静默无效），2 条是安全/数据边界的自指问题，3 条是"界面直接不可用或数据整批丢失"。

### 0.3 必须立刻处理的 9 条（建议下一个补丁版全部修完）

| # | 问题 | 级别 | 位置 | 修法成本 |
|---|---|---|---|---|
| 1 | `--listen-ip` 守卫漏了上游短别名 `-l`：把 `-l 0.0.0.0` 粘进「附加启动参数」即可让 sd-server 无鉴权对局域网开放，而界面仍写"监听 127.0.0.1" | **P1** | `src-tauri/src/server.rs:256` | 3 行 + 1 个测试 |
| 2 | `dir_is_within` 的白名单根 `output_dir` 由 webview 自己经 `save_settings` 改写；配合无扩展名白名单的 `save_output` 与"文件名以 sd-server 开头即免探测"的 `start_server`，构成 任意写 → 任意执行 链 | **P1** | `lib.rs:375` / `save.rs:62` / `server.rs:1242` | 约 30 行（三选一即可破链） |
| 3 | PuLID / PhotoMaker 在 sd-server 面是**死组件**（身份参数是生成级参数，`examples/server/**` 零引用），且挂错家族；用户看到"检查单全绿、启动成功、出图"，但身份注入永不发生 | **P1** | `families.ts:640-641,683-684` | 删除组件位或降级为 NO-GO，约 20 行 |
| 4 | `distilled-sd` 默认 `1 步 / CFG 1 / 512²` 只对 SDXS 成立；SSD-1B / Vega / tiny-SD 用户一进生成页就被填错参数，出糊图且无报错 | **P1** | `families.ts:1846-1857` | 改 3 个默认值 + 提示，约 5 行 |
| 5 | 生成结果只在内存：关窗、`Ctrl+R`、WebView 崩溃、内存预算淘汰任一发生即整批丢失；后端 `save_output` 已现成，只缺"完成后自动落盘"策略 | **P1** | `store.ts` / `README.md:113` | 约 40 行（新增 `autoSaveResults`） |
| 6 | 提示词无 token 计数，Iris-3B 300 token 处**静默截断**；用户无从判断"为什么后半句没生效" | **P1** | `PromptDock.tsx:111-119` | 约 30 行 |
| 7 | `vid_gen` 的 animated WebP（`mime_type: image/webp`）被无条件塞进 `<video>` → **永远黑屏、无报错**；而「编译了 libwebp 但没 libwebm」的内核会把 webp 当作**默认视频格式**发放，用户不改任何设置就会踩到（AVI 同理） | **P1** | `ResultsGrid.tsx:404-418,734-748` | 约 40 行（按 `mime_type` 选渲染器） |
| 8 | 从 PNG 元数据恢复 LoRA **永远匹配不上**：元数据写含扩展名的文件名，capabilities 给的是 stem，代码用 `name === name` 比较 → 所有 LoRA 被静默丢弃；测试假数据两侧写成一样，绿灯掩盖 | **P1** | `utils.ts:670`；固化了错误假设的测试 `utils.test.ts:1152-1170` | 2 行 + 改测试夹具 |
| 9 | capabilities 存在但缺 `defaults_by_mode`/`current_mode`（旧内核、裁剪响应、魔改内核）→ 生成界面 `return null` → **白屏且零提示**；`App.tsx` 的兜底只覆盖"caps 拉取失败"，不覆盖"HTTP 200 但形状不同" | **P1** | `GenerationUI.tsx:284-292,1003`、`App.tsx:117-125` | 约 20 行（补 fallback 链） |

> 另有一条同级的"确定性泄漏"：历史画廊 512 MB 视频 blob 缓存在组件卸载时从不 `revokeObjectURL`，而它每次切 tab 都会卸载 → 每切一次永久泄漏一次（`HistoryGallery.tsx:341,367,574`，对照 `useBlobUrlCache.ts:109-116` 已有正确写法）。修法 10 行，建议并入本批。

---

## 1. 审查方法

### 1.1 基准

| 基准 | 用途 |
|---|---|
| `stable-diffusion.cpp` @ `d55cc0f`（浅克隆到 `%TEMP%\lumina-audit`） | CLI 参数（`examples/common/common.cpp` 156 个长选项）、`/sdcpp/v1` 协议（`examples/server/routes_sdcpp.cpp` + `api.md` 46 KB）、家族必需权重（`docs/*.md` 60 余份） |
| `sdcpp-webui`（上游 2026-04 起内嵌的官方 web UI，Vue 3 / MIT） | 同一协议的**第三个独立实现**，用于三方交叉核对字段，以及"能力驱动表单 vs 手写家族表"的架构对照 |
| A1111 / ComfyUI / InvokeAI / SwarmUI / sd.cpp-webui | 只作 UX 与产品能力对照，判断"缺的这个功能对 sd.cpp 用户是否真有用" |

**上游漂移量已实测**：Lumina README 声明对齐 `f0aac52`（10-17），上游此后又有 3 个提交（`95b3090` MOSS 拆分 QKV、`ab8d5ea` Diffusers 格式 MiniMax-H3 LoRA、`d55cc0f` 文档）。结论：**这 3 个提交都不需要界面改动**，但正好说明漂移频率——一天 3 个提交。

### 1.2 分工与规则

6 个小组并行，写入边界互斥（各写自己那份报告）；构建类命令按组独占（`cargo` 归后端组、`npm/npx/vitest/vite` 归工程组），避免抢 `target/` 与 `node_modules` 锁。每条结论必须给 `文件:行号` 证据；无证据的推测单列「待验证假设」，不混入正式结论。

### 1.3 Lead 的独立抽检

为防止"读代码读出来的幻觉"，我对各组的关键结论做了 11 处独立复核（详见附录 B），包括：

- `-l` 短别名：上游 `examples/server/runtime.cpp:193` 确为 `{"-l","--listen-ip",...}`，而 `server.rs:250-265` 只判 4 种长名写法 → **成立**；
- devtools：上游依赖源码 `tauri-runtime-wry-2.11.2/src/lib.rs:5211` 确为 `with_devtools(webview_attributes.devtools.unwrap_or(true))` → **发布包确实带 Inspector**；
- 家族数：`FAMILY_CONFIG` 实为 61 键 = 60 家族 + `custom`，README 写 58 → **成立**；
- blob 泄漏：`HistoryGallery.tsx` 全文无卸载 revoke，`GenerationUI.tsx:1109` 的 `AnimatePresence` 按 tab key 切换会卸载它 → **成立**；
- `parse_png_metadata`：全库仅 `api.ts:98` 一处定义、零调用方 → **成立**；
- `useKeyboardShortcuts.ts:14-15` 重复赋值两行 → **成立**（`tsc` 与 363 个测试都看不见）。

---

## 2. 总体画像：这个项目现在处在什么位置

### 2.1 成熟度

| 维度 | 实测 | 判断 |
|---|---|---|
| 类型 | `tsc --noEmit` 零输出；全库 `any` = 0、`@ts-ignore` = 0 | 优于同类 |
| 前端测试 | 34 文件 / 363 用例全通过（21.98s），纯逻辑层覆盖厚 | 良好，但接缝与生命周期层空 |
| Rust 测试 | 89/89 通过（5.7s），集中在 family/cli/server/settings | 良好 |
| 打包 | 2357 模块 / 1.23s；最大 chunk 145.72 kB；`codeSplitting.groups` 确认生效 | 良好 |
| 依赖 | 25 个直接依赖全部真被 import，无重复职责；221 包无许可冲突 | 良好 |
| 代码整洁度 | clippy 默认 lint 零命中，仅 2 条（`unnecessary_unwrap`、`too_many_arguments`） | 良好 |
| 文档 | README 174 行，10 条可验证论断 9 条一致 | 良好但会腐烂 |
| 工程护栏 | 无 CI、无格式化、无 lint、当前版本无 tag、lockfile 被手改过 | **明显短板** |

### 2.2 与上游的三层关系

Lumina 与上游的耦合不是一层，而是三层，维护成本也按层递增：

1. **进程看管**（`server.rs`）：拼 argv、等就绪、收日志、管生命周期。上游改参数名 → 这里要改。
2. **协议客户端**（`types.ts` + `lib/utils.ts` + `api.ts`）：`/sdcpp/v1` 的请求体/响应体/任务状态机。上游改字段 → 这里要改。
3. **参数翻译层**（`config/families.ts` 2083 行）：60 个家族的必需组件、默认采样参数、尺寸/帧数预设、禁用特性、必需输入。上游新增家族 → 这里要加一整块。

第 3 层是 Lumina 的核心价值（上游 web UI 完全没有这一层，它把 sd.cpp 的参数知识全部推给用户），也是它最大的维护负担。**这份 2083 行数据同时是 UI 展示、启动参数、输入校验、特性开关的唯一耦合点，被 11 个模块 import，必然进主 chunk，代码分割对它无效。**

### 2.3 风险排序（按"会不会伤到用户 / 会不会拖垮维护"，不是按问题数）

1. **静默无效**：用户按界面提示操作，界面说成功，实际不生效（PuLID/PhotoMaker、`distilled-sd` 默认值、`-l`）。这类最难排查，破坏信任。
2. **数据丢失**：结果只在内存、`modelSnapshots` 可被 `{}` 载荷整表清空、settings 往返丢未知字段、日志不落盘导致失败证据消失。
3. **上游漂移**：一天 3 个提交的速度下，没有自动化差异检测，第 3 层的同步必然会漏。
4. **无护栏**：上面每一条都只能靠人工发现——本次审查本身就是证据：`cargo fmt` 不过、clippy 不过、lockfile 脏、tag 缺失，全都存在了多个版本。

---

## 3. 必须立刻处理（10 条 P1 + 1 条同级 P2）

> 编号沿用各组报告，方便对照证据。10 条 P1 与 §0.3 的表一一对应；S-6 是 P2，但与 S-5 同属"数据会丢"，建议同批处理。

### 3.1 安全 / 数据边界

**S-1 `--listen-ip` 短别名绕过（`10-backend-rust.md` §2.1）**
`server.rs:256` 只判 `--listen-port` / `--listen-ip` 及其 `=` 形式。上游 `runtime.cpp:193` 给 `--listen-ip` 定了短别名 `-l`，`-l` 不在拦截表里，从 `server.rs:302` 直接透传；上游 `common.cpp:294` 是覆盖赋值，所以 `... --listen-ip 127.0.0.1 ... -l 0.0.0.0` 最终绑定 `0.0.0.0`。sd-server 的 HTTP 面**没有任何鉴权**，于是同一局域网可提交生成任务、读取能力清单；而 `Dashboard.tsx:1463` 仍向用户保证"监听 127.0.0.1"。用户只是把上游 `--help` 里的一行原样粘进来。
→ 修：维护一张"上游 short/long 别名并集"表，`-l` 与 `--listen-ip` 同等拦截 + 加测试。

**S-2 输出目录白名单自指（`10-backend-rust.md` §2.2）**
`save_output` / `read_file_b64` / `delete_output_file` 都靠 `dir_is_within(dir, output_dir)`，而 `output_dir` 来自 `save_settings`，`save_settings` 接受 webview 传入的任意值且不校验。Tauri 2 的 `capabilities/default.json` **不覆盖应用自定义命令**（23 条全部可达）。于是：`save_settings({outputDir: "…\Startup"})` → `save_output({ext:"bat"})`（`save.rs:62-91` 的 `ext` 只做字符替换）→ `start_server(exe_path: "<outputDir>/sd-server.exe")`（`server.rs:1242` 对"文件名以 sd-server 开头"跳过身份探测）。三步成链。
→ 修（任一即可破链）：`save_settings` 校验 `output_dir` 必须是绝对路径且来自 `pick_folder`；`save_output` 加扩展名白名单；`start_server` 去掉免探测快速通道。
→ 同一族的小项：`tauri.conf.json` 未设 `"devtools": false`，而上游 `tauri-runtime-wry` 默认 `unwrap_or(true)`，**发布包自带 WebView Inspector**（F12/右键即可用），这会把上面的链条变成零成本。

### 3.2 静默无效（用户以为成功，实际不对）

**S-3 PuLID / PhotoMaker 死组件（`40-cli-families.md` §2.1）**
身份参数 `pulid_id_embedding` / `pm_id_images` 在 `include/stable-diffusion.h:416-417` 属于**单次生成参数**，`examples/server/**` 对它们零引用；PuLID 缺 `id_embedding` 直接静默 return（连 WARN 都没有），PhotoMaker 打一条 WARN 后自行关闭。更严重的是家族挂反了：PuLID 只支持 Flux（`pulid_extension.cpp:110-118` 的 `FluxDiffusionExtra` 分支），却挂在 `sd` / `sdxl` 上；`flux` / `kontext` 反而没有。PhotoMaker 只支持 SDXL（上游文档明写 "ONLY works with SDXL"），却也挂了 `sd`。
→ 修：与 README 对 ADetailer 的处理保持一致（`README.md:118` 已正确声明不开放），要么删除组件位，要么复用 `families.ts:219-224` 的 `unsupported` 机制让检查单直接 NO-GO。

**S-4 `distilled-sd` 默认参数只对一支模型成立（`40-cli-families.md` §2.2）**
`families.ts:1846-1857` 填 `1 步 / CFG 1 / 512²`。上游 `docs/distilled_sd.md` 明确 `--cfg-scale 1 --steps 1` 是 **SDXS 专属且 mandatory**，而 SSD-1B / Vega 是"out-of-the-box"的常规蒸馏 SDXL（1024²、仍需 CFG 与二三十步）。`detect_family` 把 `ssd-1b` / `bk-sdm` / `sdxs` 全映射到 `distilled-sd`，于是 SSD-1B 用户默认就是错的。
→ 修：按名字拆族，或把默认值改中性 + 在提示里写清 SDXS 需手动改。

### 3.3 数据丢失

**S-5 结果只在内存（`50-ux-a11y.md` F-16；`20-frontend-arch.md` §2.2 为同一根因）**
关闭窗口（自绘 × 无提示）、`Ctrl+R` 触发 WebView 刷新（`useKeyboardShortcuts.ts:23` 用 `e.key` 精确匹配，CapsLock / 非美式布局下拦不住）、渲染进程被 OS 回收、内存预算淘汰——任一发生，整批未保存结果 + 全部参数一次性消失。后端 `save_output` 已具备，缺的只是策略。
→ 修：`settings.autoSaveResults`（默认开，未配输出目录时不启用）+ 关窗前未保存确认。

**S-6（P2，与 S-5 同批）`modelSnapshots` 可被部分载荷整表清空（`10-backend-rust.md` §2.3）**
`save_settings` 是全量替换：`settings.rs:294` 把结构体整体 `to_vec_pretty` 覆盖写。`{}` 是合法载荷（所有字段 `#[serde(default)]`），会把用户为每个模型手调的家族/组件/VAE 配置**整表清空**。同一条路径还意味着：前端先加字段、Rust 后补的窗口期内，任何一次保存都静默丢该字段；用户降级版本也丢。
→ 修：写前把旧文件读成 `Value` 与新结构体 merge（约 30 行），并给 `Settings` 加 `schemaVersion`。

### 3.4 可用性

**S-7 提示词 token 静默截断（`50-ux-a11y.md` F-17）**
Iris-3B 上限 300 token，超出被**静默截断**（`README.md:122` 自述），而提示词框没有任何计数（`PromptDock.tsx:111-119`）。A1111 的 "Live prompt token length validation" 就是这条能力。
→ 修：估算 token 数 + 家族上限提示（上限进 `FAMILY_CONFIG`），超限变色。

**S-8（同级）历史画廊视频 blob 泄漏（`20-frontend-arch.md` §2.1）**
`HistoryGallery.tsx:341` 的 512 MB 缓存只在删除/淘汰时 revoke（`:367`、`:574`），组件卸载时不做任何事；而 `GenerationUI.tsx:1109` 用 `AnimatePresence` 按 tab key 切换，每次切走都卸载画廊 → 每切一次泄漏一份。同仓库 `useBlobUrlCache.ts:109-116` 已经写对了卸载清理，属实现漂移而非取舍。

### 3.5 协议响应侧（`30-api-alignment.md`）

**S-9 animated WebP / AVI 结果不可播放（§2.2）**
`ResultsGrid.tsx:404-418` 只看载荷形状：有 `images[]` 走图片，否则有 `b64_json` 一律当视频 → `<video src=blob:mime>`。而 `vid_gen` 的三种容器 `mime_type` 分别是 `video/webm` / **`image/webp`** / `video/x-msvideo`（`runtime.cpp:159-167`）。animated WebP 塞进 `<video>` 必然 error，`useVideoPoster` 只静默返回 null → **永远黑屏、无报错**。更糟：`supported_vid_output_formats()` 的顺序是 `webm? → webp? → avi`，capabilities 的默认 `output_format` 取 `formats[0]`，所以「有 WebP、无 WebM」的构建里 animated WebP 就是**默认输出**。上游 webui 用 `mime_type.startsWith("video/")` 才给 `<video>`、`=== "image/webp"` 走 `<img>`，AVI 另有提示——两行判断即可。
→ 附带：`HistoryGallery.tsx:38` 前端硬编码 `VIDEO_EXTS` 含上游从不产出的 `mp4`、却按扩展名而非 mime 归类，与这里应一并按 `mime_type` 重构。

**S-10 元数据恢复 LoRA 永不匹配（§2.3）**
元数据侧 `name = sd_basename(...)`（`common.cpp:3146`）→ **含扩展名的文件名**；capabilities 侧 `name = p.stem()`（`runtime.cpp:286`）→ **stem**。`utils.ts:670` 用 `a.name === name` 比较 → 恒 `undefined`，所有 LoRA 静默丢弃，"从历史图恢复参数再生成"得到的是没有 LoRA 的图。测试 `utils.test.ts:1152-1170` 的假数据把两侧都写成 `"style.safetensors"`，所以绿灯。
→ 修：匹配时归一化（`a.name === name || a.path.endsWith("/" + name)`），并把夹具改成真实形状（这一条同时说明：**假夹具比没有测试更危险**）。

**S-11 capabilities 缺 `defaults_by_mode` → 白屏（§2.4）**
`App.tsx:86` 只要 `sdcppCapabilities()` HTTP 成功就 `setCaps` 并进 `phase="running"`；`GenerationUI.tsx:284-292` 在 `defaults_by_mode[mode]` 缺失且 `current_mode`/`supported_modes` 也缺失时 `return`，`params` 永远为 null，`:1003` 直接 `return null` → 空白生成页，日志里没有任何错误。上游 `api.md:486-491` 明确说顶层 `defaults`/`output_formats`/`features` 是**deprecated 兼容镜像**，正是为这种情形准备的，而 Lumina 一个都没读。
→ 修：fallback 链 `defaults_by_mode[mode]` → `defaults` → `familyDefaults(cfg, mode)`；并在三档都失败时 toast「内核过旧，无法读取生成默认值」，把白屏换成可解释状态。

---

## 4. P2 分批整改（按 ROI，不按领域）

> 完整 48 条见各组报告。这里只给"怎么排"——同一条 P2 在不同批次里的价值完全不同。

### 批次 A：稳态化（1–2 天，收益最大）——把人工动作变成机器动作

| 项 | 来源 | 说明 |
|---|---|---|
| 加 CI（3 个 job） | `60` §2.4 | `npm ci` + `tsc --noEmit` + `npm test` + `cargo test` + `npm audit --omit=dev`。约 3 分钟 |
| `cargo fmt` + 修 2 条 clippy | `10` §2.14 | 当前 `-D warnings` 只差 2 处，修完即可开门禁 |
| 加 `check-version.mjs` + 打 tag | `60` §2.1/2.2 | 5 处版本号已一致，但 `0.8.6` 无 tag；`.npmrc` 建议的 `--git-tag-version` 会打出脱同步 tag（npm 只 `git add` package.json） |
| 重新生成 lockfile + 验证 `npm ci` | `60` §2.3 | 现在 `npm ls --all` 有 1 个非 optional 的 UNMET + 4 个 extraneous，根因是 `ab2d5ea` 手改过 lockfile |
| 上游差异检测脚本 | 本报告 §5.2 | 见下节，这是本项目的"降本关键" |

### 批次 B：安全收口（1 天）

`devtools:false`、CSP 去掉 `connect-src http://127.0.0.1:*`（前端零 `fetch`，这条放行是纯多余，且与 devtools 叠加后可探测本机所有 HTTP 服务）、`object-src 'none'` / `base-uri 'none'`、`save_output` 扩展名白名单、`dir_is_within` 的 `Path` 比较改造（顺便修 Linux 上非 UTF-8 / 反斜杠路径恒拒的问题）。

### 批次 C：性能与内存（2–3 天）

- 内存预算统一记账（`20` §2.2/2.3）：结果区 1 GiB 只算 base64，未算解码位图；历史画廊另有 128+512+512 MB 三份独立预算 → 峰值约 2.2–2.6 GiB 渲染进程，与 sd.cpp 吃 8–16 GB 叠加时会被 OS 杀掉（结果全丢，与 S-5 同源）。
- 日志面板：`key={i}` + `slice(-1500)` 裁头 → 1500 行整体错位重写，且 `role="log" aria-live="polite"` 会逐行播报（`20` §2.4 / `50` F-09）。
- 历史画廊 O(N²)：每完成一张缩略图就复制整个缓存 Map 并整表重渲染（`20` §2.5）。
- Dashboard 生成期间每 2 s 整页重渲染 1476 行（`20` §2.6）——只为两个计数订阅了 `jobs`/`results`。
- `list_output_files` 打开画廊即整读所有 png/webp（上限 5000×64 MB），改成只读文件头（`10` §2.8）。

### 批次 D：体验补齐（按产品节奏）

- 自动落盘（S-5）+ 关窗确认。
- 补上"请求体已接、UI 无控件"的 5 个字段：`vace_strength`、`shifted_timestep`、`cache_option`/`scm_mask`、SLG `layers/layer_start/layer_end`、高噪段 `img_cfg`/`slg`（`50` F-18）。**上游官方 web UI 全都有，Lumina 数据层已经完整，只差控件** —— 这是投入产出比最高的一批 UI 工作。
- 视频**时间维**分块（`temporal_tiling` / `extra_tiling_args` 的 `temporal_tile_frames`、`temporal_tile_overlap`）：类型齐全、零控件，而它是长视频解码 OOM 的唯一降内存手段（`30` §2.9）。与上面 5 个字段同属"协议已通、只差控件"，但影响面更大，建议优先。
- 协议正确性小批：`features` 门控极性统一（`30` §2.5）、`output_format` 按 caps 收敛（`30` §2.6，否则跨内核切换后每次提交 400）、陈旧 `sampler`/`scheduler` 标记或回退（`30` §2.7）、`Job` 补 `queue_position`/`started`/`completed` 并改用真实耗时（`30` §2.8）、`fps` 缺省 24 → 上游默认 16（`30` §2.6 附带）。
- 无障碍：次级文字对比度（lumina 3.75–4.13:1）、**输入框 placeholder 仅 2.13–2.34:1**（正向提示词框的占位提示就踩在这条上）、vostok 主按钮 hover 3.28:1，且全部配 9.5–10 px 小字号 → 实测不达 WCAG AA；另有 `aria-modal`/`inert` 不统一、折叠面板控件仍进 Tab 序、日志 `aria-live` 逐行播报、`prefers-reduced-motion` 只覆盖 CSS 而 motion 动画不受控（`50` F-04/F-05/F-06/F-07/F-09/F-10）。
- 键盘：Esc 不检查 `defaultPrevented`（一次 Esc 关两层浮层）、`Ctrl+Enter`/`Ctrl+R` 在 Lightbox 打开时仍命中后台、`e.key` 改 `e.code` + 认 `metaKey`。

---

## 5. 跨领域根因（本次审查最重要的产出）

单条问题修完就没了，根因不修会不断长出新问题。5 条：

### 5.1 双源真值矩阵（8 处"同一事实写两遍"）

| 事实 | 副本 A | 副本 B | 现有保护 |
|---|---|---|---|
| 家族 id（60 个） | `src-tauri/src/family.rs` 的字符串 | `families.ts` 的 `FAMILY_CONFIG` 键 | **无**（本次实测双向零差集，属运气好） |
| 组件类别词表（20 类） | `family.rs::classify_file` | `families.ts` 的 `F(..., cat)` | 无 |
| 设置结构（22 字段） | `types.ts` 的 `Settings` | `settings.rs` 的 `Settings` | 无（`#[serde(default)]` 让漂移静默） |
| 23 个 Tauri 命令名与参数键 | `src/api.ts` 的 `invoke("...")` | `lib.rs` 的 `generate_handler!` | **无**：7 个测试把整个 `api` mock 掉，改名后 tsc 绿、363 测试全绿 |
| CLI 参数（156 个） | 上游 `common.cpp` | `server.rs::build_args` + `launchConfig.ts` | 运行时 `--help` 探测（能发现"有没有"，发现不了"语义变没变"） |
| HTTP 请求体字段 | 上游 `routes_sdcpp.cpp` | `types.ts` + `utils.ts` | capabilities 键存在性判定 |
| PNG 元数据键 | 上游 `image_metadata.cpp` | `png_info.rs` + `utils.ts::mapSamplingMetadata` | 无 |
| 采样器/调度器显示名 | 上游 `str_to_sampler` | `families.ts` 的 `SAMPLER_NAMES` / `SCHEDULER_NAMES` | 无（未知值静默显示原名） |

**判断**：这种双写本身在桌面客户端里很难避免（Rust 管进程与文件，TS 管界面），但**必须有一条自动化的"两份必须一致"检查**。唯一有保护的是家族识别（`family.rs` 是唯一实现），而这恰好是历史上最容易漂移的一处——说明作者选择"收敛到一处"是正确的方向，只是没推广到其余 7 处。

**建议的最小护栏**（都不需要重构）：
1. `src/__tests__/contract.test.ts`：正则抽 `api.ts` 的 `invoke("xxx")` 与 `api.ts` 的参数键，对硬编码快照断言；Rust 侧对 `generate_handler![...]` 做同样快照。改名必须显式改快照。
2. Rust 侧 `#[test]` 把 `detect_family` 的 id 全集导出成一份 JSON，TS 测试读它断言 ⊆ `FAMILY_CONFIG` 键集。
3. 把上游 `api.md` 的字段表解析进测试：断言 `buildRequestBody` 的键集合 ⊇ 上游表（允许白名单）。

**一个反例值得单独立规矩**：S-10（LoRA 元数据永不匹配）之所以能长期存在，是因为测试夹具 `utils.test.ts:1152-1170` 把两侧的 `name` 都写成了同一个假值 `"style.safetensors"`，而真实数据一侧是 stem、一侧是含扩展名。**按想象构造的夹具比没有测试更危险**，因为它把错误假设固化成"已验证"。同类还有 `20` §2.12 列的 4 个"生命周期/订阅层完全没有测试"的点。规矩：涉及跨系统契约的夹具，必须从真实响应/真实元数据里摘一段贴进去，并在注释里写明来源与日期。

### 5.2 上游漂移无护栏

上游 README 自述 "API and command-line option may change frequently"；实测一天 3 个提交。本仓库的应对是**每版人工"同步上游"**（`git log` 里 6 次 `feat: 同步上游 xxx 的 GUI 适配`），成本全部压在一个人的记忆上。

**建议：`scripts/upstream-diff.mjs`（约 150 行，收益最大的一处工程投入）**
1. 拉取上游 `examples/common/common.cpp` 与 `examples/server/api.md`（可 `curl` raw，或把上游加为只读 submodule）；
2. 抽出：全部 `--xxx` 参数名、`api.md` 里的请求体字段名、`docs/*.md` 里出现的家族名；
3. 与本仓库的映射表（`families.ts` 的 arg 集合 + `launchConfig.ts`/`diagnostics.ts` 的结构化键 + `types.ts` 的字段）求差；
4. 输出三类报告：**上游新增但未映射**、**本仓库映射但上游已删**、**上游新增家族**；
5. 挂进 CI（周更或 release 前跑），失败即提醒。

配合 `docs/UPSTREAM-SYNC.md` 一份 10 行检查单（同步时依次看：新 CLI 参数 / 新请求字段 / 新家族 / 字段改名 / 默认值变化 / 新提交要不要改 UI）。

### 5.3 无自动化门禁

`cargo fmt --check` 不通过（`family.rs` 8 处）、`clippy -D warnings` 不通过（2 条）、无 eslint/prettier/editorconfig、无 CI、当前版本无 tag、lockfile 被手改。这些不是"风格洁癖"，本次审查已经量化了代价：

- lockfile 手改 → `npm ls` 出现 UNMET，干净 `npm ci` 从未被验证；
- 无 CI → 4 个漏洞、19 个过期依赖、缺失 tag 全部无人发现；
- 无格式化 → `families.ts` 941–1017 整块 2 tab 与周围 1 tab 混排，而它正好是最新、最常被当模板复制的家族定义；
- 无 lint → `useKeyboardShortcuts.ts:14-15` 两行完全重复的赋值，`tsc` 与 363 个测试都看不见。

### 5.4 可观测性缺失

- **日志不落盘**：release 无控制台（`windows_subsystem`），`env_logger` 写 stderr 即丢；sd-server 的 stdout/stderr 只经 `server-log` 事件进前端 2000 行环形缓冲。GUI 崩溃或误关后，一次启动失败的完整证据消失——而 README 让用户"先看日志面板"。日志面板也没有"复制全部"按钮，用户报 issue 只能截图。
- **无 ErrorBoundary**：`src` 全库 0 处 `ErrorBoundary` / `componentDidCatch` / `window.onerror`，任何渲染异常 → React 卸载整棵树 → **白窗**，且 `sourcemap: false` 让即便打开 devtools 也只能看到压缩栈。
- **心跳自残**：`sdcpp.rs:98-107` 的兜底探测打 `/sdcpp/v1/capabilities`，而同一文件 `44-47` 的注释自己写着"该端点会触发上游全量 LoRA 递归扫描，所以不能当心跳用"；配合 3 s 轮询且无负缓存，非上游原版内核会出现"空闲时每 3 秒扫一遍模型目录"。

### 5.5 内存与生命周期预算模型不完整

结果区、历史画廊三份缓存、任务队列的 `config.images`、视频 poster、预览帧——各自有局部上限，但没有总账；`revokeObjectURL` 的时机在四处各写一遍，其中一处（`HistoryGallery`）漏了卸载分支。建议抽一个 `useByteBlobCache(capacity)` 统一"字节预算 + 卸载 revoke + 按 key 订阅"，四处复用。

---

## 6. 与上游的差距清单（集中呈现）

### 6.1 HTTP 协议面（`30-api-alignment.md`）

**先给一个正面结论，这决定了后续所有协议类问题的性质**：上游 `from_json_str` 接受的 **61 个请求键**逐一比对，Lumina 用它发送的字段**没有一处拼错、没有一处类型错、没有一处单位错**；`sample_params` / `guidance.slg` / `hires` / `vae_tiling_params` / `lora` / `image_preprocess` / `ref_image_args` / `preview` 的嵌套结构全部与上游吻合。所以问题不在"字段没对齐"，而在**响应侧使用**与**降级路径**——这是完全不同量级的结论：协议层已经被认真对过。

**Lumina 比上游官方 webui 更严格的地方**（值得在 CHANGELOG 里写出来，也说明这些代码不是抄的）：
- 错误体的两种形状分开解析（`utils.ts:111-132`）；上游 webui 只取 `.error || .message`，遇到 job 内的对象形状会打出 `[object Object]`。
- 不发 `scm_policy_dynamic`——上游解析器根本不存在该键（`common.cpp:2144-2147`），`api.md` 把它列为请求字段是**上游文档错**。
- SLG 用 `{scale: 0}` 显式关闭；因为请求体是合并在服务端默认值之上的，**只有显式发 0 才能关闭**，上游 webui 恒发整套 slg 反而关不掉。
- `clip_skip` 仅在 `!== -1` 时发送（省略=沿用服务端启动值），比 webui 恒发 -1 更保真。
- `vae_tiling` 的**键名嗅探**（`utils.ts:431-447`）是全仓最可靠的协议探测——按内核实际声明的键名决定发 `tile_size_w/h` 还是 `tile_size_x/y`，不靠版本号猜。

**仍有缺口的三类**（细节见 `30-api-alignment.md`）：
1. **响应字段未取用**：job 的 `queue_position`（1 起的真实排队位次）、`started` / `completed`（内核时间戳）在 `types.ts:453-472` 连声明都没有 → 队列位置丢失，且 `elapsed` 混入了排队等待与轮询抖动。补三个可选字段 + `JobQueue` 展示即可，纯增量。
2. **`features.*` 两条路径极性相反**：面板显隐用真值（缺键即隐藏），提交裁剪用 `=== false`（缺键即照发）→ 同一个缺失键得到「看不见但仍生效」。而 `routes_sdcpp.cpp:195-225` 的 `features` 其实是**硬编码常量**，它只能当握手标记用，不能当能力真值。
3. **缺统一降级链**：`defaults_by_mode` → 兼容镜像 `defaults` → 家族预设。第三档已经在手边（`familyDefaults`），只是没接上。同族问题还有 `output_format` 不按 `output_formats_by_mode` 复核（跨内核切换后 localStorage 旧值让**每次提交都 400**，而下拉里根本没这一项）、陈旧 `sampler`/`scheduler` 被保留并发送（上游对未知枚举静默忽略 → 界面显示 A、实际用默认）。

**另两套 API（`/sdapi/v1`、`/v1`）的评估结论：不接。** 逐项比对后，只有 `upscalers[].scale`（放大倍率）是 sdcpp 面真的缺的，其余全冗余且更弱（sdapi 的 txt2img 是同步阻塞、参数更少）。为一件事接一整层 A1111 命名翻译不划算。


### 6.2 CLI 面（`40-cli-families.md` §2.4）

**真正"任何途径都设不了"的只有 2 个**：`--listen-ip` / `--listen-port`（`server.rs:256-265` 硬拒，README:91/114 已声明，属有意设计）。156 个上游长选项里的其余全部可经「附加启动参数」透传（`--k=v` 会被拆成两个 token，因为上游是精确字符串匹配）；另有 16 个是 sd-cli 专属、对 sd-server 不适用。

**覆盖形态**：约 20 个有实际意义的参数只能手写，其中 `--threads`（弱机第一调）、`--params-backend`（8 GB 卡刚需，`cli.rs:446-467` 甚至已经处理了它与 auto-fit 的冲突却不给入口）、`--rpc-servers`（多机）最值得补控件。

**「附加启动参数」作为逃生舱的三个已知代价**：无输入期校验（只有十几个白名单名字有）、无补全（`cli.rs` 其实已经把内核 `--help` 全解析进 `CliCapabilities.options`，做 datalist 零成本）、跨家族继承（存在 `ModelConfigSnapshot` 里，切模型会带走）。

### 6.3 家族数据（`40-cli-families.md`）

抽样核对 20 个家族（含全部最新家族），**除 S-3 / S-4 与 `mage-flow` 默认步数外，组件、默认值、对齐、禁用特性全部与上游一致，无占位家族**。`family.rs` 的 60 个 detect id 与 `FAMILY_CONFIG` 的 60 个键双向零差集。

家族识别仍有明确误判面：`has_any` 是裸子串匹配且匹配**整条小写路径**（含父目录名），于是 `anima` ⊂ `animation`、`wan` ⊂ `wand/swan/taiwan`、`lens` ⊂ `lenses`；`D:\models\flux2\sdxl_finetune.safetensors` 会因父目录先命中 `flux2`；而常见写法 `flux-1-dev` **没有任何规则命中**，静默落到 `custom`。有手动覆盖所以是 P2。

### 6.4 上游官方 web UI 对照（`50-ux-a11y.md` §2.9）

这是本次审查最值得作者看的一节：上游 2026-04 起自带一套 Vue 3 界面（`sdcpp-webui`，MIT，单 HTML 嵌进二进制）。

**上游有、Lumina 没有（且真有用的）**：`VACE Strength`、`Cache Option`/`SCM Mask`/`Dynamic SCM Policy`、`Shifted Timestep`、SLG 的 `layers`/`layer_start`/`layer_end`、高噪段的 `Image CFG`/`SLG`。**共同点：Lumina 的请求体已经全接了（`utils.ts:791-792/810-811/866-870/816-828`），只是没控件。**

**Lumina 有、上游没有（差异化，按价值排序）**：启动检查单 + 模型扫描 + 家族识别（上游连"模型路径"概念都没有，直接假设 sd-server 已启动——这恰好是 sd.cpp 最大的门槛）、CLI 兼容性门控、家族预设与对齐、结果走廊 + 历史画廊、应用此配置/元数据恢复、任务队列、键盘与读屏支持（上游 `App.vue` 全文只有 1 个 `addEventListener`，零 keyboard/aria）。

**架构取舍**：上游用 `capabilities` 驱动动态表单（78 行 `form-capabilities.ts` 覆盖全部字段，永不漂移，但零预设、体验下限低）；Lumina 用手写家族表（体验好，但 2083 行要跟着上游跑）。**推荐的混合方案**：字段"存在性"交给 capabilities（缺失即不渲染），"语义与推荐值"留在家族表；再加一个「其他参数」折叠面板，把 `defaults_by_mode` 里 UI 未建模的标量字段自动生成控件——这比 `extra_sample_args` 强的地方是键与层级由内核决定，不会被塞进错误的父对象（`vace_strength` 是顶层键，写进 `sample_params` 下的 `extra_sample_args` 根本不生效）。

### 6.5 上游近期提交的影响

`95b3090`（MOSS 拆分 QKV + host 侧批量加载）、`ab8d5ea`（Diffusers 格式 MiniMax-H3 LoRA）、`d55cc0f`（文档）：**都不需要界面改动**。报文面已被逐文件确认——`git diff --stat f0aac52..HEAD` 里 `examples/server/**` 与 `examples/common/**` **一行未改**，改动只落在 `src/model_loader*`、`src/name_conversion.cpp`、`src/model/adapter/lora.hpp`。因此 README 的对齐号可以直接更新为 `d55cc0f`，并可加一句"报文面自 f0aac52 未变"。

两个值得留意的副作用（不是缺陷，但会变成 issue）：
- `ab8d5ea` 让**带 `alpha` 元数据的 LoRA 实际强度发生变化**（`scale_value = alpha/rank`，此前恒 1.0）→ 同一 LoRA 升级内核前后出图不同，属预期行为。
- 该提交里 `alpha` 解析失败会直接判 LoRA 加载失败，而 Lumina 对"LoRA 没生效"没有任何可见反馈。

风险在于**形态变化**（例如上游把 `--tokenizer` 改成多值、把 PuLID 放进 HTTP），这类靠 `--help` 探测发现不了——所以 §5.2 的差异检测脚本要能比对 `api.md` 的字段表，而不只是参数名。

---

## 7. 产品与战略建议

### 7.1 定位

上游已经有官方 web UI 之后，Lumina 的价值不再是"给 sd-server 一个界面"，而是**"把 sd.cpp 的启动与参数知识产品化"**。这条定位在数据上成立：60 个家族的必需组件、尺寸/帧数对齐、必需输入互斥、CLI 版本门控，上游一个都没有，而这是新用户百分之百会卡住的地方。

因此建议把资源按这个比例投：**同步成本 ↓ ＞ 生成界面补齐 ＞ 新功能**。理由：生成界面已经够用（甚至部分优于上游），而同步成本是唯一会随时间线性增长、并且直接由一个人承担的成本。

### 7.2 三阶段路线

**阶段一（0.8.7，一周内）：止血**
P1 十条（S-1 … S-11）+ blob 泄漏 + CI + fmt/clippy + tag + lockfile 重生成。目标：**没有任何"界面说成功但实际不生效"的路径，也没有白屏**。

**阶段二（0.9.x，两到三周）：降本**
`upstream-diff.mjs` + `UPSTREAM-SYNC.md` + 双源真值矩阵的 3 条护栏（命令面快照、家族 id 交叉断言、api.md 字段断言）；`families.ts` 拆成按家族的小文件或外置 JSON（顺带解决它必然进主 chunk 的问题）；P2 性能/内存批次。

**阶段三（1.0，按精力）：补齐**
自动落盘、未建模字段的自动控件（§6.4 混合方案）、token 计数、对比度与动效偏好、i18n 第一层（**把 Rust 错误码化** —— 这同时解决了 6 处英文裸串出现在中文界面里的问题，是 i18n 里性价比最高的一步）、代码签名 + updater。

### 7.3 明确不建议做的事

| 不做 | 理由 |
|---|---|
| `--mode convert` / imatrix | 离线权重量化工具，与"启动服务跑推理"正交；要做应做成独立小工具 |
| ADetailer | 上游 `/sdcpp/v1` 没有这个面（README:118 已正确声明）；`server.rs:153` 还把它列进路径校验白名单，属假信号，建议移除 |
| PuLID / PhotoMaker 的「完整支持」 | 上游没开 HTTP 面；现在的半截支持比不支持更糟（见 S-3） |
| 工作流 / 节点图 | `/sdcpp/v1` 没有图执行语义，硬做只是负担 |
| 局域网共享（`--listen-ip 0.0.0.0`） | 可以做，但必须先补鉴权或明确警告；当前硬拒是对的 |

---

## 8. 附录

### 8.1 分领域报告索引

| 文件 | 内容 | 条目 |
|---|---|---|
| `10-backend-rust.md` | Rust 后端、进程生命周期、Tauri 命令面与安全边界 | 22 条 + 1 条「已核实不成立」 |
| `20-frontend-arch.md` | 前端架构、状态、渲染性能、内存与生命周期 | 17 条 |
| `30-api-alignment.md` | `/sdcpp/v1` 协议逐字段三方核对（上游 C++ / 上游 webui / Lumina）、能力探测三组合失效模式、任务模型 | 11 条 + 1 条附带 |
| `40-cli-families.md` | CLI 参数覆盖矩阵、60 家族数据核对、硬缺口逐项判断 | 10 条 + 3 条更正 |
| `50-ux-a11y.md` | 交互、无障碍、国际化、错误文案逐条点评、同类 GUI 对照 | 23 条 |
| `60-build-test.md` | 构建、依赖、测试、发布、文档治理（含实测记录） | 17 条 |

### 8.2 Lead 抽检记录（11 处独立复核）

> 各组结论由我重跑一遍关键证据，目的是排除"读代码读出来的幻觉"。全部命中，无一条被推翻。

| # | 待复核结论 | 复核方式 | 结果 |
|---|---|---|---|
| 1 | `-l` 绕过监听守卫 | 读上游 `runtime.cpp:193` 与 `server.rs:250-265` | **成立**：上游短别名为 `-l`，本地只判 4 种长名 |
| 2 | 发布包带 WebView Inspector | 读依赖源码 `tauri-runtime-wry-2.11.2/src/lib.rs:5211` | **成立**：`with_devtools(attrs.devtools.unwrap_or(true))` |
| 3 | 历史画廊 blob 泄漏 | 读 `HistoryGallery.tsx` 全文 + `GenerationUI.tsx:1109-1164` | **成立**：卸载清理只拆 ResizeObserver/滚轮监听，不 revoke；tab 切换确实卸载 |
| 4 | Dashboard 订阅 `jobs`/`results` | 读 `Dashboard.tsx:43-50` | **成立**：`jobs`、`results` 各一个 subscription，均只用于计数 |
| 5 | App 3 s 轮询误报"连接已断开" | 读 `App.tsx:126-131` | **成立**：`caps` 存在且 status 显示不可达时即 toast |
| 6 | 家族数量 58 vs 实际 | 用 node 脚本按 brace depth 解析 `families.ts` | **成立**：60 个家族 + `custom` = 61 键 |
| 7 | README 家族清单漏项 | grep README 的 `LLaDA` / `SenseNova` | **成立**：零命中，而 `families.ts:401/1198/1228` 有完整配置 |
| 8 | `parse_png_metadata` 无调用方 | 全库 grep `parsePngMetadata` | **成立**：仅 `api.ts:98` 定义一处 |
| 9 | `useKeyboardShortcuts.ts:14-15` 重复赋值 | 直接读文件 | **成立**：两行完全相同 |
| 10 | `MAX_RESULTS` / `MAX_RESULTS_BYTES` / `MAX_JOBS` | 读 `utils.ts:188`、`useJobPolling.ts:270` | **成立**：60 / 1 GiB / 300 |
| 11 | 设置结构无未知字段兜底 | 读 `settings.rs:89-157` | **成立**：`#[serde(flatten)]` 只出现在 `SettingsLoadResponse`，`Settings`/`ModelConfigSnapshot` 无 catch-all |

### 8.3 实测记录（本次审查真跑过的命令）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0，零输出 |
| `npm test` | 34 文件 / 363 用例全通过，21.98 s（`Dashboard.test.tsx` 单文件 17.0 s = 77%） |
| `npm run build` | 2357 模块 / 1.23 s，最大 chunk 145.72 kB，CSS 97.75 kB |
| `npm ls --all` | 1 个非 optional UNMET（`@emnapi/runtime`）+ 4 个 extraneous |
| `npm audit` | 4 个（2 high / 2 moderate），全在 dev 链；`--omit=dev` 为 0 |
| `npm outdated` | 19 个落后，5 个跨大版本 |
| `cargo test` | 89 passed / 0 failed，5.7 s |
| `cargo fmt --check` | **exit 1**（`family.rs` 8 处） |
| `cargo clippy --all-targets -- -D warnings` | **exit 1**（2 条：`cli.rs:314`、`scanner.rs:300`） |
| `git tag -l` / `git describe` | 无 `v0.8.6`；`v0.8.5-3-gd442371` |
| 上游 clone | `d55cc0f`；对比声明对齐的 `f0aac52` 多 3 个提交 |

### 8.4 复现方式

```powershell
# 上游基准
git clone --depth 1 https://github.com/leejet/stable-diffusion.cpp.git $env:TEMP\lumina-audit\stable-diffusion.cpp
git clone --depth 1 https://github.com/leejet/sdcpp-webui.git $env:TEMP\lumina-audit\sdcpp-webui

# 本仓库
cd D:\Project\AmeowCAT\lumina
npx tsc --noEmit ; npm test ; npm run build
cd src-tauri ; cargo fmt --check ; cargo clippy --all-targets -- -D warnings ; cargo test
```

### 8.5 审查边界

- 没有启动过真实 GUI 与 sd-server（无 GPU 推理环境），所有"界面表现"结论来自源码 + `docs/screenshots/*.png`；
- 对比度是手算 WCAG 相对亮度，没有跑 Accessibility Insights / NVDA；
- 与后端 `--list-devices`、真实内核 stdout 格式相关的时间估计（如进度 ETA）未实测；
- 未验证 macOS / Linux 的构建（作者也未验证，见 `60` §2.14）。
