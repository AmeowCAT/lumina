import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Lightbox,
  UNPLAYABLE_VIDEO_HINT,
  isUnplayableVideoMime,
  type LightboxItem,
} from "../Lightbox";

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

describe("Lightbox 容器判定（审查 §2.2）", () => {
  it("animated WebP 走图片通道：渲染 <img> 而不是 <video>", () => {
    const animated: LightboxItem[] = [
      {
        type: "image",
        src: "blob:animated-webp",
        mime: "image/webp",
        title: "clip.webp",
      },
    ];
    render(<Lightbox items={animated} index={0} onClose={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:animated-webp");
    expect(document.querySelector("video")).toBeNull();
  });

  it("video/* 容器仍然渲染可播放的 <video>", () => {
    const video: LightboxItem[] = [
      { type: "video", src: "blob:webm", mime: "video/webm" },
    ];
    render(<Lightbox items={video} index={0} onClose={vi.fn()} />);
    expect(document.querySelector("video")).toHaveAttribute("src", "blob:webm");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("AVI/MJPG 给可读提示，不再塞进必然黑屏的 <video>", () => {
    const avi: LightboxItem[] = [
      { type: "video", src: "blob:avi", mime: "video/x-msvideo" },
    ];
    render(<Lightbox items={avi} index={0} onClose={vi.fn()} />);
    expect(screen.getByRole("note").textContent).toContain(UNPLAYABLE_VIDEO_HINT);
    expect(screen.getByRole("note").textContent).toContain("video/x-msvideo");
    expect(document.querySelector("video")).toBeNull();
  });

  it("只把 AVI 系列 MIME 判为不可播", () => {
    expect(isUnplayableVideoMime("video/x-msvideo")).toBe(true);
    expect(isUnplayableVideoMime("VIDEO/X-MSVIDEO")).toBe(true);
    expect(isUnplayableVideoMime("video/webm")).toBe(false);
    expect(isUnplayableVideoMime("image/webp")).toBe(false);
    expect(isUnplayableVideoMime(undefined)).toBe(false);
  });
});
