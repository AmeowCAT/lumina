import { memo } from "react";
import type { GenMode, Limits } from "../../../types";
import {
  alignSizeUp,
  alignVideoFrames,
  SIZE_SPATIAL_ALIGN,
  VIDEO_FRAME_ALIGN,
  VIDEO_FRAME_MAX,
} from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { NumberInput } from "../../ui/NumberInput";
import { IC } from "../../ui/Icons";
import { cn } from "../../ui/cn";

interface SizePresetGroup {
  label: string;
  sizes: [string, number, number][];
}

interface Props {
  mode: GenMode;
  family: string;
  width: number;
  height: number;
  seed: number;
  seedRandom: boolean;
  batchCount: number | undefined;
  videoFrames: number | undefined;
  fps: number | undefined;
  qwenLayers: number | undefined;
  limits: Limits | undefined;
  sizePresets: SizePresetGroup[];
  framePresets: number[] | undefined;
  framePresetsLabel: string;
  onUpdate: (path: string, v: unknown) => void;
  onSeedEdit: (raw: string) => void;
  onRandomSeed: () => void;
  /** 参数 chip 深链:召唤 Sheet 时强制展开本面板 */
  forceOpen?: boolean;
}

export const SizeSeedPanel = memo(function SizeSeedPanel({
  mode,
  family,
  width,
  height,
  seed,
  seedRandom,
  batchCount,
  videoFrames,
  fps,
  qwenLayers,
  limits,
  sizePresets,
  framePresets,
  framePresetsLabel,
  onUpdate,
  onSeedEdit,
  onRandomSeed,
  forceOpen,
}: Props) {
  // 上游 align_image_size 会把宽高向上对齐到家族的空间基数（MiniMax-H3 为 32）；
  // 与帧数提示同理，提前说明显示尺寸与实际输出不一致的情况。
  const spatialMultiple = SIZE_SPATIAL_ALIGN[family];
  const alignedWidth = alignSizeUp(family, width);
  const alignedHeight = alignSizeUp(family, height);
  const sizeWillChange = alignedWidth !== width || alignedHeight !== height;
  return (
    <Panel title="尺寸与种子" forceOpen={forceOpen}>
      <div className="size-presets">
        {sizePresets.map((grp) => (
          <div key={grp.label} className="size-group">
            <span className="size-group-label">{grp.label}</span>
            <div className="size-group-btns">
              {grp.sizes.map(([l, w, h]) => (
                <button
                  key={l}
                  className={cn(
                    "size-preset",
                    width === w && height === h && "active"
                  )}
                  aria-pressed={width === w && height === h}
                  onClick={() => {
                    onUpdate("width", w);
                    onUpdate("height", h);
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="generation-width">
          宽度
        </label>
        <NumberInput
          id="generation-width"
          value={width}
          onChange={(value) => onUpdate("width", value)}
          min={limits?.min_width || 64}
          max={limits?.max_width || 4096}
          step={64}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="generation-height">
          高度
        </label>
        <NumberInput
          id="generation-height"
          value={height}
          onChange={(value) => onUpdate("height", value)}
          min={limits?.min_height || 64}
          max={limits?.max_height || 4096}
          step={64}
        />
        {spatialMultiple && sizeWillChange && (
          <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
            实际生成 {alignedWidth}×{alignedHeight}（该模型按 {spatialMultiple}{" "}
            向上对齐）
          </div>
        )}
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <label className="form-label" htmlFor="generation-seed">
          种子
        </label>
        <div className="seed-row">
          <input
            id="generation-seed"
            className="input"
            type="number"
            value={seed < 0 ? "" : seed}
            onChange={(e) => onSeedEdit(e.target.value)}
            placeholder="随机"
          />
          <button
            className={cn("seed-btn", seedRandom && "active")}
            title="随机种子"
            aria-label="切换每次生成使用随机种子"
            aria-pressed={seedRandom}
            onClick={onRandomSeed}
          >
            {IC.dice}
          </button>
        </div>
      </div>
      {mode === "img_gen" && (
        <Slider
          label="批量"
          value={batchCount || 1}
          onChange={(v) => onUpdate("batch_count", v)}
          min={1}
          max={limits?.max_batch_count || 8}
        />
      )}
      {mode === "img_gen" && family === "qwen-image-layered" && (
        <div className="form-row" style={{ marginTop: 8 }}>
          <label className="form-label" htmlFor="qwen-image-layers">
            分层数量
          </label>
          <NumberInput
            id="qwen-image-layers"
            value={qwenLayers ?? 3}
            onChange={(value) => onUpdate("qwen_image_layers", value)}
            min={0}
            step={1}
            style={{ width: 80 }}
          />
          <div className="field-hint" style={{ margin: "2px 0 0 0" }}>
            最终输出数量为分层数量 + 1
          </div>
        </div>
      )}
      {mode === "vid_gen" && (
        <>
          <Slider
            label="帧数"
            value={videoFrames || 33}
            onChange={(v) => onUpdate("video_frames", v)}
            min={1}
            max={VIDEO_FRAME_MAX[family] ?? 121}
            hint={
              // 上游会调整帧数（step·n+1 向下；MiniMax-H3 是 17k+5 向上）；
              // 提前说明避免"设了 34 却出 33 帧 / 设了 50 却出 56 帧"。
              alignVideoFrames(family, videoFrames || 33) !== (videoFrames || 33)
                ? `实际生成 ${alignVideoFrames(family, videoFrames || 33)} 帧（${
                    family.startsWith("minimax-h3")
                      ? "该模型按 17k+5 向上对齐"
                      : `该模型按 ${VIDEO_FRAME_ALIGN[family]}n+1 对齐`
                  }）`
                : undefined
            }
          />
          {framePresets && (
            <div className="frame-presets" aria-label={framePresetsLabel}>
              {framePresets.map((frames) => (
                <button
                  type="button"
                  key={frames}
                  className={cn(
                    "size-preset",
                    videoFrames === frames && "active"
                  )}
                  onClick={() => onUpdate("video_frames", frames)}
                >
                  {frames} 帧
                </button>
              ))}
            </div>
          )}
          <Slider
            label="FPS"
            value={fps || 24}
            onChange={(v) => onUpdate("fps", v)}
            min={1}
            max={60}
            hint={
              // 引擎对 MiniMax-H3 强制 24 fps（src/stable-diffusion.cpp
              // GenerationRequest），其他取值会被静默覆盖，提前说明。
              family.startsWith("minimax-h3")
                ? "该模型固定 24 fps，其他值会被引擎覆盖"
                : undefined
            }
          />
        </>
      )}
    </Panel>
  );
});
