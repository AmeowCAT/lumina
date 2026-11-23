import { type ReactNode, useId } from "react";
import { Slider as RxSlider } from "radix-ui";
import { formatNumberForInput } from "../../lib/utils";
import { InfoTip } from "./InfoTip";
import { cn } from "./cn";

/**
 * 滑杆右侧的数值文案。
 *
 * 浮点参数可能来自上游默认值或元数据（0.20000000298023224），先按 6 位有效数字
 * 收敛；步进小于 1 时至少保留两位小数（0.7 → 0.70），保留原有读数习惯，同时
 * 不再把 0.875 舍成 0.88。
 */
function sliderValueText(value: number, step: number | undefined): string {
  const text = formatNumberForInput(value);
  const increment = step ?? 1;
  if (!(increment > 0 && increment < 1) || /[eE]/.test(text)) return text;
  const dot = text.indexOf(".");
  const decimals = dot < 0 ? 0 : text.length - dot - 1;
  if (decimals >= 2) return text;
  return dot < 0 ? `${text}.00` : `${text}${"0".repeat(2 - decimals)}`;
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  hintTone,
  hintLabel,
  sublabel,
  disabled,
}: {
  label?: ReactNode;
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  /** 收纳于 ⓘ InfoTip 浮层中的完整参数说明 */
  hint?: ReactNode;
  hintTone?: "default" | "accent" | "warn";
  hintLabel?: ReactNode;
  /** 可选极短内联锚点（如 "0 = 自动"） */
  sublabel?: ReactNode;
  disabled?: boolean;
}) {
  const labelId = useId();
  const hintId = useId();
  const isSet = typeof value === "number" && !Number.isNaN(value);
  const numVal = isSet ? value : min;
  const d = isSet ? sliderValueText(numVal, step) : "—";
  return (
    <div className="form-row">
      {label ? (
        <span className="form-label">
          <span id={labelId}>{label}</span>
          {sublabel ? <span className="field-anchor">{sublabel}</span> : null}
          {hint ? (
            <InfoTip id={hintId} tone={hintTone} label={hintLabel}>
              {hint}
            </InfoTip>
          ) : null}
        </span>
      ) : null}
      <div className={cn("slider-row", !isSet && "slider-unset", disabled && "opacity-50")}>
        <RxSlider.Root
          className="slider-root"
          value={[numVal]}
          onValueChange={(v) => onChange(v[0])}
          min={min}
          max={max}
          step={step || 1}
          disabled={disabled}
        >
          <RxSlider.Track className="slider-track">
            <RxSlider.Range className="slider-range" />
          </RxSlider.Track>
          <RxSlider.Thumb
            className="slider-thumb"
            aria-label={label ? undefined : "参数值"}
            aria-labelledby={label ? labelId : undefined}
            aria-describedby={hint ? hintId : undefined}
            aria-valuetext={isSet ? String(d) : "未设置"}
          />
        </RxSlider.Root>
        <span className="slider-val font-variant-tnum">{d}</span>
      </div>
    </div>
  );
}
