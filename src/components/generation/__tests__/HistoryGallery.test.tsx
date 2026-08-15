import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOutputFiles: vi.fn(),
  readFileB64: vi.fn(),
  deleteOutputFile: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../../api", () => ({
  api: {
    listOutputFiles: mocks.listOutputFiles,
    readFileB64: mocks.readFileB64,
    deleteOutputFile: mocks.deleteOutputFile,
  },
}));

vi.mock("../../../store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { outputDir: "C:/output" },
      toast: mocks.toast,
    }),
}));

import { HistoryGallery } from "../HistoryGallery";

describe("HistoryGallery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOutputFiles.mockResolvedValue([
      {
        path: "C:/output/result.png",
        name: "result.png",
        size: 100,
        modified: 1_700_000_000,
        ext: "png",
        metadata: { prompt: "mountains", seed: 42 },
      },
    ]);
    mocks.readFileB64.mockResolvedValue("aW1hZ2U=");
    mocks.deleteOutputFile.mockResolvedValue(undefined);
  });

  it("opens a zoomable preview in the shared Lightbox and restores embedded parameters", async () => {
    const onRestoreParams = vi.fn();
    render(
      <HistoryGallery
        onRestoreParams={onRestoreParams}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      })
    );

    // 统一 Lightbox:aria-label 即文件名,自带滚轮缩放与导航
    expect(screen.getByRole("dialog", { name: "result.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复此配置" }));

    await waitFor(() =>
      expect(onRestoreParams).toHaveBeenCalledWith(
        { prompt: "mountains", seed: 42 },
        "data:image/png;base64,aW1hZ2U="
      )
    );
  });

  it("portals the shared Lightbox to document.body so it stacks above the prompt dock", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      })
    );

    const dialog = screen.getByRole("dialog", { name: "result.png" });
    expect(dialog.parentElement).toBe(document.body);
  });

  it("deletes a history image after two-tap confirmation", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      })
    );

    // 第一击只武装,不执行删除
    fireEvent.click(screen.getByRole("button", { name: "删除此图片" }));
    expect(mocks.deleteOutputFile).not.toHaveBeenCalled();

    // 第二击确认:调用后端删除、关闭预览、从列表移除
    fireEvent.click(screen.getByRole("button", { name: "确认删除该文件" }));
    await waitFor(() =>
      expect(mocks.deleteOutputFile).toHaveBeenCalledWith("C:/output/result.png")
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "result.png" })).toBeNull()
    );
    expect(screen.getByText("暂无历史图片")).toBeTruthy();
  });

  it("searches embedded prompts and can use a history item as the initial image", async () => {
    const onUseAsInit = vi.fn();
    render(
      <HistoryGallery
        onRestoreParams={vi.fn()}
        onUseAsInit={onUseAsInit}
      />
    );

    const search = await screen.findByLabelText("搜索历史");
    fireEvent.change(search, { target: { value: "mountains" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "用作初始图片" }));

    await waitFor(() =>
      expect(onUseAsInit).toHaveBeenCalledWith(
        "data:image/png;base64,aW1hZ2U="
      )
    );
  });
});
