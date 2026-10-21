// 注意：本 import 必须排在 `../Dashboard` 之前——`vi.mock` 的工厂要读 kit 里的
// `mocks`，而 Vite SSR 按 import 源码顺序求值，kit 必须先完成初始化。
import {
  mocks,
  pickOption,
  resetDashboard,
  scanFor,
} from "./dashboardTestKit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../../store";
import type { Capabilities } from "../../../types";
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

describe("Dashboard onboarding validation", () => {
  beforeEach(resetDashboard);

  it("blocks startup and lists missing required split-model components", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("flux"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    expect(await screen.findByRole("alert")).toHaveTextContent("还缺");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
  });

  // 审查 50-ux F-14：只滚到面板不够——目标面板常是折叠态。点「去填写」必须
  // 把面板展开并把焦点送到第一个可填控件，否则用户仍然"知道缺什么但不知点哪"。
  it("opens the components panel and focuses a field from the missing-config notice", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("flux"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "去填写" }));

    // 面板标题的可访问状态翻转即"已展开"；焦点随后落到面板里的控件上。
    const heads = screen.getAllByRole("button", { expanded: true });
    expect(heads.length).toBeGreaterThan(0);
  });

  it("allows PATH-based startup for a self-contained model", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /启动服务器/ })).not.toBeDisabled()
    );
  });

  it("half-supports MiniMax-H3 Ref2VA without an unsupported banner", async () => {
    mocks.scanModels.mockResolvedValue(scanFor("minimax-h3-ref2va"));
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");

    // 半支持：不再显示"暂不支持"横幅，家族下拉也没有"（暂不支持）"后缀。
    expect(screen.queryByText(/暂不支持/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("识别类型")).not.toHaveTextContent("暂不支持");
    // 检查单退回常规组件缺口把关（Ref2VA 需要视频 VAE + LLM，此处只给了主模型）。
    expect(await screen.findByRole("alert")).toHaveTextContent("还缺");
    expect(screen.getByRole("button", { name: /启动服务器/ })).toBeDisabled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it("confirms a model switch inline when results are unsaved", async () => {
    mocks.switchModel.mockResolvedValue(true);
    mocks.scanModels.mockResolvedValue(scanFor("hidream"));
    useStore.setState({
      serverStatus: {
        running: true,
        reachable: true,
        external: false,
        pid: 42,
        model: "/models/old.safetensors",
        sdPort: 7860,
        phase: "ready",
      },
      caps: {
        model: {
          name: "old.safetensors",
          stem: "old",
          path: "/models/old.safetensors",
        },
      } as Capabilities,
      results: [
        {
          jobId: "j1",
          mode: "img_gen",
          result: {
            output_format: "png",
            images: [{ index: 0, b64_json: "eA==" }],
          },
          saves: { "0": { status: "failed", error: "disk full" } },
        },
      ],
      jobs: [],
    });
    render(<Dashboard />);

    await pickOption("主模型", "main.safetensors (1.0 GB)");
    fireEvent.click(
      await screen.findByRole("button", { name: /切换到此模型/ }),
    );

    // 不直接切换,先在启动坞弹出影响确认条
    expect(mocks.switchModel).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尚未安全保存",
    );

    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    await waitFor(() =>
      expect(mocks.switchModel).toHaveBeenCalledWith(
        "/models/main.safetensors",
      ),
    );
  });
});
