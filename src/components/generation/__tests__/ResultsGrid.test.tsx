import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobConfig } from "../../../types";
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
  const onRetrySave = vi.fn();
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
          saveStatus: "failed",
          saveError: "disk full",
        },
      ]}
      onLightbox={vi.fn()}
      onApplyConfig={vi.fn()}
      onDownload={vi.fn()}
      onRemove={onRemove}
      onRetrySave={onRetrySave}
      onUseAsInit={vi.fn()}
      getVideoUrl={() => "blob:video"}
      getImageUrl={() => "blob:image"}
      {...overrides}
    />
  );
  return { onRemove, onRetrySave };
}

describe("ResultsGrid", () => {
  it("removes only the selected image from a batch", () => {
    const { onRemove } = renderGrid();
    fireEvent.click(screen.getByRole("button", { name: "删除此图片" }));
    expect(onRemove).toHaveBeenCalledWith("job-1", 3);
  });

  it("announces save failures and exposes retry", () => {
    const { onRetrySave } = renderGrid();
    expect(screen.getByRole("alert").textContent).toBe("保存失败");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(onRetrySave).toHaveBeenCalledWith("job-1");
  });
});
