import { useMemo } from "react";
import type {
  Capabilities,
  Features,
  GenMode,
  GenParams,
} from "../../types";
import { FAMILY_CONFIG, SIZE_PRESETS, VIDEO_FRAME_PRESETS } from "../../config/families";
import { ParamsSheet } from "./ParamsSheet";
import { ImageInputsPanel } from "./panels/ImageInputsPanel";
import { SizeSeedPanel } from "./panels/SizeSeedPanel";
import { SamplingPanel } from "./panels/SamplingPanel";
import { AdvancedSamplingPanel } from "./panels/AdvancedSamplingPanel";
import { HighNoisePanel } from "./panels/HighNoisePanel";
import { LoraPanel } from "./panels/LoraPanel";
import { HiresPanel } from "./panels/HiresPanel";
import { OutputPanel } from "./panels/OutputPanel";

/**
 * 参数 Sheet 及其全部面板。从 GenerationUI 拆出并作为独立 chunk 懒加载：
 * 参数面板属低频模块，动态 import() 降低首屏解析成本。
 *
 * GenerationUI 只保留少量闭包与状态（family/sizeBase/sizeScale 与各
 * 回调），其余面板需要的值经 props 显式传入——模块内部不隐式读 store，
 * 保持与旧 JSX 逐字段等价。
 */
export interface GenerationParamsSheetProps {
  open: boolean;
  onClose: () => void;
  caps: Capabilities;
  mode: GenMode;
  family: string;
  features: Features;
  refImagesSupported: boolean;
  controlFramesSupported: boolean;
  initImage: string | null;
  maskImage: string | null;
  controlImage: string | null;
  ipAdapterImage: string | null;
  endImage: string | null;
  refImages: string[];
  controlFrames: string[];
  params: GenParams;
  seedRandom: boolean;
  sizeScale: number;
  showDistilled: boolean;
  sheetTarget: "size" | "sampling" | null;
  onUpdate: (path: string, val: unknown) => void;
  onSetImage: (
    which:
      | "initImage"
      | "maskImage"
      | "controlImage"
      | "ipAdapterImage"
      | "endImage",
    v: string | null
  ) => void;
  onSetRefImages: (updater: (r: string[]) => string[]) => void;
  onSetControlFrames: (updater: (r: string[]) => string[]) => void;
  onInitSize: (w: number, h: number) => void;
  onSizeScale: (scale: number) => void;
  onSizeBaseReset: (w: number, h: number) => void;
  onSeedEdit: (raw: string) => void;
  onRandomSeed: () => void;
  onReset: () => void;
}

export function GenerationParamsSheet(props: GenerationParamsSheetProps) {
  const {
    open,
    onClose,
    caps,
    mode,
    family,
    features,
    refImagesSupported,
    controlFramesSupported,
    initImage,
    maskImage,
    controlImage,
    ipAdapterImage,
    endImage,
    refImages,
    controlFrames,
    params,
    seedRandom,
    sizeScale,
    showDistilled,
    sheetTarget,
    onUpdate,
    onSetImage,
    onSetRefImages,
    onSetControlFrames,
    onInitSize,
    onSizeScale,
    onSizeBaseReset,
    onSeedEdit,
    onRandomSeed,
    onReset,
  } = props;

  const sp = params.sample_params;
  const hsp = params.high_noise_sample_params;
  const sizePresets = useMemo(() => SIZE_PRESETS[mode], [mode]);
  const framePresets = useMemo(
    () => VIDEO_FRAME_PRESETS[family],
    [family]
  );

  return (
    <ParamsSheet open={open} onClose={onClose}>
      {(features.init_image ||
        features.mask_image ||
        features.control_image ||
        features.ip_adapter_image ||
        features.end_image ||
        refImagesSupported ||
        controlFramesSupported) && (
        <ImageInputsPanel
          features={features}
          mode={mode}
          family={family}
          initImage={initImage}
          maskImage={maskImage}
          controlImage={controlImage}
          ipAdapterImage={ipAdapterImage}
          endImage={endImage}
          refImages={refImages}
          controlFrames={controlFrames}
          controlFramesSupported={controlFramesSupported}
          refImagesSupported={refImagesSupported}
          strength={params.strength}
          controlStrength={params.control_strength}
          ipAdapterStrength={params.ip_adapter_strength}
          imgCfg={sp?.guidance?.img_cfg}
          txtCfg={sp?.guidance?.txt_cfg}
          onUpdate={onUpdate}
          onSetImage={onSetImage}
          onSetRefImages={onSetRefImages}
          onSetControlFrames={onSetControlFrames}
          onInitSize={onInitSize}
        />
      )}
      <SizeSeedPanel
        mode={mode}
        family={family}
        width={params.width}
        height={params.height}
        seed={params.seed}
        seedRandom={seedRandom}
        batchCount={params.batch_count}
        videoFrames={params.video_frames}
        fps={params.fps}
        qwenLayers={params.qwen_image_layers}
        limits={caps.limits}
        sizePresets={sizePresets}
        sizeScale={sizeScale}
        framePresets={framePresets}
        framePresetsLabel={`${FAMILY_CONFIG[family]?.name || "视频"} 帧数快捷项`}
        onUpdate={onUpdate}
        onSizeScale={onSizeScale}
        onSizeBaseReset={onSizeBaseReset}
        onSeedEdit={onSeedEdit}
        onRandomSeed={onRandomSeed}
        forceOpen={sheetTarget === "size"}
      />
      <SamplingPanel
        samplers={caps.samplers || []}
        schedulers={caps.schedulers || []}
        sampleMethod={sp?.sample_method || "default"}
        scheduler={sp?.scheduler || "default"}
        steps={sp?.sample_steps}
        txtCfg={sp?.guidance?.txt_cfg}
        distilled={sp?.guidance?.distilled_guidance}
        showDistilled={showDistilled}
        betaAlpha={sp?.beta_alpha}
        betaBeta={sp?.beta_beta}
        lmsMaxOrder={sp?.lms_max_order}
        lmsShift={sp?.lms_shift}
        lmsDivisions={sp?.lms_divisions}
        onUpdate={onUpdate}
        onReset={onReset}
        forceOpen={sheetTarget === "sampling"}
      />
      <AdvancedSamplingPanel
        eta={sp?.eta}
        flowShift={sp?.flow_shift}
        slg={sp?.guidance?.slg}
        vaeTilingParams={params.vae_tiling_params}
        cacheMode={params.cache_mode}
        clipSkip={params.clip_skip}
        extraSampleArgs={sp?.extra_sample_args}
        onUpdate={onUpdate}
      />
      {mode === "vid_gen" && family === "wan-a14b" && (
        <HighNoisePanel
          samplers={caps.samplers || []}
          schedulers={caps.schedulers || []}
          hsp={hsp}
          fallbackSampleMethod={sp?.sample_method || "default"}
          fallbackScheduler={sp?.scheduler || "default"}
          moeBoundary={params.moe_boundary}
          showDistilled={showDistilled}
          betaAlpha={hsp?.beta_alpha}
          betaBeta={hsp?.beta_beta}
          onUpdate={onUpdate}
        />
      )}
      {features.lora && (
        <LoraPanel
          loras={params.lora || []}
          available={caps.loras || []}
          onUpdate={onUpdate}
        />
      )}
      {features.hires && (
        <HiresPanel
          hires={params.hires}
          upscalers={(caps.upscalers || []).map((u) => u.name)}
          onUpdate={onUpdate}
        />
      )}
      <OutputPanel
        mode={mode}
        outputFormat={params.output_format}
        formats={caps.output_formats_by_mode?.[mode] || ["png"]}
        compression={params.output_compression}
        onUpdate={onUpdate}
      />
    </ParamsSheet>
  );
}
