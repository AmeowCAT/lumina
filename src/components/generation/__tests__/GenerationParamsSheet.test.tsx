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
      refVideos={[]}
      refAudios={[]}
      refVideoAudios={[]}
      refVideosSupported={false}
      refAudiosSupported={false}
      refVideoAudiosSupported={false}
      onSetRefVideos={vi.fn()}
      onSetRefAudios={vi.fn()}
      onSetRefVideoAudios={vi.fn()}
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
      sizeStep={1}
      onSizeStep={vi.fn()}
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
    />,
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
    expect(screen.queryByRole("button", { name: "模型使用提示" })).not.toBeInTheDocument();
  });
});

// 上游 #2194：Ref2VA 参考媒体控件只在 ref2va 家族 + 内核声明 feature 时出现。
describe("GenerationParamsSheet ref media", () => {
  function renderRef2va(videosSupported: boolean) {
    render(
      <GenerationParamsSheet
        open
        onClose={vi.fn()}
        caps={{} as Capabilities}
        mode="vid_gen"
        family="minimax-h3-ref2va"
        features={{} as Features}
        refImagesSupported
        controlFramesSupported={false}
        initImage={null}
        maskImage={null}
        controlImage={null}
        ipAdapterImage={null}
        endImage={null}
        refImages={[]}
        controlFrames={[]}
        refVideos={[]}
        refAudios={[]}
        refVideoAudios={[]}
        refVideosSupported={videosSupported}
        refAudiosSupported={videosSupported}
        refVideoAudiosSupported={videosSupported}
        onSetRefVideos={vi.fn()}
        onSetRefAudios={vi.fn()}
        onSetRefVideoAudios={vi.fn()}
        params={{ width: 864, height: 480, seed: 1, sample_params: {} } as GenParams}
        seedRandom={false}
        sizeScale={1}
        sizeStep={1}
        onSizeStep={vi.fn()}
        showDistilled={false}
        sheetTarget={null}
        onUpdate={vi.fn()}
        onSetImage={vi.fn()}
        onSetRefImages={vi.fn()}
        onSetControlFrames={vi.fn()}
        onInitSize={vi.fn()}
        onSizeScale={vi.fn()}
        onSizeBaseReset={vi.fn()}
        onSeedEdit={vi.fn()}
        onRandomSeed={vi.fn()}
        onReset={vi.fn()}
      />,
    );
  }

  it("shows the media inputs when the kernel advertises the features", () => {
    renderRef2va(true);
    expect(screen.getByRole("button", { name: "添加参考视频" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加参考音频" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加视频音轨" })).toBeTruthy();
  });

  it("hides the media inputs for legacy kernels without the features", () => {
    renderRef2va(false);
    expect(screen.queryByRole("button", { name: "添加参考视频" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加参考音频" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加视频音轨" })).toBeNull();
  });
});

// 上游 #2396（DGL）与 #2341（prompt_images）：Sheet 按内核能力动态隐藏 DGL-only 控件、
// 切向上帧对齐提示，并按 feature 展示提示词内联图片区。
describe("GenerationParamsSheet DGL & prompt_images gating", () => {
  const DGL_CAPS = {
    generation_features: {
      slg: false,
      shifted_timestep: false,
      image_preprocess: false,
      ref_image_args: false,
      increase_ref_index: false,
      ip_adapter: false,
    },
    defaults_by_mode: {
      vid_gen: {
        width: null,
        height: null,
        vae_tiling_params: { tile_size_w: null, tile_size_h: null },
      },
    },
    features_by_mode: {
      vid_gen: {
        ref_images: true,
        prompt_images: true,
        high_noise_sample_params: false,
      },
    },
  } as unknown as Capabilities;

  it("hides ImagePreprocessPanel / SLG / H3 ref_image_size and shows prompt_images & upward frame hint on DGL kernels", () => {
    render(
      <GenerationParamsSheet
        open
        onClose={vi.fn()}
        caps={DGL_CAPS}
        mode="vid_gen"
        family="wan-t2v"
        features={{ ref_images: true, prompt_images: true, high_noise_sample_params: false }}
        refImagesSupported
        controlFramesSupported={false}
        initImage={null}
        maskImage={null}
        controlImage={null}
        ipAdapterImage={null}
        endImage={null}
        refImages={[]}
        controlFrames={[]}
        refVideos={[]}
        refAudios={[]}
        refVideoAudios={[]}
        refVideosSupported={false}
        refAudiosSupported={false}
        refVideoAudiosSupported={false}
        onSetRefVideos={vi.fn()}
        onSetRefAudios={vi.fn()}
        onSetRefVideoAudios={vi.fn()}
        promptImages={{}}
        promptImagesSupported
        onSetPromptImages={vi.fn()}
        onInsertPromptImageRef={vi.fn()}
        params={
          {
            width: 832,
            height: 480,
            video_frames: 34,
            fps: 16,
            seed: 1,
            sample_params: {},
          } as GenParams
        }
        seedRandom={false}
        sizeScale={1}
        sizeStep={1}
        onSizeStep={vi.fn()}
        showDistilled={false}
        sheetTarget={null}
        onUpdate={vi.fn()}
        onSetImage={vi.fn()}
        onSetRefImages={vi.fn()}
        onSetControlFrames={vi.fn()}
        onInitSize={vi.fn()}
        onSizeScale={vi.fn()}
        onSizeBaseReset={vi.fn()}
        onSeedEdit={vi.fn()}
        onRandomSeed={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    // DGL 内核隐藏图像预处理面板和 SLG 跳层
    expect(screen.queryByRole("button", { name: "图像预处理" })).toBeNull();
    expect(screen.queryByLabelText(/跳层索引/)).toBeNull();
    // 提示内联图片区（#2341）可见
    expect(screen.getByText(/提示内联图片/)).toBeTruthy();
    // Wan 34 帧在 DGL 内核下提示向上对齐到 37 帧
    expect(screen.getByText(/实际生成 37 帧.*4n\+1 向上对齐/)).toBeTruthy();
  });
});
