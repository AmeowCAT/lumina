import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UpscalerInfo } from "../../../types";
import { UpscaleDialog } from "../UpscaleDialog";

const UPSCALERS: UpscalerInfo[] = [{ name: "RealESRGAN_x4plus", model: true, image_upscale: true }];

function renderDialog(overrides: Partial<Parameters<typeof UpscaleDialog>[0]> = {}) {
  return render(
    <UpscaleDialog
      open
      onClose={vi.fn()}
      upscalers={UPSCALERS}
      outputFormats={["png", "jpeg"]}
      source={{ b64: "abc", fmt: "png" }}
      busy={false}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}

describe("UpscaleDialog", () => {
  it("submits the kernel defaults when nothing is changed", async () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });

    await userEvent.click(screen.getByRole("button", { name: "开始放大" }));

    // 空 upscaler / tileSize 0 都表示"用内核默认"，不能编造具体数值。
    expect(onSubmit).toHaveBeenCalledWith({
      upscaler: "",
      repeats: 1,
      tileSize: 0,
      outputFormat: "png",
    });
  });

  it("blocks submission and reports progress while the sync request runs", () => {
    renderDialog({ busy: true });

    expect(screen.getByRole("button", { name: "放大中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭放大对话框" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("不可取消");
  });

  // 审查 30-api §2.12：同步接口没有进度事件，至少要能看到"已经等了多久"。
  it("shows elapsed seconds while the sync request runs", () => {
    vi.useFakeTimers();
    try {
      renderDialog({ busy: true });
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByRole("button", { name: /放大中… 3s/ })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the kernel error body", () => {
    renderDialog({ error: "upscaled dimensions must not exceed 8192 x 8192" });

    expect(screen.getByRole("alert")).toHaveTextContent(/8192/);
  });

  it("renders nothing while closed", () => {
    const { container } = renderDialog({ open: false });

    expect(container).toBeEmptyDOMElement();
  });

  // 上游 #2396：/upscale 对 0 < tile_size < 32 改为 HTTP 400（不再静默钳制到 32）。
  it("blocks tileSize between 1 and 31 and allows 0 or >= 32", async () => {
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });

    const input = screen.getByLabelText(/分块尺寸/);
    await userEvent.clear(input);
    await userEvent.type(input, "16{Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent(/≥ 32/);
    expect(screen.getByRole("button", { name: "开始放大" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, "64{Enter}");

    expect(screen.queryByRole("alert")).toBeNull();
    const submit = screen.getByRole("button", { name: "开始放大" });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ tileSize: 64 }));
  });
});
