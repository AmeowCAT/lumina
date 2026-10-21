# Rust 后端与 Tauri 安全边界 审查报告

> 审查对象：`src-tauri/src/**`（10 个 `.rs`，实测 7,506 行）、`Cargo.toml`、
> `capabilities/default.json`、`tauri.conf.json` 安全项。基线 `d442371` / v0.8.6。
> 方法：全量静态阅读 + 上游 `stable-diffusion.cpp@d55cc0f` 对照 + 实跑 `cargo fmt/clippy/test`
> + 一个仓库外的临时 Rust 程序验证 Windows 链接语义（不改动任何源码/配置）。

## 0. 结论摘要

1. **`--listen-ip` 的守卫可被它的短别名 `-l` 绕过**：用户把上游 `--help` 里的 `-l 0.0.0.0` 粘进
   「附加启动参数」，sd-server 就以 0.0.0.0 无鉴权对外提供服务，而控制台仍写着「监听 127.0.0.1」。**P1**
2. **`dir_is_within` 的白名单根 `output_dir` 本身可由 webview 通过 `save_settings` 任意改写**，
   所以 `save_output` 的「收敛到输出目录」不是安全边界；配合 `start_server` 可形成
   「任意写 → 任意执行」链条。**P1**
3. `save_settings` 是**全量替换**（反序列化到结构体再整体序列化回盘），且没有未知字段兜底：
   字段漂移/降级会静默丢配置，`{}` 载荷会把全部设置（含 modelSnapshots）重置为默认。**P2**
4. 退出时 `RunEvent::Exit` 用 `blocking_lock()` 取 `server` 锁，而 `start_server` 持锁最长约
   **35 秒**（5s×2 probe 队列 + 20s 设备探测 + 10s stop + 400ms 健康检查）→ 关窗会卡住。**P2**
5. **日志完全不落盘**：release 无控制台，`env_logger` 写 stderr 无人接收，sd-server 输出只经
   `server-log` 事件进前端内存（上限 2000 行）。README 却让用户「先看日志面板」。**P2**
6. `SdClient::ping()` 的兜底分支会调 `/sdcpp/v1/capabilities`——正是注释里说「会触发全量 LoRA
   扫描、因此不能用做心跳」的那个端点，且没有负缓存；配合 3s 轮询等于**空闲时每 3 秒扫一遍 LoRA 目录**。**P2**
7. 日志管道**无背压、无单行上限**：`pending: String` 无界增长，`progress` 事件在每读到一个 chunk
   时重复重发同一段文本。**P2**
8. `list_output_files` 在画廊每次打开时**整读并 JSON 解析目录树里所有 png/webp**（≤5000 文件 ×
   单文件 64MB 上限）→ 上千张产出图时一次打开就是数 GB IO。**P2**
9. 跨平台：`to_string_lossy()` / `replace('\\', "/")` 在 Unix 会破坏合法文件名（反斜杠、非 UTF-8
   路径），后者还让 `dir_is_within` 的 canonicalize 比对恒为 false。**P2**
10. 工程化：`cargo fmt --check` **不通过**（8 处）、`cargo clippy --all-targets -- -D warnings`
    **不通过**（2 条真实 lint，其中 1 条是可读性隐患的 `unwrap`）；`cargo test` 89/89 通过（5.7s）。
    另：发布包 devtools 可用（且**不依赖** Cargo 的 `devtools` 特性，见 2.11）。**P2/P3**

## 1. 审查范围与方法

- 通读（行数为文件总行数）：`lib.rs` 729、`server.rs` 2,005、`cli.rs` 925、`scanner.rs` 869、
  `family.rs` 1,434、`settings.rs` 611、`save.rs` 340、`png_info.rs` 347、`sdcpp.rs` 237、
  `main.rs` 6、`build.rs` 3。合计 **7,506** 行（其中测试约 1,500 行）。
- 配置：`Cargo.toml`、`capabilities/default.json`、`tauri.conf.json`、`src-tauri/gen`（自动生成）。
- 实跑（本组独占构建权限，`src-tauri` 下）：
  - `cargo fmt --check` → **exit 1**，`family.rs` 8 处 hunk（27/362/386/712/879/1367/1375/1403 行）。
  - `cargo clippy --all-targets` → **2 warning**（`cli.rs:314 unnecessary_unwrap`、
    `scanner.rs:300 too_many_arguments`），`Finished dev profile in 3.70s`。
    `cargo clippy --all-targets -- -D warnings` → **exit 1**（同两条升级为 error）。
    除此之外 clippy 默认 lint 零命中——代码整洁度高，缺口在于**没有门禁**。
  - `cargo test` → `89 passed; 0 failed`（lib），`0 tests`（main / doc），编译 5.03s，用例 0.02s，
    总墙钟 5.7s。测试覆盖集中在 `family.rs`(27)/`cli.rs`(15)/`server.rs`(21)/`settings.rs`(7)/
    `scanner.rs`(7)/`save.rs`(5)/`png_info.rs`(4)/`sdcpp.rs`(3)/`lib.rs`(2)。
  - 无 `rustfmt.toml` / `clippy.toml` / CI 配置（`git log` 无 CI 提交）→ 上述两项从未被强制。
- 上游对照：`examples/server/runtime.cpp`、`examples/common/common.cpp`、`examples/server/README.md`。
- 补充验证：在 `%TEMP%` 用 `rustc` 编译了一个 15 行程序，实测 Windows junction 的
  `DirEntry::file_type()` 语义（结论见 2.10），验证后已删除，未触碰仓库。

## 2. 问题清单

### 2.1 `--listen-ip` 守卫可被上游短别名 `-l` 完全绕过（LAN 暴露）

- 级别：**P1**（若 Lead 采用「安全边界被绕过即 P0」的口径，本条可升 P0）
- 位置：`src-tauri/src/server.rs:256`
- 现状：
  ```rust
  let listen_flag = t == "--listen-port" || t == "--listen-ip"
      || t.starts_with("--listen-port=") || t.starts_with("--listen-ip=");
  ```
  不在上述四种写法的 token 会一路走到 `server.rs:302` 的 `out.push(t.clone())`。
- 问题：上游 `examples/server/runtime.cpp:193` 定义的是
  `{"-l", "--listen-ip", "server listen ip (default: 127.0.0.1)", 0, &listen_ip}` ——
  **`--listen-ip` 有短别名 `-l`**。`-l` 既不是 `--listen-*` 也不命中 `-m`/`-m=` 分支，直接透传；
  `common.cpp:268-269` 按 `arg == option.short_name` 精确匹配、`common.cpp:294`
  `*option.target = argv_to_utf8(i, argv)` 是**赋值（后者覆盖前者）**。于是 argv 变成
  `... --listen-ip 127.0.0.1 ... -l 0.0.0.0`，最终 `listen_ip = "0.0.0.0"`。
  后果链：sd-server 的 `/sdcpp/v1` 与 WebUI 无任何鉴权 → 同一局域网内任何机器都能提交生成任务、
  读取能力清单；而 `src/components/dashboard/Dashboard.tsx:1463` 仍向用户保证
  「sd-server 监听 127.0.0.1 的端口」。用户是把上游 `--help` 里的一行原样粘进来，不是有意越权，
  所以「静默」是这里最糟的部分。
- 上游/对照依据：`examples/server/runtime.cpp:193`（短别名）、`examples/common/common.cpp:266-300`
  （精确匹配 + 覆盖赋值）、`examples/server/README.md:29-33`（官方推荐改监听地址的方式）。
- 建议：把监听参数判定改成「对 upstream `ArgOptions` 里所有 short/long 名字取并集」，
  最小改动是在 `server.rs:250-265` 增加 `t == "-l"` / `t.starts_with("-l=")`；
  更稳的做法是把 `PATH_VALUE_ARGS` 旁边维护一张 `RESERVED_FLAGS: &[(&str,&str)]` 表
  （`-l`/`--listen-ip`、`--listen-port`），并加一条 `build_args_rejects_a_listen_override_in_extra_args`
  的 `-l` 用例（现有测试 `server.rs:1834-1847` 只测了长名）。涉及文件：`server.rs`。

### 2.2 `dir_is_within` 的白名单根由 webview 自己设定 —— 写/执行链

- 级别：**P1**
- 位置：`src-tauri/src/lib.rs:375`（读根） / `src-tauri/src/lib.rs:332-339`（写根）
- 现状：
  ```rust
  let output_dir = state.settings.lock().await.output_dir.clone();
  if !dir_is_within(&dir, &output_dir) { return Err(...); }
  ```
  而 `output_dir` 来自 `save_settings(state, mut settings: settings::Settings)` →
  `settings.save()` → `*state.settings.lock().await = settings`（`lib.rs:337-338`），
  `Settings` 里没有任何对 `output_dir` 的校验（`settings.rs:18`）。
- 问题：`lib.rs:373-374` 的注释把这条限制明确写成安全控制（「该命令是 webview 可调用的任意写入口：
  目录必须位于配置的输出目录内，防止被注入脚本写到任意位置（对抗性审查 C）」），但控制项的取值
  由同一个 webview 决定，**等价于没有控制**。两条命令即可：
  `save_settings({outputDir:"C:/Users/<u>/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"})`
  → `save_output({dir: 同值, name:"x", ext:"bat"})`。同一条链还能落到 2.2.1 的提权：
  1. `save_output` 的 `ext` 只做字符替换，**没有扩展名白名单**（`save.rs:62-91`），可写 `.exe`；
  2. `start_server(exe_path = "<outputDir>/sd-server.exe", ...)` 只要文件名以 `sd-server` 开头
     就跳过 `--list-devices` 身份探测（`server.rs:438-448`、`1242-1271`）。
- 上游/对照依据：Tauri 2 的 ACL（`capabilities/default.json`）**不覆盖应用自定义命令**，
  22+1 个 `#[tauri::command]` 对任何能执行 JS 的 webview 一律可达；这也是为什么
  「命令内自校验」必须真的自洽。参照 InvokeAI/SwarmUI 一类本地服务：把可写根固化为
  `app_config_dir()/outputs` 由后端推导，而不是接受前端传入。
- 建议（按代价排序，任一即可破链）：
  1. `save_settings` 对 `output_dir` 做「必须是绝对路径且不含 `..`」+ 首次设置需经 `pick_folder`
     产出的路径（后端可维护一个 `picked_dirs: HashSet<PathBuf>`，`pick_folder` 时登记）；
  2. `save_output` 增加扩展名白名单（`png/jpg/jpeg/webp/gif/mp4/webm`），与 `sdcpp` 家族的
     `output_format` 对齐；
  3. `start_server` 去掉「文件名以 sd-server 开头即免探测」的快速通道（`server.rs:1242-1244`），
     或把 `exe_path` 限制在 `exe_dir` 子树内。
  涉及文件：`lib.rs`、`save.rs`、`server.rs`、`settings.rs`。

### 2.3 设置是「全量替换 + 无未知字段兜底」，字段漂移会静默丢配置

> 对应 Lead 交办第 1 条。**核实成立**，但需要修正一点：当前 TS 与 Rust 的字段集是**一致**的
> （逐字段比对 `src/types.ts:8-65` 与 `settings.rs:12-129`，唯一差异是 TS 侧的 `loadWarning`
> 为响应专用字段），所以此刻没有正在丢的字段；风险是结构性的。

- 级别：**P2**
- 位置：`src-tauri/src/settings.rs:294` / `src-tauri/src/settings.rs:10-58`
- 现状：
  ```rust
  let data = serde_json::to_vec_pretty(settings).context("serialize settings")?;
  ```
  `Settings` 的每个字段都是 `#[serde(default)]`，没有 `#[serde(flatten)] extra: Map`，
  也没有 `deny_unknown_fields`；写回路径是「IPC → 反序列化成结构体 → 整体序列化 → 覆盖文件」。
- 问题：三个可复现的丢失场景：
  1. **降级**：0.8.6 写了新字段 `foo`，用户回退到 0.8.5（本仓库 `git log` 显示版本迭代很快，
     回退换内核是很常见的运维动作），旧版 `load → save` 一轮即丢 `foo`；
  2. **字段漂移**：前端 `types.ts` 先加字段、`settings.rs` 后补，中间任何一次保存都丢；
  3. **部分载荷**：`#[serde(default)]` 让 `save_settings({settings:{}})` 合法——它会
     把 `modelSnapshots`（用户为每个模型手调的家族/组件/VAE 配置）**整表清空**并落盘。
     这是本文件里唯一能造成「用户数据丢失」级后果的路径。
- 上游/对照依据：同类 GUI（sd.cpp-webui、KoboldCpp）都把配置文件当作不透明 JSON 存前缀；
  更稳妥的通用做法是写入前把「原始 JSON」与新结构体做 merge。
- 建议：`save_to` 先 `fs::read` 旧文件解析成 `serde_json::Value`，用
  `merge(value, serde_json::to_value(settings)?)`（后者覆盖同名字段、保留未知字段）再写；
  同时给 `Settings` 加 `schemaVersion: u32`（`#[serde(default)]`）+ 迁移函数表。
  成本：约 30 行，无需改前端。涉及文件：`settings.rs`。

### 2.4 退出时 `blocking_lock()` 最长会卡住关闭约 35 秒

> 对应 Lead 交办第 2 条。**核实成立**，但不会永久死锁（各持锁分支都有超时），是「长时间无响应」。

- 级别：**P2**
- 位置：`src-tauri/src/lib.rs:720-727`
- 现状：
  ```rust
  if let tauri::RunEvent::Exit = event {
      if let Some(state) = app_handle.try_state::<AppState>() {
          let mut server = state.server.blocking_lock();
  ```
- 问题：`server: Mutex<ServerManager>` 在 `start_server`（`lib.rs:215-220`）里被跨 `await` 持有，
  而 `ServerManager::start` 的持锁时长上限可逐段累加：
  | 段 | 位置 | 上限 |
  |---|---|---|
  | `cli::probe`（`--help`+`--version` 并发） | `cli.rs:264`、`cli.rs:299` | 5s（外加等全局 `CACHE` 锁，`cli.rs:292`） |
  | `probe_backend_devices` | `server.rs:1250-1256` | 20s |
  | `self.stop()` → `child.wait()` | `server.rs:1143` | 10s |
  | 启动后健康检查 | `server.rs:1358` | 0.4s |
  合计 ≈ **35.4s**（若期间还有 `preflight_server` 抢 probe 锁，可再叠加）。此时用户点关闭，
  进程会停在 `RunEvent::Exit` 里直到锁释放——窗口已消失但进程、显存、sd-server 都还在，
  用户视角是「关了但关不掉」，会再点一次图标（单实例插件只 focus，于是彻底卡住）。
- 上游/对照依据：Tauri 官方推荐的优雅退出模式是 `RunEvent::ExitRequested` + `prevent_exit()`
  + 异步收尾后 `app.exit(0)`；`blocking_lock` 在事件循环线程上同步阻塞是反模式。
- 建议：改两处（约 20 行）——(a) `ExitRequested` 里 `api.prevent_exit()`，`spawn` 一个任务
  `tokio::time::timeout(Duration::from_secs(8), async { ... kill ... }).await` 后 `app.exit(0)`；
  (b) 若保留同步路径，改用 `try_lock()` + 拿不到就 `kill` 已知 `pid`（`ServerManager::pid()`
  可以无锁快照），避免任何阻塞。涉及文件：`lib.rs`、`server.rs`。

### 2.5 日志完全不落盘，崩溃/误关后没有任何证据

> 对应 Lead 交办第 4 条。**核实成立**。

- 级别：**P2**
- 位置：`src-tauri/src/lib.rs:663` + `src-tauri/src/main.rs:2`
- 现状：
  ```rust
  let _ = env_logger::try_init();
  ```
  `main.rs` 一行 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 让 release
  没有控制台；`env_logger` 默认写 stderr → **丢弃**。全仓库 `OpenOptions`/`fs::write` 的调用点
  只有 `save.rs`（落图）、`settings.rs`（落配置），没有第三个（已 grep 确认）。
  sd-server 的 stdout/stderr 经 `spawn_log_reader`（`server.rs:1473-1556`）只转成
  `server-log` 事件，最终进 `src/store.ts:177-180` 的 2000 行环形缓冲。
- 问题：启动失败（缺 DLL、模型损坏、CUDA OOM）是**最高频的支持场景**，而 README 的
  「遇到问题先看这里」把用户导向日志面板；一旦 GUI 崩溃（GPU 驱动崩溃时并不罕见）或用户误关，
  这一轮全部证据随之消失，用户只能重跑一次复现。日志面板本身还有 1500 行裁剪（`store.ts:178`），
  长加载日志会被截断。
- 上游/对照依据：sd-server 自身用 `examples/common/log.cpp` 输出到 stderr，由调用者决定去向；
  ComfyUI（`comfyui.log`）、A1111（滚动日志）都落盘。同类 Tauri 应用一般用
  `tauri-plugin-log` 或 `log` 到文件 + `tracing_appender::rolling`。
- 建议：加一个 `simplelog`/`tracing-appender` 的 `WriteLogger`，写到
  `dirs::data_local_dir()/lumina/logs/lumina-YYYYMMDD.log`，按大小/天轮转保留 7 份；
  `spawn_log_reader` 同时 `log::info!(target:"sdcpp", "{clean}")`。成本：约 40 行 + 1 个依赖
  （或用已有的 `std::fs::File` + 手写轮转，零新依赖）。收益：把「支持成本」从「请用户再复现一次」
  降到「请发日志」。涉及文件：`lib.rs`、`server.rs`、`Cargo.toml`。

### 2.6 心跳兜底会周期性触发服务端全量 LoRA 扫描

- 级别：**P2**
- 位置：`src-tauri/src/sdcpp.rs:98-107`（对照同文件 44-47 的注释）
- 现状：
  ```rust
  let req = self.http.get(format!("{}/sdcpp/v1/capabilities", self.base));
  match req.timeout(Duration::from_secs(3)).send().await { ... }
  ```
  而 44-47 行注释自己写着：该端点「每次都会触发上游 refresh_lora_cache 对 lora-model-dir 做递归
  全量扫描，大模型目录下会让心跳超过 2s 超时」。
- 问题：`server_status` 每 3 秒被调用一次（`src/App.tsx:138` `setInterval(check, 3000)`），
  且**没有负缓存**。对于自编译/裁剪过的 sd-server（`/v1/models` 不返回 `sd-cpp-local`）或
  任何 id 与上游不一致的构建，每一次状态轮询都会：2s 超时 → 打 capabilities → 服务端递归扫
  LoRA 目录。`lora-model-dir` = 模型根目录（`src/lib/launchConfig.ts:146`），几千个模型文件时
  这一趟是秒级 CPU+磁盘；空闲时等于每 3 秒自残一次，还会与生成争 IO。
- 上游/对照依据：`examples/server/routes_sdcpp.cpp` 的 capabilities handler 调用
  `refresh_lora_cache`（本仓库注释已确认）；`routes_openai.cpp` 的 `/v1/models` 是静态 handler。
- 建议：给 `ping()` 加「本次进程内 capabilities 兜底连续失败 N 次后降级为只探 TCP 连接」的记忆
  （`AtomicU8` 即可），或干脆把兜底端点换成上游的 `/health`/`/v1/models` 之外任意静态路由；
  更简单的做法是把兜底结果缓存 30s。涉及文件：`sdcpp.rs`。

### 2.7 日志管道无背压、无单行上限，progress 事件重复发送

- 级别：**P2**
- 位置：`src-tauri/src/server.rs:1482-1550`
- 现状：
  ```rust
  let mut pending = String::new();
  ...
  if !pending.is_empty() {
      if let Some(pos) = pending.rfind('\r') {
          let after_cr = pending[pos..].trim_start_matches('\r');
  ```
- 问题：三点。
  1. `pending` 只按 `\n` 切割（`server.rs:1528-1531`）。sd-server 的进度行以 `\r` 结尾、**一直不换行**，
     一旦子进程输出一段不含 `\n` 的超长文本（`--verbose` 下的 ggml 张量表、或损坏的模型文件导致的
     二进制垃圾），`pending` 会无界增长到整个输出流大小；两个 reader 各持一份。
  2. **同一段文本被重复 emit**：第 1537-1550 行在**每个 chunk** 上把「最后一个 `\r` 之后的内容」
     作为 progress 再发一次，而这段文本仍留在 `pending` 里，下一个 chunk 又发一次；直到 `\n`
     到达时再整行发一次 `line`。3MB/s 的日志意味着每秒几十次重复事件，全靠前端去重。
  3. 背压：`app.emit` 是 fire-and-forget，webview 侧慢时事件在内核 IPC 队列里堆积，后端无任何
     丢弃/合并策略（对比 `read_capped`（`cli.rs:242-246`）对 probe 输出做了 256KB 上限——说明
     作者知道这个模式，只是没用到日志管道上）。
- 上游/对照依据：sd-server `examples/common/log.cpp` 的 `print_progress_line` 就是 `\r` 流；
  任何日志面板都需要「按行 + 单行截断 + 丢弃策略」。
- 建议：给 `pending` 加 `MAX_PENDING_LINE = 8 * 1024`（超出则强制切一行并加 `…(truncated)`）；
  把 progress 重发改成「内容未变化则不发」（保存 `last_progress: String` 比较后再 emit）；
  可选：对 `progress` 类事件做 100ms 节流。涉及文件：`server.rs`。

### 2.8 `list_output_files` 每次画廊打开都整读+解析全部图片

- 级别：**P2**（产出上千张图的重度用户会明显感到卡顿，且是「必然踩」而非边缘场景）
- 位置：`src-tauri/src/png_info.rs:223-231`、`src/components/generation/HistoryGallery.tsx:198`
- 现状：
  ```rust
  } else if ext == "png" {
      parse_png_metadata(&path_str)
  } else if ext == "webp" {
      parse_webp_metadata(&path_str)
  ```
  每张 png/webp 都 `fs::read` 整文件（`png_info.rs:58`、`104`）再线性找 chunk。
- 问题：画廊打开就会全量走一遍（`HistoryGallery.tsx:209-211` `useEffect → load()`），上限是
  5000 文件 × 单文件 64MB（`png_info.rs:9`、`13`）——理论上限 320GB 读盘。现实中「1000 张 8MB 的
  4K 图」也很常见，即每次切到历史页 ≈ 8GB IO + 1000 次 JSON 解析，全部在**一个**
  `spawn_blocking` 里（`lib.rs:440`），期间不返回任何进度；Tauri 的 blocking 池被占住时
  `save_output`/`read_thumbnail`/`scan_models` 都会排队。前端没有任何缓存或增量刷新
  （`load` 的依赖只有 `settings.outputDir`）。
- 上游/对照依据：sd-server 的 `image_metadata.cpp` 只在 CLI 侧解析单文件；同类 GUI 的图库用
  缩略图缓存 + 目录 mtime 索引（A1111 写 `log.csv`，ComfyUI 写 `outputs/*.json`）。
- 建议（最小改动，不需要前端）：`parse_*_metadata` 只读文件头——PNG 的 `tEXt` 一般在前 4KB 内，
  WebP 的 XMP 也在前部；把 `fs::read` 换成「按 chunk 流式读，命中 `parameters` 或读到 1MB 就停」。
  这样 8MB 图从「读 8MB」变成「读 ~64KB」，一个数量级。再进一步：`list_output_files` 返回
  `metadata: null` + 单独的 `read_image_metadata(path)` 命令按需拉。涉及文件：`png_info.rs`、
  `lib.rs`。

### 2.9 跨平台：反斜杠与非 UTF-8 路径被破坏，且让目录白名单恒失败

- 级别：**P2**（Linux/macOS 用户；Windows 用户不受影响，所以作者的多轮审查很难发现）
- 位置：`src-tauri/src/lib.rs:103-104`、`src-tauri/src/lib.rs:352`、`src-tauri/src/scanner.rs:114`
- 现状：
  ```rust
  let rc_str = rc.to_string_lossy();
  dc == rc || dc.starts_with(format!("{}{}", rc_str, std::path::MAIN_SEPARATOR))
  ```
  ```rust
  .map(|h| h.path().to_string_lossy().replace('\\', "/")))
  ```
- 问题：
  1. **非 UTF-8 路径**（POSIX 合法，如 Latin-1 文件名）：`to_string_lossy()` 把非法字节换成 U+FFFD，
     再拿去和真实 `PathBuf` 做前缀比较 → **永远 false**。用户在 `/data/作品/` 这种目录下保存，
     所有 `save_output`/`read_file_b64`/`list_output_files` 都会被「文件必须位于已配置的输出目录内」
     拒绝，且错误信息完全误导（配置明明是对的）。
  2. **反斜杠**：`to_slash` / `pick_folder` / `settings::path_string` 无条件把 `\` 换成 `/`。
     POSIX 里 `\` 是合法文件名字符，`/models/wan\2/` 会被改写成 `/models/wan/2/` —— 指向另一条路径。
     同一个转换还写进 `settings.json`，于是「保存时的路径」与「下次启动读到的路径」不同。
  3. 对照：`png_info.rs:132-141` 有一个专门处理 `\\?\UNC\` 的 `strip_verbatim`，说明作者已经意识到
     这类问题；但 `dir_is_within` 自己没复用它。
- 上游/对照依据：`dirs::config_dir()` 在三个平台都返回 `PathBuf`（可以非 UTF-8），
  项目里凡是 `String` 化路径的地方都应使用 `Option<&str>` 分支或 `OsStr` 比较。
- 建议：`dir_is_within` 的 canonicalize 分支直接用 `Path` 比较（`dc == rc || dc.starts_with(&rc)`），
  删掉 `to_string_lossy()`；`to_slash` 改成 `#[cfg(windows)]` 才做替换。涉及文件：`lib.rs`、
  `scanner.rs`、`settings.rs`。

### 2.10 扫描器完全看不见链接目录（Windows junction / Unix symlink）

- 级别：**P2**（Windows 上跨盘共享模型库的主流做法就是 junction，且不需要管理员权限）
- 位置：`src-tauri/src/scanner.rs:368-381`、`452-454`
- 现状：
  ```rust
  let file_type = match entry.file_type() { ... };
  if file_type.is_dir() { ... }
  ...
  if !file_type.is_file() { continue; }
  ```
- 问题：`DirEntry::file_type()` 按文档「不遍历符号链接」，我在这台机器上实测确认
  （`mklink /J` 出的 junction：`is_dir=false is_file=false is_symlink=true`，而
  `fs::metadata(junction).is_dir()==true`）：
  ```
  jlink        is_dir=false is_file=false is_symlink=true
  metadata(junction).is_dir = true
  ```
  于是 `walk` 既不递归也不当文件收，**整个链接目录被静默跳过**，`ScanResult` 里没有任何 warning
  （`skipped_directories` 不计数），用户只会看到「模型列表里少了一半」。常见场景：
  `D:\models` junction 到 `E:\models`、`~/models -> /mnt/data/models`。
  好消息是这也**避免了符号链接成环**——`walk` 没有 visited 集，如果哪天有人「顺手」把判断改成
  `fs::metadata()`，就会立刻变成无限递归 + 栈溢出，这一点值得加注释锁住。
- 上游/对照依据：ComfyUI 的 `folder_paths` 用 `os.walk(followlinks=True)`；
  `examples/server/runtime.cpp` 一侧不做目录发现，无对照压力。
- 建议：`if file_type.is_symlink()` 时改用 `fs::metadata(&path)` 判断目标类型，并**同时**加
  「规范化路径去重集 + 最大深度」两重保护（`scanner.rs:9` 的 `MAX_DEPTH` 已经能限制深度，
  但环内每层都算深度，最终会因 `depth > 3` 退出，所以不会无限递归——仍建议显式 visited 集）。
  涉及文件：`scanner.rs`。

### 2.11 发布包带 WebView Inspector（devtools）

> 对应 Lead 交办第 3 条。**核实成立，且比 Lead 预期更彻底**：即使删掉 Cargo 特性也不够。

- 级别：**P2**
- 位置：`src-tauri/Cargo.toml:16`
- 现状：
  ```toml
  tauri = { version = "2", features = ["devtools"] }
  ```
  全仓库没有条件编译包裹，也没有任何代码调用 `open_devtools()`。
- 问题：两层。
  1. 该特性让 Tauri 在 **release** 里编译进 `OpenDevTools`（`tauri-runtime-wry` 源码里是
     `#[cfg(any(debug_assertions, feature = "devtools"))]`），也就是
     `docs` 所说「debug 构建默认有、release 需 devtools 特性」；
  2. 更关键：`tauri-runtime-wry/src/lib.rs:5148`
     `with_devtools(webview_attributes.devtools.unwrap_or(true))`，而本项目从未调 `.devtools(false)`、
     `tauri.conf.json` 也没设 `devtools`（`tauri-utils` 的 `WindowConfig` 有这个字段）→
     wry 在 WebView2 上执行 `SetAreDevToolsEnabled(true)`（`wry/src/webview2/mod.rs:640`），
     **F12 / 右键「检查」在发布包里本来就能用**。`devtools` 特性只是额外把 Rust 侧 API 编进来。
  后果：任何能在这台机器上操作 GUI 的人（或任何走社交工程让用户按 F12 的脚本）都能在
  console 里 `__TAURI_INTERNALS__.invoke('save_settings'|'save_output'|'start_server', …)`，
  而应用自定义命令不受 `capabilities/default.json` 约束——这正好把 2.2 的链条变成「零成本」。
- 上游/对照依据：Tauri 官方文档对 `devtools` 特性的说明；社区惯例是
  `devtools = []` 放进 `[features]` 并 `default = []`，或在窗口配置里写 `"devtools": false`。
- 建议：`tauri.conf.json` 的 `main` 窗口加 `"devtools": false`（一行，发布包即失效）；
  Cargo 侧改成
  ```toml
  [features]
  devtools = ["tauri/devtools"]
  ```
  并在 dev 脚本里 `--features devtools`。涉及文件：`tauri.conf.json`、`Cargo.toml`。

### 2.12 CSP 放开了任意本地端口（`connect-src http://127.0.0.1:*`）

- 级别：**P2**
- 位置：`src-tauri/tauri.conf.json:28`
- 现状：
  ```
  "csp": "default-src 'self'; connect-src http://127.0.0.1:*; img-src 'self' data: blob:; ..."
  ```
- 问题：前端**完全不用**直连 HTTP——全仓库 `src/**` 里对 `fetch(`/`XMLHttpRequest`/`127.0.0.1`/`localhost`
  的搜索只有两处非代码命中（`Dashboard.tsx:1463` 的文案、`logFormat.test.ts:33` 的测试字符串），
  所有请求都走 `invoke` → Rust 的 reqwest。也就是说这条 `connect-src` 是**纯多余**的放行，
  它的唯一作用是让「任意注入脚本」可以探测/调用本机所有 HTTP 服务（Ollama 11434、
  LM Studio、Docker、以及任何只监听 localhost 管理端口的服务）。这与 2.11 的 devtools 叠加后
  是可利用的。
  另外 CSP 缺 `object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`。
- 上游/对照依据：Tauri 的 CSP 模板里 `connect-src ipc: http://ipc.localhost` 是必需的，
  但 `http://127.0.0.1:*` 不是；本项目在 Windows 上 IPC 走 `http://ipc.localhost`/自定义协议，
  由 Tauri 自动注入，不需要这条。
- 建议：删掉 `connect-src http://127.0.0.1:*`（若担心 dev 模式热更新，用
  `devCsp`/`"csp": null` 只在 dev 生效），并补 `object-src 'none'; base-uri 'none'`。
  涉及文件：`tauri.conf.json`。

### 2.13 CLI 探测：全局锁跨进程持有、只有一条缓存、超时不可取消

- 级别：**P2**
- 位置：`src-tauri/src/cli.rs:291-299`、`src-tauri/src/server.rs:1250-1256`
- 现状：
  ```rust
  static CACHE: OnceLock<Mutex<Option<CachedProbe>>> = OnceLock::new();
  let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
  ```
- 问题：
  1. 这把 `tokio::sync::Mutex` 在**整个探测期**（两次 spawn 子进程，各 5s 超时）被持有；
     `inspect_server`/`preflight_server`/`start_server` 三条命令全部串行化在这把锁上。
     前端切换模型的路径是 `preflight` → `start`（`src/hooks/useModelSwitch.ts:115`），
     两次探测串行 ≈ 最多 10s，而这段时间用户看到的是「无响应」。
  2. 缓存是单个 `Option`，交替探测两个内核（`sd-server-cuda` / `sd-server-vulkan`）时**必然 miss**。
  3. `server.rs:1250-1256` 用 `tokio::time::timeout(20s, spawn_blocking(...))` 包 `probe_backend_devices`：
     `spawn_blocking` **不可取消**，超时只放弃等待，`std::process::Command::output()`
     （`server.rs:571`）既不会被 kill 也不会回收——一个卡在 `--list-devices` 的二进制会留一个
     永久阻塞的线程 + 一个僵尸子进程。
- 上游/对照依据：`cli.rs` 自己的注释（`248-249`）写着「dropping a timeout must not leave a probe
  child alive」，`probe_output` 用 `kill_on_drop` 做到了；同样的标准没有应用到
  `probe_backend_devices`（那里仍是 `std::process::Command`）。
- 建议：把 `probe_backend_devices` 换成 `cli::probe_output` 同款（tokio + `kill_on_drop` + 上限读取）；
  缓存改 `HashMap<ProbeKey, CachedProbe>`；锁只在读/写缓存时持有，探测在锁外做（双检）。
  涉及文件：`cli.rs`、`server.rs`。

### 2.14 构建门禁缺失：fmt 不过、clippy 不过、无 CI

- 级别：**P2**（与 build-test 组重叠，此处只给本组实跑的事实与「漏掉了哪类缺陷」）
- 位置：仓库根 / `src-tauri/src/cli.rs:314` / `src-tauri/src/scanner.rs:300`
- 现状（真实输出）：
  ```
  $ cargo fmt --check            → exit 1，family.rs 8 处 hunk
  $ cargo clippy --all-targets   → 2 warnings (3.70s)
      cli.rs:312-314  unnecessary_unwrap   key.is_some() ... key.unwrap()
      scanner.rs:300  too_many_arguments   8/7
  $ cargo clippy --all-targets -- -D warnings → exit 1
  $ cargo test                   → 89 passed; 0 failed (5.7s)
  ```
- 问题：`cli.rs:312-314` 不只是风格问题——`if caps.verified && key.is_some() && key == probe_key(exe)`
  然后 `key.unwrap()`，这里 `key == probe_key(exe)` 会**再算一次 `metadata()`**，说明「判空」和
  「取用」之间作者自己也担心过时序；改 `if let (Some(key), true) = (key, ...)` 就同时消掉
  TOCTOU 疑虑和 lint。`scanner.rs:300` 的 8 个参数正是 2.10/2.8 那类「walk 逻辑不断加参数」的产物，
  clippy 命中的是**结构已经开始腐化**的信号（`walk` 已经在传 `base/depth/skip/category_hint/
  package_family/out/context`，再加就没人读得懂）。没有 CI 意味着这两条会一直存在，
  下一个改 `walk` 的人也不会收到任何提醒。
- 建议：`-D warnings` 现在就成立（只差 2 处），先修这 2 处 + `cargo fmt`，再加
  `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` 到任意 CI
  （GitHub Actions 单 job 即可，无需缓存优化）。涉及文件：`cli.rs`、`scanner.rs`、`family.rs`、
  `.github/workflows/ci.yml`（新增）。

### 2.15 设置写入：无 schemaVersion、临时文件残留

- 级别：**P3**
- 位置：`src-tauri/src/settings.rs:295-326`
- 现状：
  ```rust
  let temp = unique_sibling(path, "tmp");
  ...
  if write_result.is_err() { let _ = fs::remove_file(&temp); }
  ```
- 问题：崩溃/断电会留下 `settings.json.tmp.<pid>.<nanos>`，没有任何清理逻辑，反复失败会累积；
  配置本身没有 `schemaVersion`（见 2.3），迁移只能靠「字段默认值」推断。
  `ReplaceFileW(REPLACEFILE_WRITE_THROUGH)` + `file.sync_all()` + 目录 `sync_all()`
  （`settings.rs:306`、`317-319`）已经是相当扎实的原子写，这点值得肯定。
- 建议：`save_to` 开头扫一次同目录 `settings.json.tmp.*` 并删除超过 1 小时的文件；
  加 `schemaVersion`。涉及文件：`settings.rs`。

### 2.16 `dir_is_within` 的「root 不存在」兜底与它自己的注释相反

- 级别：**P3**
- 位置：`src-tauri/src/lib.rs:112`
- 现状：
  ```rust
  (None, _) => !std::path::Path::new(raw_root).exists(),
  ```
  注释（108-111 行）说的是「root 存在却解析失败（ACL/长路径等）说明 symlink 兜底已失效，保守拒绝」。
- 问题：`Path::exists()` 在**任何** IO/权限错误上都返回 `false`（它不是 `try_exists`）。所以
  「ACL 拒绝 → 解析失败」这种正是注释想拒绝的情况，会被 `exists()==false` 判成「root 不存在」
  从而返回 `true`（放行）。行为与注释相反，且是放行方向。改成 `try_exists()` 就能让两者一致。
- 建议：`matches!(std::fs::symlink_metadata(raw_root), Err(e) if e.kind() == NotFound)`。
  涉及文件：`lib.rs`。

### 2.17 `output_dir` 归一化为空时所有命令被拒，错误信息误导

- 级别：**P3**
- 位置：`src-tauri/src/lib.rs:71-74`
- 现状：
  ```rust
  let root = norm(root.trim());
  if root.is_empty() { return false; }
  ```
  `norm` 会剥掉所有空组件与前导 `/`，所以 `output_dir = "/"`（Linux 根）、`"."`、`".."`、
  `"//"` 都归一化成空串。
- 问题：这类配置（或 `save_settings` 传空串）下，所有读写命令都会返回
  「文件必须位于已配置的输出目录内」，用户明明配了 `/`。前端目前有 `if (!dir)` 兜底
  （`useJobPolling.ts:178`），但 `read_file_b64`/`delete_output_file` 的调用方在画廊里，
  没有等价兜底。
- 建议：`norm` 里保留根标记（例如返回 `Option<String>`，`/` → `/`）；或在 `save_settings`
  拒绝空/根目录并回显可读错误。涉及文件：`lib.rs`、`settings.rs`。

### 2.18 `inspect_server` / `preflight_server` 不做二进制身份校验

- 级别：**P3**
- 位置：`src-tauri/src/lib.rs:181-197`、`src-tauri/src/server.rs:396-434`
- 现状：`resolve_executable` 只校验「存在 + 可执行」（`server.rs:420-432`），
  `exe_name_looks_like_sd_server` 只在 `start()`（`server.rs:1242`）里用。
- 问题：`inspect_server("C:/Windows/System32/whatever.exe")` 会以 `--help` / `--version` 启动
  任意可执行文件（`cli.rs:250-286`）。危害有限（只说参数可控、且 webview 本来可信），
  但与 `start()` 的严格口径不一致，属「同一事实两套标准」；配合 2.2 的链条时，探测这一层
  不构成任何阻碍。
- 建议：把 `exe_name_looks_like_sd_server` + `--list-devices` 身份探测提取成
  `resolve_and_verify_executable`，三条命令共用。涉及文件：`server.rs`、`lib.rs`。

### 2.19 命令面：23 个命令、1 个无人调用、`parse_png_metadata` 与画廊实际路径不一致

- 级别：**P3**
- 位置：`src-tauri/src/lib.rs:693-717`
- 现状：`invoke_handler` 注册了 **23** 个命令（不是 22：`start_server, inspect_server,
  preflight_server, stop_server, server_status, scan_models, detect_family, load_settings,
  save_settings, pick_folder, pick_file, save_output, save_as, parse_png_metadata,
  list_output_files, read_file_b64, read_thumbnail, delete_output_file, sdcpp_capabilities,
  sdcpp_submit, sdcpp_job, sdcpp_cancel, sdcpp_upscale`）。grep 全前端：
  `parsePngMetadata` 只在 `src/api.ts:98` 定义，**没有任何调用方**（画廊用的是
  `listOutputFiles` 里内联返回的 `metadata`）。
- 问题：一条「读任意文件 + 解析」的命令长期无调用方，是纯粹的攻击面与维护负担
  （它还带着 `dir_is_within` 校验、spawn_blocking、错误映射，共 ~19 行）。
- 建议：删掉 `parse_png_metadata`（或其前端封装），或在 `api.ts` 注释里标明保留原因。
  涉及文件：`lib.rs`、`png_info.rs`、`src/api.ts`。

### 2.20 `refine_component_dirs` 只在 `start` 生效，preflight 校验的是另一套 argv

- 级别：**P3**
- 位置：`src-tauri/src/server.rs:1184`（start 调用）vs `src-tauri/src/server.rs:348-362`（preflight）
- 现状：`start()` 里 `refine_component_dirs(&mut args_json)` 会把 `embd-dir` 收窄到
  `embeddings/` 子目录（`server.rs:509-554`），而 `preflight_cli` 直接 `build_args(&args, ...)`
  用的是**未收窄**的参数。
- 问题：对 `embd-dir` 这类路径参数，`validate_path_arg` 只查「存在/是目录」，收窄不会改变结论，
  所以当前没有实际 bug；但「preflight 校验的 argv ≠ 真正启动的 argv」是一条会随时间腐化的裂缝
  （任何一条依赖路径值的校验都会在两边分叉）。`refine_component_dirs` 还是唯一读盘做决策的
  参数改写（`dir_has_small_embedding_files` 会 `read_dir` + `metadata`），本身也可能慢。
- 建议：把 `refine_component_dirs` 移到 `build_args` 之前的两条路径共用（提取
  `prepare_launch_args(exe, args) -> (args, warnings)`）。涉及文件：`server.rs`。

### 2.21 `check_alive` 的 `try_wait` 错误分支不清理子进程状态

- 级别：**P3**
- 位置：`src-tauri/src/server.rs:1101-1104`
- 现状：
  ```rust
  Err(error) => {
      self.last_error = Some(format!("failed to query sd-server status: {}", error));
      false
  }
  ```
- 问题：返回 `false` 但保留了 `self.child`、`self.port`、`self.pid()`。于是 `server_status`
  会同时报 `running:false` + `pid:Some(..)` + `phase:"failed"`，前端无法判断该不该展示「停止」
  按钮；`active_port()` 仍返回旧端口，代理继续打到已经不存在的端口。`try_wait` 出错本身罕见
  （句柄失效），所以是 P3。
- 建议：错误分支同样 `clear_child_state()`。涉及文件：`server.rs`。

### 2.22 可维护性：`server.rs` 2,005 行承载 6 类职责

- 级别：**P3**
- 位置：`src-tauri/src/server.rs:1-1556`（非测试部分；1,557 行起是 448 行测试）
- 现状：单文件里同时住着（按行区间）参数拼装与路径校验（93-338）、CLI 探测与 backend 预检
  （396-874）、Windows JobObject / Unix pdeathsig / 看门狗（876-1025）、进程生命周期
  （1027-1387）、ANSI 与日志管道（1389-1556）、以及 445 行测试。
- 问题：每次新增上游参数，改动都落在同一个文件（本仓库 git history 就是「同步上游 → 修复审问题」
  的模式），diff 冲突面大；`walk` 的 8 参数（2.14）与 `build_args` 的 130 行 match 是同一趋势的
  产物。这不是「必须改」的缺陷，但它解释了为什么 2.1（短别名漏检）这种问题会出现：
  参数校验分散在 `build_args`（token 级）、`validate_path_arg`（路径级）、`extra_arg_values`
  （取值级）、`cli::validate_args`（能力级）四处，没有一张「上游 ArgOptions 的单一真源表」。
- 建议：新建 `args.rs`，把 `PATH_VALUE_ARGS` / 监听标志 / short-long 别名收敛成一张
  `const UPSTREAM_ARG_ALIASES: &[(&str, &[&str])]`，`build_args`/`validate_path_arg`/
  `cli::validate_args` 都从它派生；`server.rs` 只留进程生命周期。涉及文件：`server.rs`（拆出
  `args.rs`、`log.rs`）。

### 2.23 已核实不成立（记录用）：`pick_folder` / `pick_file` / `save_as` 不需要路径校验

> 对应 Lead 交办第 5 条。**核实结论：不成立，现状可接受。**

- 位置：`src-tauri/src/lib.rs:347-361`、`src-tauri/src/save.rs:161-182`
- 事实：
  - `pick_folder()` / `pick_file()`（`lib.rs:347-361`）**零参数**，签名里没有任何前端可控输入，
    返回的路径 100% 来自 rfd 系统对话框，调用方无法指定。不存在「被前端传入的任意路径绕过」的入口。
  - `save_as(b64, ext, name)`（`save.rs:161-182`）只用 `ext`/`name` 生成对话框的**默认文件名**
    （`set_file_name`，`save.rs:167`），两个值都过 `sanitize_component`；真正写盘的路径来自
    `handle.path()`（用户在选择器里点的位置），`fs::write` 到该路径。符合预期。
  - 唯一不一致：`save_as` 用 `fs::write` **覆盖**（`save.rs:180`），而 `save_output` 用
    `create_new` 拒绝覆盖（`save.rs:110-114`）。覆盖是用户在对话框里明确确认过的，语义上没问题；
    但两处写盘口径不同、且 `save_as` 不做 `sync_all`，若哪天被复用容易踩。**P3**，不需要动。
- 附带修正：`invoke_handler` 实际注册 **23** 条命令（见 2.19），不是 22。

## 3. 待验证假设

以下没有做到「跑起来看」的程度，列出来供 Lead 决定是否追。

1. **`blocking_lock` 在 `RunEvent::Exit` 里是否会 panic**：`tokio::sync::Mutex::blocking_lock`
   文档说「在异步上下文中调用会 panic」。本仓库的事件回调来自 tao 的消息循环线程，
   正常情况不在 tokio 上下文里，所以理论安全；但我没有在真实 GUI 里构造「start 中途关窗」的时序
   来实测。若成立则是「偶发崩溃」而不是「卡住」，级别要上调。
2. **devtools 是否真的能用 F12 打开**：我核实的是代码路径
   （`tauri-runtime-wry ... unwrap_or(true)` → `wry SetAreDevToolsEnabled(true)`），
   没有在打包产物里实测按键。WebView2 的默认右键菜单由
   `SetAreDefaultContextMenusEnabled(pl_attrs.default_context_menus)`（`wry/src/webview2/mod.rs:638`）
   控制，Tauri 未关闭它 → 右键「检查」应当可用。
3. **`dir_is_within` 的 TOCTOU**：`save_output` 是「先 `canonicalize` 判定，再 `create_dir_all`」
   （`lib.rs:376` → `save.rs:143`）。若本地攻击者在这两步之间把输出目录里的子目录换成
   junction/symlink，可写到目录外。需要本地写权限，威胁模型上优先级低（未列为正式结论）。
4. **Windows 8.3 短名与尾随点号**：我推演出它们只会造成**误拒**（合法的同一目录两种写法被判
   not-within），不会造成逃逸；没有构造实测。若某天 `pick_folder`/手输造成短名与长名混用，
   症状会是「明明在输出目录里却保存失败」，届时按 2.9 的同一处修（用 `Path` 比较 + 两边都
   `canonicalize` 已经做了，误拒主要来自 76 行的词法门）。
5. **`days_to_date`（`save.rs:203-228`）线性扫年**：只用于文件命名兜底，正常时钟无风险；
   RTC 被设到很远的未来（如 5000 年）时会空转约 3000 次，可忽略。
6. **`server_status` 与 3s 轮询的叠加**：`ping()` 最坏 5s（2s+3s），而 `App.tsx:138` 的
   `setInterval` 不等待，慢时会重叠请求。是否真的重叠取决于 sd-server 的响应时间，
   我没有实测；若重叠，`reqwest` 连接池 + 服务端并发会放大 2.6 的代价。

## 4. 与其它组可能重叠的点（Lead 合并用）

| 本报告条目 | 可能重叠的组 | 建议归属 |
|---|---|---|
| 2.1 `-l` 绕过监听守卫 | **cli-families**（附加启动参数的校验归属） | Rust 侧判定归我，但用户可见路径（extra_args 输入框、错误文案）归它 |
| 2.2 `output_dir` 可被 webview 改写 / `save_as`、`pick_*`（Lead 第 5 条已核：三者都没有接收前端路径，`pick_folder`/`pick_file` 零参数、`save_as` 只用 rfd 返回值写盘，**不存在被前端绕过的问题**；唯一小瑕疵是 `save_as` 用 `fs::write` 覆盖写而 `save_output` 用 `create_new`，口径不一致） | **frontend-arch**（谁会调 `save_settings`）、**ux-a11y**（错误提示） | 安全边界归我 |
| 2.3 settings 字段漂移 | **frontend-arch**（`types.ts` 与 `settings.rs` 双写）、**api-alignment** | 我给出「写前 merge + schemaVersion」的最小方案 |
| 2.5 日志落盘 / 2.7 日志背压 | **frontend-arch**（`store.logs` 2000 行上限、日志面板渲染）、**ux-a11y**（「一键复制日志」按钮） | 后端管道归我 |
| 2.6 心跳扫 LoRA / 2.8 画廊整读 | **frontend-arch**（`HistoryGallery` 刷新策略、3s 轮询） | 后端成本归我，轮询节奏归它 |
| 2.11 devtools / 2.12 CSP | **build-test**（发布配置）、**ux-a11y**（若有 XSS 面） | 配置项归 build-test，风险链归我 |
| 2.14 fmt/clippy/CI | **build-test**（工程化） | 我提供实跑输出，它负责落 CI |
| 2.10 链接目录扫不到 | **cli-families**（模型发现与家族识别） | 归属模糊，建议给 cli-families，因为它更接近「模型目录布局」 |
| 2.20 `refine_component_dirs` 的 `embd-dir` 收窄 | **cli-families**（上游 family 文档） | 上游语义它更熟 |
