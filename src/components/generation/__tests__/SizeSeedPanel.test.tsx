import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SizeSeedPanel } from "../panels/SizeSeedPanel";

function renderPanel(overrides: Record<string, unknown> = {}) {
  const onUpdate = vi.fn();
  const onSizeStep = vi.fn();
  render(
    <SizeSeedPanel
      mode="img_gen"
      family="flux"
      width={1024}
      height={1024}
      seed={42}
      seedRandom={false}
      batchCount={1}
      videoFrames={undefined}
      fps={undefined}
      qwenLayers={undefined}
      limits={undefined}
      sizePresets={[]}
      framePresets={undefined}
      framePresetsLabel="帧数快捷项"
      onUpdate={onUpdate}
      sizeStep={1}
      onSizeStep={onSizeStep}
      onSeedEdit={vi.fn()}
      onRandomSeed={vi.fn()}
      {...overrides}
    />
  );
  return { onUpdate, onSizeStep };
}

describe("SizeSeedPanel 像素步进", () => {
  it("applies the configured step to the width and height inputs", () => {
    renderPanel({ sizeStep: 32 });

    expect(screen.getByLabelText("宽度")).toHaveAttribute("step", "32");
    expect(screen.getByLabelText("高度")).toHaveAttribute("step", "32");
    expect(screen.getByLabelText(/像素步进/)).toHaveValue(32);
  });

  it("keeps single-pixel stepping by default", () => {
    renderPanel();

    expect(screen.getByLabelText("宽度")).toHaveAttribute("step", "1");
    expect(screen.getByLabelText("高度")).toHaveAttribute("step", "1");
    expect(screen.getByLabelText(/像素步进/)).toHaveValue(1);
  });

  it("reports step edits and clamps them into the allowed range", () => {
    const { onSizeStep } = renderPanel();
    const input = screen.getByLabelText(/像素步进/);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "64" } });
    fireEvent.blur(input);
    expect(onSizeStep).toHaveBeenCalledWith(64);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    // NumberInput 自身夹到 min=1，避免出现 0 步进这种无法滑动的值。
    expect(onSizeStep).toHaveBeenLastCalledWith(1);
  });
});
