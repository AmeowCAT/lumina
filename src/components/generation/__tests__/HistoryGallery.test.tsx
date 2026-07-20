import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOutputFiles: vi.fn(),
  readFileB64: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("../../../api", () => ({
  api: {
    listOutputFiles: mocks.listOutputFiles,
    readFileB64: mocks.readFileB64,
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
  });

  it("opens an actionable preview and restores embedded parameters", async () => {
    const onRestoreParams = vi.fn();
    render(
      <HistoryGallery
        onRestoreParams={onRestoreParams}
        onLightbox={vi.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      })
    );

    expect(screen.getByRole("dialog", { name: "历史图片：result.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复此配置" }));

    await waitFor(() =>
      expect(onRestoreParams).toHaveBeenCalledWith(
        { prompt: "mountains", seed: 42 },
        "data:image/png;base64,aW1hZ2U="
      )
    );
  });

  it("searches embedded prompts and can use a history item as the initial image", async () => {
    const onUseAsInit = vi.fn();
    render(
      <HistoryGallery
        onRestoreParams={vi.fn()}
        onLightbox={vi.fn()}
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
