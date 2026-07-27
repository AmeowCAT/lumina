<div align="center">
  <img src="src-tauri/icons/icon.png" width="96" alt="流光 Lumina" />
  <h1>流光 Lumina</h1>
  <p><strong>stable-diffusion.cpp 的桌面工作台</strong>——暗房金色的本地生成工作室</p>
  <p>
    <img src="https://img.shields.io/badge/版本-0.7.3-d9a441" alt="版本" />
    <img src="https://img.shields.io/badge/Tauri-2-b56a35" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/平台-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-14110d" alt="平台" />
    <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-14110d" alt="MIT" /></a>
  </p>
</div>

---

管理 `sd-server` 的生命周期，并提供完整的图片 / 视频生成界面——取代仓库原有 webui 的独立本地桌面应用（不在标准 CMake 构建流程内）。**控制台**负责配置、扫描与启动；服务器就绪后进入**画布优先的生成工作室**。界面文案为简体中文。

## 亮点

- **GO/NO-GO 启动检查单**：路径 / 主模型 / 组件三项就绪实时可见，齐备后启动按钮点亮；切换模型就地列出受影响任务与结果供确认
- **画布优先工作室**：提示栏参数 chip（尺寸 / 步数 / CFG）点击即在原位弹出滑杆；`Ctrl + ,` 召唤完整参数面板
- **30+ 模型家族自动识别**：ComfyUI 目录结构、分片索引隐藏、组件清单与推荐参数，识别结果可手动覆盖
- **结果即显影**：辉光结果网格、两段式删除确认、输出目录自动落盘与失败重试
- **零原生弹窗**：所有确认就地完成；探测并接管同端口的外部 `sd-server`
- **服务器日志面板**：stdout/stderr 实时显示（含进度行原地刷新）

## 快速开始

前置：**Node.js 20.19+** · **Rust stable** · 已编译的 `sd-server`（见[主仓库构建说明](../docs/build.md)）

```bash
cd gui
npm install
npm run tauri dev      # 开发模式（热更新）
npm run tauri build    # 打包安装包
```

1. 控制台选择 `sd-server`（已在 PATH 可留空）与模型根目录，自动扫描归类；
2. 选择主模型，家族与所需组件自动匹配；
3. 检查单全亮后点击**启动服务器**，就绪自动进入生成界面。

仅调试前端：`npm run dev`（端口 1420）· `npm run build` · `npm test`

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl` + `Enter` | 提交生成 |
| `Ctrl` + `,` | 召唤 / 关闭参数面板 |
| `Ctrl` + `R` | 切换随机种子 |
| `Esc` | 关闭浮层（放大预览 / 参数面板 / 任务队列） |

## 技术栈

Tauri 2 · React 18 · TypeScript · Zustand 5 · Vite 8 · Tailwind CSS 4 · Radix UI · motion · lucide-react · Vitest · Rust（Tokio / reqwest / rfd）

```
React 前端  ──(Tauri invoke)──▶  Rust 后端  ──(HTTP /sdcpp/v1)──▶  sd-server
   │                                  │
   └──────  server-log 事件  ◀────────┘  (stdout/stderr 流式捕获)
```

前端不直接发起 HTTP，一切经类型化 Tauri 命令由 Rust 代理；家族检测统一在 Rust 侧完成。

<details>
<summary><strong>支持的模型家族（30+）</strong></summary>

Flux.1、Kontext、Flux.2-dev、Flux.2-klein（含 Base）、SDXL、SD 1.x/2.x（含 AnimateDiff img2video）、SD3/3.5、PiD / PiD 1.5、Wan T2V/I2V/TI2V、LingBot Video、HunyuanVideo 1.5、Z-Image（含 Turbo）、Qwen-Image（含 Edit/Layered）、Chroma（含 Radiance）、LTX-Video、Ideogram4、HiDream-O1、ERNIE-Image、Anima、Krea2（含 Turbo/Ostris Edit）、Lens、Boogu Image（Base/Edit/Turbo）、LongCat、Ovis-Image、Distilled SD（SSD-1B/SDXS），以及"自定义"（手动配置全部组件）。

</details>

## 目录结构

```
gui/
├── src/
│   ├── App.tsx · store.ts · api.ts · types.ts
│   ├── config/families.ts        # 家族元数据、尺寸预设、采样器/调度器显示名
│   ├── lib/                      # 请求体构造、启动配置校验
│   ├── components/
│   │   ├── dashboard/            # 控制台：启动检查单 + 配置流
│   │   ├── generation/           # 工作室：提示栏、参数面板、结果网格、任务队列
│   │   └── ui/                   # Radix 封装与基础组件
│   └── test/setup.ts             # Vitest jsdom 环境
└── src-tauri/                    # Rust：进程管理、目录扫描、家族检测、HTTP 代理、落盘
```

## 配置与端口

- **设置文件**：`lumina/settings.json` 存于系统配置目录（Windows `%APPDATA%`，Linux `~/.config`，macOS `~/Library/Application Support`）；旧版 `sdcpp-gui/` 目录自动迁移，模型级启动配置按快照随模型恢复
- **生成参数**：按模式缓存在 `localStorage`（`sdcpp:params:*`）
- **端口**：`sd-server` 固定 `127.0.0.1:1234`（与 webui 一致）；Vite 开发端口 `1420`

## 排障

- **Node engine 不兼容**：需 20.19+，仓库含 `.nvmrc`（`nvm use`）
- **端口 1234 被占用**：非兼容 `sd-server` 占用时需先释放，Lumina 不会覆盖未知进程
- **扫描不到模型**：支持 `.safetensors` / `.sft` / `.gguf` / `.ckpt` / `.pt` / `.pth`，注意面板中的扫描警告
- **显存不足**：打开 CPU 卸载、降低尺寸与帧数、使用量化——参考[性能指南](../docs/performance.md)与[后端选择指南](../docs/backend.md)

## 已知限制

- 端口固定 1234；生成结果仅保留在内存中（配置输出目录后自动落盘）
- LoRA 提示词标签（`<lora:...>`）不受支持——服务端 API 限制，非 GUI 缺失
- PiD 的 `--vae-format` 无法从权重可靠推断，需按模型卡手动匹配
- AnimateDiff 运动模块上限 32 帧，超出由服务端截断

---

<div align="center">
  <sub>以 MIT License 发布（见主仓库 <a href="../LICENSE">LICENSE</a>）· 问题与建议请提交至主仓库 Issues</sub>
</div>
