import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UpscalerInfo } from "../../../types";
import { UpscaleDialog } from "../UpscaleDialog";

const UPSCALERS: UpscalerInfo[] = [
  { name: "RealESRGAN_x4plus", model: true, image_upscale: true },
];

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
    />
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
  });

  it("surfaces the kernel error body", () => {
    renderDialog({ error: "upscaled dimensions must not exceed 8192 x 8192" });

    expect(screen.getByRole("alert")).toHaveTextContent(/8192/);
  });

  it("renders nothing while closed", () => {
    const { container } = renderDialog({ open: false });

    expect(container).toBeEmptyDOMElement();
  });
});
