import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import type { ResultEntry } from "../../../store";
import type { GenParams, JobConfig } from "../../../types";
import { ResultsGrid } from "../ResultsGrid";

const config: JobConfig = {
  mode: "img_gen",
  params: {
    width: 512,
    height: 512,
    seed: 100,
    sample_params: { guidance: {} },
  },
};

function renderGrid(overrides: Record<string, unknown> = {}) {
  const onRemove = vi.fn();
  const onSaveImage = vi.fn();
  render(
    <ResultsGrid
      results={[
        {
          jobId: "job-1",
          mode: "img_gen",
          result: {
            output_format: "png",
            images: [{ index: 3, b64_json: "aW1hZ2U=" }],
          },
          config,
          saves: { "3": { status: "failed", error: "disk full" } },
        },
      ]}
      generating={false}
      onLightbox={vi.fn()}
      onApplyConfig={vi.fn()}
      onDownload={vi.fn()}
      onRemove={onRemove}
      onSaveImage={onSaveImage}
      onUseAsInit={vi.fn()}
      getVideoUrl={() => "blob:video"}
      getImageUrl={() => "blob:image"}
      {...overrides}
    />
  );
  return { onRemove, onSaveImage };
}

describe("ResultsGrid", () => {
  it("arms before removing an unsaved image, then removes on confirm", () => {
    const { onRemove } = renderGrid({ results: [unsavedEntry("job-1")] });
    fireEvent.click(screen.getByRole("button", { name: "删除此图片" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "确认删除（尚未保存）" })
    );
    expect(onRemove).toHaveBeenCalledWith("job-1", 3);
  });

  it("removes a safely saved image with a single click", () => {
    const { onRemove } = renderGrid({
      results: [
        {
          jobId: "job-1",
          mode: "img_gen",
          result: {
            output_format: "png",
            images: [{ index: 3, b64_json: "aW1hZ2U=" }],
          },
          config,
          saves: { "3": { status: "saved", path: "/out/a.png" } },
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "删除此图片" }));
    expect(onRemove).toHaveBeenCalledWith("job-1", 3);
  });

  it("announces save failures and exposes retry", () => {
    const { onSaveImage } = renderGrid();
    expect(screen.getByRole("alert").textContent).toBe("保存失败");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(onSaveImage).toHaveBeenCalledWith("job-1", "3");
  });

  it("save-to-dir button forwards the per-image key", () => {
    const { onSaveImage } = renderGrid({ results: [unsavedEntry("job-1")] });
    fireEvent.click(screen.getByRole("button", { name: "保存到输出目录" }));
    expect(onSaveImage).toHaveBeenCalledWith("job-1", "3");
  });
});

function unsavedEntry(jobId: string): ResultEntry {
  return {
    jobId,
    mode: "img_gen",
    result: {
      output_format: "png",
      images: [{ index: 3, b64_json: "aW1hZ2U=" }],
    },
    config,
  };
}

function params(seed = 42): GenParams {
  return {
    width: 512,
    height: 512,
    seed,
    sample_params: { guidance: { txt_cfg: 7 } },
  };
}

function imageEntry(jobId: string, images = 1, seed = 42): ResultEntry {
  return {
    jobId,
    mode: "img_gen",
    result: {
      output_format: "png",
      images: Array.from({ length: images }, (_, i) => ({
        index: i,
        b64_json: `img-${jobId}-${i}`,
      })),
    },
    created: 1000,
    completedAt: 4000,
    config: { mode: "img_gen", params: params(seed) } as JobConfig,
  };
}

function videoEntry(jobId: string): ResultEntry {
  return {
    jobId,
    mode: "vid_gen",
    result: {
      mime_type: "video/webm",
      output_format: "webm",
      fps: 24,
      frame_count: 33,
      b64_json: `vid-${jobId}`,
    },
    created: 1000,
    completedAt: 4000,
    config: { mode: "vid_gen", params: params() } as JobConfig,
  };
}

const baseProps = {
  generating: false,
  onLightbox: vi.fn(),
  onApplyConfig: vi.fn(),
  onDownload: vi.fn(),
  onRemove: vi.fn(),
  onSaveImage: vi.fn(),
  onUseAsInit: vi.fn(),
  getVideoUrl: (jobId: string, b64: string) => `blob:${jobId}/${b64}`,
  getImageUrl: (b64: string, fmt: string) => `data:image/${fmt};base64,${b64}`,
};

describe("ResultsGrid 聚焦区 + 瀑布流", () => {
  it("无结果时显示空态", () => {
    render(<ResultsGrid results={[]} {...baseProps} />);
    expect(screen.getByText("准备就绪")).toBeTruthy();
  });

  it("仅一条结果时只渲染聚焦区", () => {
    render(<ResultsGrid results={[imageEntry("a")]} {...baseProps} />);
    expect(screen.getByRole("button", { name: /查看本次生成/ })).toBeTruthy();
  });

  it("两条结果时第一条聚焦、第二条进瀑布流", () => {
    render(
      <ResultsGrid results={[imageEntry("new"), imageEntry("old")]} {...baseProps} />
    );
    expect(screen.getByRole("button", { name: /查看本次生成/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /查看生成结果，种子 42/ })).toBeTruthy();
  });

  it("批量多图的最新结果在聚焦区展示全部图片", () => {
    render(<ResultsGrid results={[imageEntry("b", 3)]} {...baseProps} />);
    expect(screen.getAllByRole("button", { name: /查看本次生成/ })).toHaveLength(3);
  });

  it("点击聚焦图打开 lightbox", () => {
    const onLightbox = vi.fn();
    render(
      <ResultsGrid results={[imageEntry("c")]} {...baseProps} onLightbox={onLightbox} />
    );
    fireEvent.click(screen.getByRole("button", { name: /查看本次生成/ }));
    expect(onLightbox).toHaveBeenCalledWith(
      [
        {
          type: "image",
          src: "data:image/png;base64,img-c-0",
          title: "种子 42 · 512×512",
        },
      ],
      0
    );
  });

  it("两段式删除聚焦图片透传 jobId 与索引", () => {
    const onRemove = vi.fn();
    render(
      <ResultsGrid results={[imageEntry("d", 2)]} {...baseProps} onRemove={onRemove} />
    );
    const del = screen.getAllByRole("button", { name: "删除此图片" })[1];
    fireEvent.click(del);
    fireEvent.click(del);
    expect(onRemove).toHaveBeenCalledWith("d", 1);
  });

  it("视频结果在聚焦区渲染 video", () => {
    render(<ResultsGrid results={[videoEntry("v")]} {...baseProps} />);
    expect(document.querySelector(".featured-item video")).toBeTruthy();
  });
});
