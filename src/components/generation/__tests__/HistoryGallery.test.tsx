import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockState = (useStore as unknown as { __state: { settings: { outputDir: string } } }).__state;

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
      }),
    );

    // 统一 Lightbox:aria-label 即文件名,自带滚轮缩放与导航
    expect(screen.getByRole("dialog", { name: "result.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复此配置" }));

    await waitFor(() =>
      expect(onRestoreParams).toHaveBeenCalledWith(
        { prompt: "mountains", seed: 42 },
        "data:image/png;base64,aW1hZ2U=",
      ),
    );
  });

  it("portals the shared Lightbox to document.body so it stacks above the prompt dock", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      }),
    );

    const dialog = screen.getByRole("dialog", { name: "result.png" });
    expect(dialog.parentElement).toBe(document.body);
  });

  it("deletes a history image after two-tap confirmation", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      }),
    );

    // 第一击只武装,不执行删除
    fireEvent.click(screen.getByRole("button", { name: "删除此文件" }));
    expect(mocks.deleteOutputFile).not.toHaveBeenCalled();

    // 第二击确认:调用后端删除、关闭预览、从列表移除
    fireEvent.click(screen.getByRole("button", { name: "确认删除该文件" }));
    await waitFor(() =>
      expect(mocks.deleteOutputFile).toHaveBeenCalledWith("C:/output/result.png"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "result.png" })).toBeNull());
    expect(screen.getByText("暂无历史记录")).toBeTruthy();
  });

  it("searches embedded prompts and can use a history item as the initial image", async () => {
    const onUseAsInit = vi.fn();
    render(<HistoryGallery onRestoreParams={vi.fn()} onUseAsInit={onUseAsInit} />);

    const search = await screen.findByLabelText("搜索历史");
    fireEvent.change(search, { target: { value: "mountains" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看历史图片 result.png（含生成参数）",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "用作初始图片" }));

    await waitFor(() => expect(onUseAsInit).toHaveBeenCalledWith("data:image/png;base64,aW1hZ2U="));
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

    fireEvent.click(await screen.findByRole("button", { name: "查看历史视频 clip.webm" }));

    const dialog = screen.getByRole("dialog", { name: "clip.webm" });
    expect(dialog.querySelector("video")).toBeTruthy();
    // 视频条目不用图片动作（无法作为初始图片/恢复参数）
    expect(screen.queryByRole("button", { name: "用作初始图片" })).toBeNull();
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
      dir === "C:/output" ? slowOld.promise : fastNew.promise,
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
      expect(screen.queryByRole("button", { name: "查看历史图片 old.png" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "查看历史图片 new.png" })).toBeTruthy();
  });
});

/**
 * blob 缓存的生命周期（审查 §2.1 / §2.5）：Blob URL 注册在 document 上，
 * 不显式 revoke 就永远不会释放；组件卸载时必须逐条 revoke。
 */
describe("HistoryGallery 缓存释放与容器判定", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.settings.outputDir = "C:/output";
    mocks.readFileB64.mockResolvedValue("AAAA");
    mocks.readThumbnail.mockResolvedValue({ b64: "aW1hZ2U=", mime: "image/jpeg" });
    createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-video");
    revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  const webmFile = {
    path: "C:/output/clip.webm",
    name: "clip.webm",
    size: 1024,
    modified: 1_700_000_000,
    ext: "webm",
  };

  it("卸载时 revoke 已缓存的视频 blob URL", async () => {
    mocks.listOutputFiles.mockResolvedValue([webmFile]);
    const { unmount } = render(<HistoryGallery onRestoreParams={vi.fn()} />);

    // 瓦片挂载即触发视频读取 → 建出 blob URL
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(revokeSpy).not.toHaveBeenCalled();

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-video");
  });

  it("卸载之后才回包的视频读取不再创建新 blob URL（否则无人释放）", async () => {
    mocks.listOutputFiles.mockResolvedValue([webmFile]);
    let resolveRead!: (value: string) => void;
    mocks.readFileB64.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const { unmount } = render(<HistoryGallery onRestoreParams={vi.fn()} />);
    await waitFor(() => expect(mocks.readFileB64).toHaveBeenCalled());

    unmount();
    resolveRead("AAAA");
    // 冲净微任务队列，让 .then 有机会执行
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("历史 AVI 在共用 Lightbox 里给下载提示，而不是黑屏 <video>", async () => {
    mocks.listOutputFiles.mockResolvedValue([
      {
        path: "C:/output/clip.avi",
        name: "clip.avi",
        size: 1024,
        modified: 1_700_000_000,
        ext: "avi",
      },
    ]);
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "查看历史视频 clip.avi" }));

    const dialog = screen.getByRole("dialog", { name: "clip.avi" });
    expect(screen.getByRole("note").textContent).toContain("AVI");
    expect(dialog.querySelector("video")).toBeNull();
  });
});

// 审查 50-ux F-08：超过 200 项后只渲染可见瓦片，屏外条目不在 Tab 序里。
// 容器必须可聚焦并能翻页，同时播报当前窗口范围，否则键盘/读屏用户到不了后面的图。
describe("HistoryGallery 虚拟滚动的键盘兜底", () => {
  const files = Array.from({ length: 300 }, (_, i) => ({
    path: `C:/output/pic${i}.png`,
    name: `pic${i}.png`,
    size: 10,
    modified: 1_700_000_000 + i,
    ext: "png",
    metadata: {},
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOutputFiles.mockResolvedValue(files);
    mocks.readThumbnail.mockResolvedValue({ b64: "aW1hZ2U=", mime: "image/jpeg" });
    // 让 ResizeObserver 立刻回调并把宽度给足，从而触发虚拟化分支。
    window.ResizeObserver = class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
  });

  it("exposes a focusable grid and announces the visible range", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    const grid = await screen.findByRole("group", { name: /共 300 项/ });
    expect(grid.getAttribute("tabindex")).toBe("0");
    expect(grid.getAttribute("aria-rowcount")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("当前显示第");
  });

  it("handles PageDown without error so keyboard users can page the list", async () => {
    render(<HistoryGallery onRestoreParams={vi.fn()} />);

    const grid = await screen.findByRole("group", { name: /共 300 项/ });
    fireEvent.keyDown(grid, { key: "PageDown" });
    fireEvent.keyDown(grid, { key: "End" });
    fireEvent.keyDown(grid, { key: "Home" });
    // 关键是"没有抛异常"且网格仍在：真正的滚动由真实滚动容器承担（jsdom 无布局）。
    expect(screen.getByRole("group", { name: /共 300 项/ })).toBe(grid);
  });
});
