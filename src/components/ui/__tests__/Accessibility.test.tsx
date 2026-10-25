import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox } from "../Lightbox";
import { Slider } from "../Slider";
import { Toggle } from "../Toggle";
import { NumberInput } from "../NumberInput";

describe("accessible UI controls", () => {
  it("associates slider and toggle labels with their inputs", () => {
    render(
      <>
        <Slider label="采样步数" value={20} min={1} max={50} onChange={vi.fn()} />
        <Toggle label="启用缓存" checked={false} onChange={vi.fn()} />
      </>,
    );

    expect(screen.getByRole("slider", { name: "采样步数" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用缓存" })).toBeTruthy();
  });

  it("closes the lightbox with Escape and restores focus", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">打开预览</button>
        <Lightbox items={[]} index={0} onClose={onClose} />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "打开预览" });
    trigger.focus();

    rerender(
      <>
        <button type="button">打开预览</button>
        <Lightbox
          items={[{ type: "image", src: "data:image/png;base64," }]}
          index={0}
          onClose={onClose}
        />
      </>,
    );

    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭预览"),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <button type="button">打开预览</button>
        <Lightbox items={[]} index={0} onClose={onClose} />
      </>,
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe("打开预览"));
  });

  it("allows an empty numeric draft and validates only when committed", () => {
    const onChange = vi.fn();
    render(<NumberInput value={512} min={64} max={2048} onChange={onChange} ariaLabel="宽度" />);
    const input = screen.getByRole("spinbutton", { name: "宽度" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    expect((input as HTMLInputElement).value).toBe("");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "4096" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(2048);
  });

  // 上游默认值/元数据里的 float 会带出 17 位尾巴；输入框显示与回填都要收敛。
  it("collapses float noise in number inputs and on commit", () => {
    const onChange = vi.fn();
    // 20 位字面量在 JS 里无法精确表示，用字符串构造避免 no-loss-of-precision。
    const noisyStart = Number("0.00999999999776482582");
    const { rerender } = render(
      <NumberInput value={noisyStart} step={0.01} onChange={onChange} ariaLabel="SLG 起始" />,
    );
    const input = screen.getByRole("spinbutton", { name: "SLG 起始" });
    expect(input).toHaveValue(0.01);
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(0.01);

    rerender(
      <NumberInput
        value={0.20000000298023224}
        step={0.01}
        onChange={onChange}
        ariaLabel="SLG 结束"
      />,
    );
    expect(screen.getByRole("spinbutton", { name: "SLG 结束" })).toHaveValue(0.2);
  });

  // 滑杆读数：0.875 不能被舍成 0.88，0.2000000029 也不能显示整串尾巴。
  it("keeps slider readouts precise without float tails", () => {
    const { rerender } = render(
      <Slider label="MoE 分界" value={0.875} min={0} max={1} step={0.05} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("slider", { name: "MoE 分界" })).toHaveAttribute(
      "aria-valuetext",
      "0.875",
    );
    rerender(
      <Slider
        label="MoE 分界"
        value={0.20000000298023224}
        min={0}
        max={1}
        step={0.05}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("slider", { name: "MoE 分界" })).toHaveAttribute(
      "aria-valuetext",
      "0.20",
    );
  });
});
