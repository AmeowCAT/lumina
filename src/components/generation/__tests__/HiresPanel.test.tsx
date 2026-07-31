import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HiresPanel } from "../panels/HiresPanel";

describe("HiresPanel", () => {
  it("only offers valid tile sizes and explains a single zero dimension", () => {
    render(
      <HiresPanel
        hires={{
          enabled: true,
          target_width: 2048,
          target_height: 0,
          upscale_tile_size: 128,
        }}
        upscalers={[]}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByRole("slider", { name: /放大分块/ })).toHaveAttribute(
      "aria-valuemin",
      "32"
    );
    expect(
      screen.getByText("宽高均为 0：按缩放换算；仅一边为 0：补为另一边（正方形）")
    ).toBeTruthy();
  });
});
