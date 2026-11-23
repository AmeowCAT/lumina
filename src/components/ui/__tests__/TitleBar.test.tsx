import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../../lib/theme";
import { TitleBar } from "../TitleBar";

const winMocks = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMocks,
}));

describe("TitleBar 自绘标题栏", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    winMocks.isMaximized.mockResolvedValue(false);
    localStorage.clear();
    initTheme();
  });

  it("渲染品牌区、拖拽区、主题速切钮与三个窗口控制钮", () => {
    render(<TitleBar />);
    expect(screen.getByText("流光 LUMINA")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-tauri-drag-region]")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "切换至东方号 VOSTOK" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最小化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("点击主题速切钮在墨曜与东方号主题间往返切换", async () => {
    render(<TitleBar />);
    const toVostok = screen.getByRole("button", { name: "切换至东方号 VOSTOK" });
    await userEvent.click(toVostok);
    expect(document.documentElement.dataset.theme).toBe("vostok");

    const toLumina = screen.getByRole("button", { name: "切换至墨曜 · 暗室" });
    await userEvent.click(toLumina);
    expect(document.documentElement.dataset.theme).toBe("lumina");
  });

  it("点击按钮调用对应窗口 API", async () => {
    render(<TitleBar />);
    await userEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(winMocks.minimize).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(winMocks.toggleMaximize).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(winMocks.close).toHaveBeenCalledTimes(1);
  });

  it("最大化后按钮切换为还原", async () => {
    winMocks.isMaximized.mockResolvedValue(true);
    render(<TitleBar />);
    expect(await screen.findByRole("button", { name: "还原" })).toBeInTheDocument();
  });
});
