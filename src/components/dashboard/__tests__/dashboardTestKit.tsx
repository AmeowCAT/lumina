import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { useStore } from "../../../store";
import type { Capabilities, ScanResult, Settings } from "../../../types";

// Dashboard 系列测试的共享脚手架。
//
// 这里**只放非 mock 声明**：`vi.mock(...)` 必须留在各测试文件顶层——提升语义
// 依赖它自己的位置。测试文件把 `mocks` 交给 `vi.mock` 的工厂引用即可：Vite 的
// SSR 转换按 import 顺序依次求值，只要测试文件把本模块的 import 放在
// `../Dashboard` 之前，工厂被调用时 `mocks` 就已就绪（三个测试文件各自持有一份，
// 互不串味）。注意不能用 `vi.hoisted` 导出——Vitest 会直接报
// "Cannot export hoisted variable"。
export const mocks = {
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  scanModels: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  switchModel: vi.fn(),
  // 附加启动参数的 datalist 靠它取内核选项名（审查 40-cli §2.5）。
  inspectServer: vi.fn(),
};

export const settings: Settings = {
  exeDir: "",
  modelDir: "/models",
  outputDir: "",
  backend: "",
  refImagePreset: "",
  vaeFormat: "",
  extraArgs: "",
  offloadCpu: false,
  quantType: "",
  maxQueueSize: 4,
  sdPort: 1234,
  modelSnapshots: {},
};

export function scanFor(family: string): ScanResult {
  return {
    baseDir: "/models",
    count: 1,
    families: { "/models/main.safetensors": family },
    files: [
      {
        name: "main.safetensors",
        stem: "main",
        path: "/models/main.safetensors",
        relPath: "main.safetensors",
        sizeMb: 1024,
        dir: "/models",
        ext: "safetensors",
        category: "model",
      },
    ],
    warnings: [],
    truncated: false,
    partial: false,
  };
}

// Radix Select 是组合控件而非表单元素：点击触发器展开，再点击目标选项。
//
// 共享一个 `userEvent` 实例（`delay: null` 去掉每个动作之间的等待）：这些用例
// 每个至少调一次本函数，之前每次 `setup()` 都重建一次指针/键盘状态机，单次约
// 150ms（审查 60-build §2.13）。
const user = userEvent.setup({ delay: null });

export async function pickOption(label: string, optionName: string | RegExp): Promise<void> {
  await user.click(await screen.findByLabelText(label));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

/**
 * 各测试文件 `beforeEach` 的公共部分：清空 mock 调用记录并重置 store。
 * 单个用例需要不同的返回值时，在用例内部覆盖（与拆分前一致）。
 */
export function resetDashboard(): void {
  vi.clearAllMocks();
  mocks.loadSettings.mockResolvedValue(settings);
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.inspectServer.mockResolvedValue({
    options: ["--threads", "--mmap"],
  } as unknown as Capabilities);
  useStore.setState({
    settings,
    scanResult: null,
    mainModel: "",
    familyOverride: "",
    components: {},
    serverStatus: null,
    dashboardOpen: true,
  });
}
