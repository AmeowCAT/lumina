import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOutputFiles: vi.fn(),
  readFileB64: vi.fn(),
  readThumbnail: vi.fn(),
  deleteOutputFile: vi.fn(),
  toast: vi.fn(),
}));

// 可变的假 store：竞态测试需要切换 outputDir 触发重新加载。
vi.mock("../../../store", () => {
  const state = {
    settings: { outputDir: "C:/output" },
    toast: mocks.toast,
  };
  const useStore = (selector: (state: unknown) => unknown) => selector(state);
  (useStore as unknown as { __state: typeof state }).__state = state;
  return { useStore };
});

vi.mock("../../../api", () => ({
  api: {
    listOutputFiles: mocks.listOutputFiles,
    readFileB64: mocks.readFileB64,
    readThumbnail: mocks.readThumbnail,
    deleteOutputFile: mocks.deleteOutputFile,
  },
}));

import { useStore } from "../../../store";
import { HistoryGallery } from "../HistoryGallery";

const mockState = (
  useStore as unknown as { __state: { settings: { outputDir: string } } }
).__state;

describe("HistoryGallery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.settings.outputDir = "C:/output";
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
    mocks.readThumbnail.mockResolvedValue({ b64: "aW1hZ2U=", mime: "image/jpeg" });
    mocks.deleteOutputFile.mockResolvedValue(undefined);
  });

  it("opens a zoomable preview in the shared Lightbox and restores embedded parameters", async () => {
    const onRestoreParams = vi.fn();
    render(<HistoryGallery onRestoreParams={onRestoreParams} />);

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
    fireEvent.click(screen.getByRole("button", { name: "删除此文件" }));
    expect(mocks.deleteOutputFile).not.toHaveBeenCalled();

    // 第二击确认:调用后端删除、关闭预览、从列表移除
    fireEvent.click(screen.getByRole("button", { name: "确认删除该文件" }));
    await waitFor(() =>
      expect(mocks.deleteOutputFile).toHaveBeenCalledWith("C:/output/result.png")
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "result.png" })).toBeNull()
    );
    expect(screen.getByText("暂无历史记录")).toBeTruthy();
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

  it("shows saved videos as tiles and plays them in the Lightbox", async () => {
    mocks.listOutputFiles.mockResolvedValue([
      {
        path: "C:/output/clip.webm",
        name: "clip.webm",
        size: 1024,
        modified: 1_700_000_000,
        ext: "webm",
      },
    ]);
    mocks.readFileB64.mockResolvedValue("AAAA");
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-video");
    URL.revokeObjectURL = vi.fn();

    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "查看历史视频 clip.webm" })
    );

    const dialog = screen.getByRole("dialog", { name: "clip.webm" });
    expect(dialog.querySelector("video")).toBeTruthy();
    // 视频条目不用图片动作（无法作为初始图片/恢复参数）
    expect(
      screen.queryByRole("button", { name: "用作初始图片" })
    ).toBeNull();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  it("ignores a stale response when the output directory changes quickly", async () => {
    const deferred = () => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const slowOld = deferred();
    const fastNew = deferred();
    mocks.listOutputFiles.mockImplementation((dir: string) =>
      dir === "C:/output" ? slowOld.promise : fastNew.promise
    );

    const { rerender } = render(<HistoryGallery onRestoreParams={vi.fn()} />);

    // 已切到新目录（重渲染触发 load），新目录响应先返回。
    mockState.settings.outputDir = "C:/output2";
    rerender(<HistoryGallery onRestoreParams={vi.fn()} />);
    fastNew.resolve([
      {
        path: "C:/output2/new.png",
        name: "new.png",
        size: 10,
        modified: 1_700_000_000,
        ext: "png",
      },
    ]);
    await screen.findByRole("button", { name: "查看历史图片 new.png" });

    // 慢的旧目录响应后到：必须被丢弃，不能覆盖新列表。
    slowOld.resolve([
      {
        path: "C:/output/old.png",
        name: "old.png",
        size: 10,
        modified: 1_700_000_000,
        ext: "png",
      },
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "查看历史图片 old.png" })
      ).toBeNull()
    );
    expect(
      screen.getByRole("button", { name: "查看历史图片 new.png" })
    ).toBeTruthy();
  });
});
