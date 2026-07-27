import { memo } from "react";
import { Slider as RxSlider } from "radix-ui";
import type { LoraEntry } from "../../../types";
import { Panel } from "../../ui/Panel";
import { Select } from "../../ui/Select";
import { NumberInput } from "../../ui/NumberInput";
import { IC } from "../../ui/Icons";

interface Props {
  loras: LoraEntry[];
  available: { name: string; path: string }[];
  onUpdate: (path: string, v: unknown) => void;
}

export const LoraPanel = memo(function LoraPanel({
  loras,
  available,
  onUpdate,
}: Props) {
  return (
    <Panel title="LoRA" badge={loras.length || null}>
      {loras.map((l, i) => {
        const setMult = (v: number) => {
          const n = [...loras];
          n[i] = { ...n[i], multiplier: v };
          onUpdate("lora", n);
        };
        return (
          <div key={i} className="lora-row">
            <div className="lora-row-main">
              <Select
                ariaLabel={`第 ${i + 1} 个 LoRA 模型`}
                value={l.path}
                onChange={(v) => {
                  const n = [...loras];
                  n[i] = { ...n[i], path: v };
                  onUpdate("lora", n);
                }}
                options={[
                  { value: "", label: "-- 选择 LoRA --" },
                  ...available.map((l2) => ({ value: l2.path, label: l2.name })),
                ]}
              />
              <button
                className="lora-remove"
                onClick={() =>
                  onUpdate(
                    "lora",
                    loras.filter((_, j) => j !== i)
                  )
                }
              >
                {IC.x}
              </button>
            </div>
            <div className="lora-mult-row">
              <span className="lora-mult-label">强度</span>
              <RxSlider.Root
                className="slider-root"
                value={[l.multiplier ?? 1]}
                onValueChange={(v) => setMult(v[0])}
                min={0}
                max={2}
                step={0.05}
                aria-label={`第 ${i + 1} 个 LoRA 强度滑块`}
              >
                <RxSlider.Track className="slider-track">
                  <RxSlider.Range className="slider-range" />
                </RxSlider.Track>
                <RxSlider.Thumb
                  className="slider-thumb"
                  aria-label={`第 ${i + 1} 个 LoRA 强度滑块`}
                />
              </RxSlider.Root>
              <NumberInput
                className="lora-mult-num"
                min={0}
                max={2}
                step={0.05}
                value={l.multiplier ?? 1}
                onChange={setMult}
                ariaLabel={`第 ${i + 1} 个 LoRA 强度`}
              />
            </div>
          </div>
        );
      })}
      <button
        className="add-lora"
        onClick={() => onUpdate("lora", [...loras, { path: "", multiplier: 1 }])}
      >
        {IC.plus} 添加 LoRA
      </button>
    </Panel>
  );
});
