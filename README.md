# 流光 Lumina

**stable-diffusion.cpp 的桌面图形界面**——基于 Tauri 2 + React 18 构建，用于管理 `sd-server` 的生命周期并提供完整的图片/视频生成界面。它取代了仓库原有的 webui，作为一个独立的本地桌面应用运行（不在标准 CMake 构建流程内）。

界面分为两屏：**控制台（Dashboard）** 负责配置路径、扫描模型、识别模型家族并启动服务器；服务器就绪后自动进入**生成界面（Generation）** 进行参数调节与出图。

---

## 功能特性

### 控制台（Dashboard）
- **路径配置**：`sd-server.exe` 所在目录、模型根目录、输出目录，均支持手动输入或原生文件夹选择对话框。
- **模型扫描**：递归扫描模型目录（最多 3 层），识别 `.safetensors` / `*.safetensors.index.json` / `.gguf` / `.ckpt`，自动归类为 model / vae / clip_l / clip_g / t5xxl / clip_vision / llm / lora / motion_module 等组件；分片索引引用的 shard 会从可选模型中隐藏，避免误选不完整权重。
- **ComfyUI 目录结构支持**：自动识别 `diffusion_models`、`vaes`/`vae`、`text_encoders`/`llms`、`loras`/`lora` 等专用子目录，未命中时回退到通用递归扫描。
- **模型家族自动识别**：根据文件名/路径推断模型家族（Flux、SDXL、SD3、Wan、Qwen-Image、Z-Image、Chroma、LTX 等 30+ 类），自动给出所需组件清单与推荐生成参数；识别结果可手动覆盖。
- **运行后端选择**：预设 `自动` / `首个可用 GPU` / `CUDA` / `ROCm/HIP` / `Vulkan` / `仅 CPU`，并支持组件级自定义 `--backend`（例如 `clip=cpu,vae=cuda0,diffusion=vulkan0`）。
- **参考图处理预设**：可在模型启动时选择 Kontext、Qwen、Flux 2、Krea2、Anima 等参考图处理模式，默认由模型架构自动检测。
- **服务器控制**：一键启动/停止；可检测并接管在同端口运行的**外部 sd-server** 进程。

### 生成界面（Generation）
- **图片 / 视频两种模式**（`img_gen` / `vid_gen`），随模型能力动态显示。
- **提示词**：正向 / 反向提示词。
- **LingBot 辅助**：提供结构化 JSON 提示词模板、提交前 JSON 校验和 33/49/81 帧快捷项。
- **图像输入**：初始图片、蒙版、Control 图片、参考图片、视频结束帧——按模型支持的能力动态显示；上传初始图片时自动按其像素尺寸对齐到 64 并填充宽高。
- **尺寸与种子**：按比例分组的尺寸预设（1:1、4:3、16:9、9:16、21:9 等）、手动宽高、随机/固定种子、批量数量、视频帧数与 FPS。
- **采样设置**：采样器、调度器、步数、文本 CFG、蒸馏 CFG（Flux 等蒸馏模型）、Eta、Flow Shift、SLG Scale、VAE 分块、采样缓存（EasyCache / UCache / DBCache / TaylorSeer / Cache-DiT / Spectrum）、CLIP Skip。
- **LoRA**：多条 LoRA 叠加，每条独立强度滑块。
- **高清修复**：内置放大器（Latent 系列 / Lanczos / Nearest）或 ESRGAN 模型，可调步数、缩放、降噪强度。
- **任务队列**：提交后每 2 秒轮询任务状态，展示排队/生成/完成/失败/取消；支持取消、删除、清空、按队列上限拦截。
- **结果管理**：结果网格、点击放大查看（支持滚轮缩放、拖拽平移）、下载（原生"另存为"对话框）、一键"应用此配置"恢复历史参数。
- **自动保存**：配置了输出目录时，生成完成自动落盘。
- **服务器日志面板**：底部可折叠面板，实时显示 `sd-server` 的 stdout/stderr（含 `\r` 进度行的原地刷新）。

### 快捷键
| 快捷键 | 功能 |
|--------|------|
| `Ctrl` + `Enter` | 提交生成 |
| `Ctrl` + `R` | 切换随机种子 |
| `Esc` | 关闭放大预览 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri 2 |
| 前端 | React 18 + TypeScript 5 |
| 状态管理 | Zustand 5 |
| 构建工具 | Vite 5 |
| 后端语言 | Rust（Edition 2021） |
| HTTP 客户端 | reqwest（连接 sd-server `/sdcpp/v1`） |
| 异步运行时 | Tokio |
| 原生对话框 | rfd |

---

## 目录结构

```
gui/
├── index.html                 # Vite 入口
├── package.json               # 前端依赖与脚本（包名 lumina）
├── vite.config.ts             # Vite 配置（dev 端口 1420）
├── tsconfig.json              # TypeScript 严格模式配置
├── src/                       # 前端源码
│   ├── main.tsx               # React 入口（含右键菜单接管）
│   ├── App.tsx                # 顶层：阶段切换 + 服务器状态/日志订阅
│   ├── api.ts                 # Tauri 命令的类型化封装
│   ├── types.ts               # 与 Rust 结构体 / sd-server API 对齐的类型
│   ├── store.ts               # Zustand 全局状态
│   ├── config/
│   │   └── families.ts        # 模型家族元数据、尺寸预设、采样器/调度器显示名
│   ├── lib/
│   │   └── utils.ts           # 请求体构造、base64/blob、深拷贝/合并等工具
│   └── components/
│       ├── dashboard/Dashboard.tsx       # 控制台
│       ├── generation/GenerationUI.tsx   # 生成界面
│       └── ui/                # Panel / Slider / Toggle / Toast / LogPanel / ImageUpload / Icons
└── src-tauri/                 # Rust 后端
    ├── Cargo.toml
    ├── tauri.conf.json        # 窗口、打包、安全策略
    ├── capabilities/default.json
    └── src/
        ├── main.rs            # 入口
        ├── lib.rs             # Tauri 命令注册 + 退出时清理
        ├── server.rs          # sd-server 进程管理 + 日志流捕获
        ├── sdcpp.rs           # sd-server /sdcpp/v1 HTTP 客户端
        ├── scanner.rs         # 模型目录扫描
        ├── family.rs          # 模型家族检测与文件分类
        ├── settings.rs        # 设置持久化
        └── save.rs            # 输出落盘 / 另存为
```

---

## 环境要求

- **Node.js 20.19+** 与 npm（仓库提供 `.nvmrc`；当前锁定依赖不支持 Node 18）
- **Rust 工具链**（stable，含 Cargo）
- **Tauri 2 平台前置依赖**：
  - **Windows**：Microsoft Visual Studio C++ 生成工具、WebView2 运行时（Win11 自带）
  - **Linux**：`webkit2gtk`、`libappindicator` 等（参见 Tauri 官方文档）
  - **macOS**：Xcode 命令行工具
- **已编译的 `sd-server`**：本 GUI 不包含推理引擎本身，需先按[主仓库构建说明](../docs/build.md)编译出 `sd-server`（`build/bin/sd-server` 或 `sd-server.exe`）。

---

## 开发与构建

所有命令均在 `gui/` 目录下执行。

```bash
# 安装前端依赖
npm install

# 开发模式（启动 Vite + Tauri 开发窗口，带热更新）
npm run tauri dev

# 打包正式版（生成安装包 / 可执行文件）
npm run tauri build
```

仅调试前端（不启动桌面窗口）：

```bash
npm run dev        # 启动 Vite 开发服务器（http://127.0.0.1:1420）
npm run build      # tsc 类型检查 + Vite 生产构建到 dist/
```

构建产物：`src-tauri/target/release/` 下的可执行文件，以及 `src-tauri/target/release/bundle/` 下的安装包。

---

## 五分钟首次运行

1. 按[构建说明](../docs/build.md)编译 `sd-server`，或从项目 Release 获取与当前源码兼容的构建。
2. 先在终端运行一次 `sd-server --help`，确认可执行文件和运行库可用。
3. 准备一个模型目录。完整 checkpoint 可以是单个 `.safetensors`、`.ckpt` 或 `.gguf`；Flux、SD3、Wan、Qwen 等拆分模型通常还需要 VAE、CLIP/T5/LLM 等组件。
4. 在 `gui/` 中执行 `npm install` 和 `npm run tauri dev`。
5. 在控制台选择 `sd-server` 可执行文件、模型根目录和输出目录。`sd-server` 已加入 PATH 时，可执行文件一栏可以留空。
6. 等待扫描完成，选择主模型。必需组件会标为必填；只有一个合适候选时 Lumina 会自动选择。
7. 初次使用建议保持“自动”后端。显存不足时打开“CPU 卸载”，并参考[性能指南](../docs/performance.md)与[后端选择指南](../docs/backend.md)。
8. 点击“启动服务器”，等待状态从“正在加载模型”变为“就绪”，再提交一张小尺寸测试图。
9. 如果配置了输出目录，请在首张结果卡片上确认“已保存”，并检查目标目录中确实生成了文件。

### 模型目录示例

```text
models/
├── checkpoints/            # 完整 SD/SDXL checkpoint
├── diffusion_models/       # Flux/Wan/Qwen 等 diffusion 模型
├── vae/                    # VAE
├── text_encoders/          # CLIP/T5/LLM
├── loras/                  # LoRA
└── upscale_models/         # ESRGAN 等放大模型
```

Lumina 也支持不采用上述目录名的普通文件夹，但自动分类准确率取决于文件名。拆分模型启动前应检查界面列出的每个必需组件；“可选”字段可以留空。

## 使用流程

1. 启动 Lumina，进入控制台。
2. 在 **sd-server** 一栏选择可执行文件；如果它已经在 PATH 中，也可以留空。
3. 在 **模型目录** 选择存放模型的根目录，Lumina 会自动扫描并统计文件数。
4. 在 **模型检测** 中选择主模型；Lumina 会自动识别家族并列出该家族需要的组件（VAE、文本编码器等），在 **组件配置** 中逐项选择。
5. （可选）在 **运行后端** 选择 CUDA / Vulkan / CPU 或填写自定义 `--backend`。
6. 点击 **启动服务器**。日志面板会显示加载进度；模型就绪后自动进入生成界面。
7. 在生成界面调节参数、输入提示词，按 **生成** 或 `Ctrl+Enter` 出图。
8. 在底部日志面板可随时 **停止服务**（即卸载模型、释放显存），返回控制台重新选择模型。

> **自动保存**：在控制台设置 **输出目录** 后，每次生成完成会自动保存到该目录；留空则仅在内存中保留，可用结果卡片上的下载按钮手动另存。

---

## 配置与端口

- **设置文件**：`settings.json`，保存在系统配置目录下的 `lumina/` 文件夹：
  - Windows：`%APPDATA%\lumina\settings.json`
  - Linux：`~/.config/lumina/settings.json`
  - macOS：`~/Library/Application Support/lumina/settings.json`
  - 持久化字段：`exeDir`、`modelDir`、`outputDir`、`backend`、`refImagePreset` 等启动配置。
  - 旧版本使用 `sdcpp-gui/` 目录；首次运行新版本时会自动读取并迁移到 `lumina/`（旧文件保留）。
- **生成参数**：按模式分别缓存在浏览器 `localStorage`（键 `sdcpp:params:img_gen` / `sdcpp:params:vid_gen`），随机种子开关存于 `sdcpp:seedRandom`。
- **sd-server 端口**：固定为 **1234**（`--listen-port 1234 --listen-ip 127.0.0.1`），与 webui 默认一致。Lumina 会探测该端口以接管外部已启动的 sd-server。
- **Vite 开发端口**：1420。
- **Windows 行为**：启动 sd-server 时使用 `CREATE_NO_WINDOW` 抑制弹出的控制台黑框，日志通过管道接入 GUI 内的日志面板。
- **退出清理**：关闭 Lumina 时会强制结束它启动的 sd-server 子进程，以释放显存、避免后台残留。

---

## 架构说明

```
React 前端  ──(Tauri invoke)──▶  Rust 后端  ──(HTTP /sdcpp/v1)──▶  sd-server
   │                                  │
   └──────  server-log 事件  ◀────────┘  (stdout/stderr 流式捕获)
```

- 前端不直接发起 HTTP 请求，而是调用一组**类型化的 Tauri 命令**（见 `src/api.ts`），由 Rust 后端代理到 `sd-server` 的 `/sdcpp/v1` API。
- 后端暴露的命令：`start_server`、`stop_server`、`server_status`、`scan_models`、`load_settings`、`save_settings`、`pick_folder`、`pick_file`、`save_output`、`save_as`、`sdcpp_capabilities`、`sdcpp_submit`、`sdcpp_job`、`sdcpp_cancel`。
- sd-server 的日志由后端逐行/逐进度段捕获、剥离 ANSI 转义后，通过 `server-log` 事件推送给前端日志面板。
- 模型家族检测统一由 Rust `family.rs` 实现；前端 `config/families.ts` 只维护界面字段与推荐参数。

---

## 支持的模型家族

控制台会针对以下家族给出专属的组件清单与推荐参数（步数 / CFG / flow_shift 等）：

Flux.1、Kontext、Flux.2-dev、Flux.2-klein（含 Base）、SDXL、SD 1.x/2.x、SD3/3.5、Wan T2V/I2V/TI2V、LingBot Video、Z-Image（含 Turbo）、Qwen-Image（含 Edit/Layered）、Chroma（含 Radiance）、LTX-Video、Ideogram4、HiDream-O1、ERNIE-Image、Anima、Krea2（含 Turbo/Ostris Edit）、Lens、Boogu Image（Base/Edit/Turbo）、LongCat、Ovis-Image、Distilled SD（SSD-1B/SDXS）、以及"自定义"（手动配置全部组件）。

---

## 已知限制

- sd-server 端口固定为 1234，暂不可在界面中修改；若该端口被其他程序占用需先释放。
- 生成结果仅保留在内存中（刷新或重启后丢失）；如需归档请配置输出目录或手动下载。
- 界面文案目前仅有简体中文。
- LoRA 提示词标签（`<lora:...>`）不被支持——这是 sd-server 服务端 API 的限制（仅 CLI 支持），并非 GUI 缺失。

---

## 常见问题与排障

### `npm install` 提示 Node engine 不兼容

运行 `node --version`，确认版本不低于 20.19。使用 nvm 时可在 `gui/` 目录执行 `nvm use`；仓库的 `.nvmrc` 会选择已验证版本。

### 端口 1234 被占用

Lumina 固定使用 `127.0.0.1:1234`。如果该端口上是兼容的外部 `sd-server`，Lumina 会尝试接管；如果是其他程序，启动预检会拒绝覆盖。请先停止占用进程，或在任务管理器/系统网络工具中确认对应 PID。

### 扫描不到模型

- 确认路径存在且当前用户有读取权限。
- 支持的模型文件包括 `.safetensors`、`*.safetensors.index.json`、`.gguf`、`.ckpt`、`.pt` 和 `.pth`。
- 查看扫描警告；目录过深、权限错误或损坏的目录项会被明确列出。
- Diffusers 模型应选择包含模型配置文件的上层目录。
- 文件名过于通用时可能被归入“自定义”，可以手动覆盖模型家族。

### 启动失败或一直停在加载中

- 展开底部“服务器日志”，先看最后一条错误。
- 检查所有必需组件是否已经选择、路径是否仍存在。
- 在终端中用相同 `sd-server` 执行 `--help`，排除运行库缺失。
- CUDA/Vulkan 不可用时先改为“仅 CPU”验证模型配置。
- 大模型加载可能需要数分钟；Lumina 会持续显示加载阶段，只有 capabilities 就绪后才进入生成页。
- 模型快切失败时 Lumina 会尝试恢复上一个模型；如果恢复也失败，请根据日志重新启动。

### 显存不足或系统卡顿

- 打开“CPU 卸载”。
- 降低生成尺寸、批量数量和视频帧数。
- 使用量化模型或加载时量化。
- 参考[性能指南](../docs/performance.md)和[后端选择指南](../docs/backend.md)配置组件级 backend。

### 自动保存失败

结果卡片会显示“保存失败”或“部分保存”，并提供重试。检查输出目录是否存在、是否可写以及磁盘空间是否充足。在确认“已保存”之前，不要清除该结果或直接退出应用；也可以使用“另存为”保存到其他位置。

### 设置突然恢复默认值

设置文件损坏时，Lumina 会保留损坏文件的备份并在控制台显示路径，而不是静默覆盖。确认备份内容后，可以手工恢复有效字段或重新配置。
