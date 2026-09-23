import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GenerationParamsSheet } from "../GenerationParamsSheet";
import { FAMILY_CONFIG } from "../../../config/families";
import type { Capabilities, Features, GenParams } from "../../../types";

/**
 * 家族 `generationHint` 曾经直接渲染成 Sheet 顶部一段常显的 `field-hint`
 * （在所有可折叠面板之外），长文案会把输入面板整块推下去，观感很差。
 * 现在它必须待在末尾的折叠面板里：默认不可见，需要时再展开。
 */
function renderSheet(family: string) {
  const onUpdate = vi.fn();
  render(
    <GenerationParamsSheet
      open
      onClose={vi.fn()}
      caps={{} as Capabilities}
      mode="img_gen"
      family={family}
      features={{} as Features}
      refImagesSupported={false}
      controlFramesSupported={false}
      initImage={null}
      maskImage={null}
      controlImage={null}
      ipAdapterImage={null}
      endImage={null}
      refImages={[]}
      controlFrames={[]}
      params={
        {
          width: 1024,
          height: 1024,
          seed: 1,
          sample_params: {},
        } as GenParams
      }
      seedRandom={false}
      sizeScale={1}
      showDistilled={false}
      sheetTarget={null}
      onUpdate={onUpdate}
      onSetImage={vi.fn()}
      onSetRefImages={vi.fn()}
      onSetControlFrames={vi.fn()}
      onInitSize={vi.fn()}
      onSizeScale={vi.fn()}
      onSizeBaseReset={vi.fn()}
      onSeedEdit={vi.fn()}
      onRandomSeed={vi.fn()}
      onReset={vi.fn()}
    />
  );
}

describe("GenerationParamsSheet family hint", () => {
  it("keeps the hint inside a collapsed panel instead of a top-of-sheet block", () => {
    const hint = FAMILY_CONFIG["qwen-image-2.1"].generationHint!;
    renderSheet("qwen-image-2.1");

    const head = screen.getByRole("button", { name: "模型使用提示" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    const panel = head.closest(".panel");
    expect(panel).toHaveClass("collapsed");
    // 文案仍在 DOM 里（展开即可读），但归属折叠面板。
    expect(within(panel as HTMLElement).getByRole("note")).toHaveTextContent(hint);
  });

  it("never puts the hint directly into the sheet scroll area", () => {
    renderSheet("qwen-image-2.1");
    const scroll = document.querySelector(".params-sheet-scroll")!;
    // 直接子节点只能是一层层 panel；role=note 必须被包在 .panel 内。
    expect(scroll.querySelector(":scope > [role='note']")).toBeNull();
    expect(scroll.querySelector(":scope > .panel [role='note']")).not.toBeNull();
  });

  it("renders no hint panel for a family without one", () => {
    expect(FAMILY_CONFIG.flux.generationHint).toBeUndefined();
    renderSheet("flux");
    expect(
      screen.queryByRole("button", { name: "模型使用提示" })
    ).not.toBeInTheDocument();
  });
});
