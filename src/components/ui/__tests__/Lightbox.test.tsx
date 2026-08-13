import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "../Lightbox";

const items = [
  { type: "image" as const, src: "data:image/png;base64,a", title: "图一" },
  { type: "image" as const, src: "data:image/png;base64,b", title: "图二" },
];

describe("Lightbox", () => {
  it("双击图片本身放大到 250%", () => {
    render(
      <Lightbox items={items} index={0} onClose={vi.fn()} onNavigate={vi.fn()} />
    );
    fireEvent.dblClick(screen.getByRole("img"));
    expect(screen.getByRole("button", { name: "重置图片缩放" }).textContent).toBe(
      "250%"
    );
  });

  it("快速双击导航按钮不会放大(翻页防误触)", () => {
    render(
      <Lightbox items={items} index={0} onClose={vi.fn()} onNavigate={vi.fn()} />
    );
    const next = screen.getAllByRole("button", { name: "下一张" })[0];
    fireEvent.click(next);
    fireEvent.dblClick(next);
    expect(screen.getByRole("button", { name: "重置图片缩放" }).textContent).toBe(
      "100%"
    );
  });

  it("切换到另一张图时同步重置缩放", () => {
    const { rerender } = render(
      <Lightbox items={items} index={0} onClose={vi.fn()} onNavigate={vi.fn()} />
    );
    fireEvent.dblClick(screen.getByRole("img"));
    expect(screen.getByRole("button", { name: "重置图片缩放" }).textContent).toBe(
      "250%"
    );

    rerender(
      <Lightbox items={items} index={1} onClose={vi.fn()} onNavigate={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "重置图片缩放" }).textContent).toBe(
      "100%"
    );
  });
});
