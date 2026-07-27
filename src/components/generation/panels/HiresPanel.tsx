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
          <div className="form-row" style={{ marginTop: 8 }}>
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
        </>
      )}
    </Panel>
  );
});
