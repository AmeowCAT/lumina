// 注意：本 import 必须排在 `../Dashboard` 之前——`vi.mock` 的工厂要读 kit 里的
// `mocks`，而 Vite SSR 按 import 源码顺序求值，kit 必须先完成初始化。
import { mocks, pickOption, resetDashboard, scanFor, settings } from "./dashboardTestKit";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";
import type { ScanResult } from "../../../types";
import { Dashboard } from "../Dashboard";

// 提升到文件顶层的 vi.mock 不能进共享 kit，否则 mock 不生效。
vi.mock("../../../api", () => ({ api: mocks }));
vi.mock("../../../hooks/useModelSwitch", () => ({
  useModelSwitch: () => ({
    switchModel: mocks.switchModel,
    switching: false,
    phase: "",
  }),
}));

describe("Dashboard model snapshots", () => {
  beforeEach(resetDashboard);

  it("restores the latest snapshot when a configured model is selected", async () => {
    const configured = {
      ...settings,
      modelSnapshots: {
        "/models/main.safetensors": {
          familyOverride: "hidream",
          components: {},
          backend: "cuda0",
          refImagePreset: "krea2_edit",
          extraArgs: "--threads 8",
          offloadCpu: true,
          quantType: "q8_0",
          maxQueueSize: 7,
        },
      },
    };
    mocks.loadSettings.mockResolvedValue(configured);
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    await waitFor(() => expect(screen.getByLabelText("自定义 --backend")).toHaveValue("cuda0"));
    expect(screen.getByLabelText("CPU 卸载（--offload-to-cpu）")).toBeChecked();
    expect(screen.getByLabelText("加载时量化（--type）")).toHaveTextContent("Q8_0");
    expect(screen.getByLabelText("处理预设")).toHaveTextContent("Krea2 Edit 768");
    expect(screen.getByLabelText("附加启动参数")).toHaveValue("--threads 8");
    expect(screen.getByLabelText("最大队列数量")).toHaveValue(7);
  });

  it("persists diagnostic edits before launch and clears absent fields in a legacy snapshot", async () => {
    const base = scanFor("hidream").files[0];
    mocks.loadSettings.mockResolvedValue({
      ...settings,
      modelSnapshots: {
        "/models/b.safetensors": {
          familyOverride: "hidream",
          components: {},
          backend: "",
          refImagePreset: "",
          extraArgs: "",
          offloadCpu: false,
          quantType: "",
          maxQueueSize: 4,
        },
      },
    });
    mocks.scanModels.mockResolvedValue({
      ...scanFor("hidream"),
      count: 2,
      families: { "/models/a.safetensors": "hidream", "/models/b.safetensors": "hidream" },
      files: [
        { ...base, name: "a.safetensors", path: "/models/a.safetensors" },
        { ...base, name: "b.safetensors", path: "/models/b.safetensors" },
      ],
    });
    render(<Dashboard />);
    await pickOption("主模型", "a.safetensors (1.0 GB)");
    fireEvent.click(screen.getByRole("button", { name: /诊断与数值稳定性/ }));
    fireEvent.change(screen.getByLabelText("Linear 输入缩放（--linear-scale）"), {
      target: { value: "0.0078125" },
    });
    await pickOption("日志等级（--log-level）", "debug · 最详细");
    await waitFor(() =>
      expect(useStore.getState().settings.modelSnapshots["/models/a.safetensors"]).toMatchObject({
        linearScale: "0.0078125",
        logLevel: "debug",
      }),
    );
    expect(mocks.startServer).not.toHaveBeenCalled();
    await pickOption("主模型", "b.safetensors (1.0 GB)");
    expect(screen.getByLabelText("Linear 输入缩放（--linear-scale）")).toHaveValue("");
    expect(screen.getByLabelText("日志等级（--log-level）")).toHaveTextContent("内核默认");
    await pickOption("主模型", "a.safetensors (1.0 GB)");
    expect(screen.getByLabelText("Linear 输入缩放（--linear-scale）")).toHaveValue("0.0078125");
    expect(screen.getByLabelText("日志等级（--log-level）")).toHaveTextContent("debug");
  });

  it("records component config on change and restores it after switching away and back", async () => {
    // 回归：快照曾只在启动成功后保存，且切换路径的防抖保存会随 Dashboard
    // 卸载被丢弃——"选中后组件配置没有记录并沿用"的根因。这里验证：
    // 组件变更即记录快照；切到别的模型再切回时组件配置被恢复。
    const baseFile = scanFor("flux").files[0];
    const twoModels: ScanResult = {
      ...scanFor("flux"),
      count: 4,
      families: {
        "/models/a.safetensors": "flux",
        "/models/b.safetensors": "flux",
      },
      files: [
        { ...baseFile, name: "a.safetensors", stem: "a", path: "/models/a.safetensors" },
        { ...baseFile, name: "b.safetensors", stem: "b", path: "/models/b.safetensors" },
        { ...baseFile, name: "ae1.sft", stem: "ae1", path: "/models/ae1.sft", category: "vae" },
        { ...baseFile, name: "ae2.sft", stem: "ae2", path: "/models/ae2.sft", category: "vae" },
      ],
    };
    mocks.scanModels.mockResolvedValue(twoModels);
    render(<Dashboard />);

    await pickOption("主模型", "a.safetensors (1.0 GB)");
    // 两个 VAE 候选：自动补选不生效，组件初始为空。
    expect(useStore.getState().components).toEqual({});

    // 用户在组件面板选择 VAE → 快照立即记录当前模型配置。
    act(() => useStore.getState().setComponents(() => ({ vae: "/models/ae1.sft" })));
    await waitFor(() => {
      const snap = useStore.getState().settings.modelSnapshots["/models/a.safetensors"];
      expect(snap?.components).toEqual({ vae: "/models/ae1.sft" });
    });

    // 切到 b（无快照、组件清空）再切回 a：配置被恢复。
    await pickOption("主模型", "b.safetensors (1.0 GB)");
    expect(useStore.getState().components).toEqual({});
    await pickOption("主模型", "a.safetensors (1.0 GB)");
    await waitFor(() => expect(useStore.getState().components).toEqual({ vae: "/models/ae1.sft" }));
  });
});
