import { memo } from "react";
import type { HiresParams } from "../../../types";
import { BUILTIN_UPSCALERS } from "../../../config/families";
import { Panel } from "../../ui/Panel";
import { Slider } from "../../ui/Slider";
import { Toggle } from "../../ui/Toggle";
import { Select } from "../../ui/Select";

interface Props {
  hires: HiresParams | undefined;
  /** caps.upscalers 的名字列表;为空时回退到内置列表 */
  upscalers: string[];
  onUpdate: (path: string, v: unknown) => void;
}

export const HiresPanel = memo(function HiresPanel({
  hires,
  upscalers,
  onUpdate,
}: Props) {
  const options = (upscalers.length ? upscalers : BUILTIN_UPSCALERS).map(
    (u) => ({ value: u, label: u })
  );
  return (
    <Panel title="高清修复" collapsed>
      <Toggle
        label="启用"
        checked={!!hires?.enabled}
        onChange={(v) => onUpdate("hires", { ...hires, enabled: v })}
      />
      {hires?.enabled && (
        <>
          <div className="form-row mt-2">
            <label className="form-label" htmlFor="hires-upscaler">
              放大器
            </label>
            <Select
              id="hires-upscaler"
              value={hires.upscaler || "Latent"}
              onChange={(v) => onUpdate("hires", { ...hires, upscaler: v })}
              options={options}
            />
          </div>
          <Slider
            label="步数"
            value={hires.steps ?? 20}
            onChange={(v) => onUpdate("hires", { ...hires, steps: v })}
            min={1}
            max={100}
          />
          <Slider
            label="缩放"
            value={hires.scale ?? 2}
            onChange={(v) => onUpdate("hires", { ...hires, scale: v })}
            min={1}
            max={4}
            step={0.1}
          />
          <Slider
            label="降噪"
            value={hires.denoising_strength ?? 0.7}
            onChange={(v) =>
              onUpdate("hires", { ...hires, denoising_strength: v })
            }
            min={0}
            max={1}
            step={0.05}
          />
          {/* 两者均为 0 时使用 scale；单边为 0 时上游会补成另一边。 */}
          <Slider
            label="目标宽度"
            value={hires.target_width ?? 0}
            onChange={(v) => onUpdate("hires", { ...hires, target_width: v })}
            min={0}
            max={4096}
            step={64}
            hint={
              hires.target_width
                ? undefined
                : "宽高均为 0：按缩放换算；仅一边为 0：补为另一边（正方形）"
            }
          />
          <Slider
            label="目标高度"
            value={hires.target_height ?? 0}
            onChange={(v) => onUpdate("hires", { ...hires, target_height: v })}
            min={0}
            max={4096}
            step={64}
            hint={
              hires.target_height
                ? undefined
                : "宽高均为 0：按缩放换算；仅一边为 0：补为另一边（正方形）"
            }
          />
          <Slider
            label="放大分块"
            value={hires.upscale_tile_size ?? 128}
            onChange={(v) =>
              onUpdate("hires", { ...hires, upscale_tile_size: v })
            }
            min={32}
            max={1024}
            step={32}
            hint="模型放大器的分块尺寸；显存不足时调小"
          />
        </>
      )}
    </Panel>
  );
});
