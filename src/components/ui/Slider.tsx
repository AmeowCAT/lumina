import { type ReactNode, useId } from "react";
import { Slider as RxSlider } from "radix-ui";
import { cn } from "./cn";

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
}: {
  label?: ReactNode;
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  hint?: ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  const isSet = typeof value === "number" && !Number.isNaN(value);
  const numVal = isSet ? value : min;
  const d = isSet
    ? Number.isInteger(step || 1)
      ? numVal
      : numVal.toFixed(2)
    : "—";
  return (
    <div className="form-row">
      {label ? (
        <span id={labelId} className="form-label">
          {label}
          {hint ? (
            <span id={hintId} className="form-sublabel">
              {hint}
            </span>
          ) : null}
        </span>
      ) : null}
      <div className={cn("slider-row", !isSet && "slider-unset")}>
        <RxSlider.Root
          className="slider-root"
          value={[numVal]}
          onValueChange={(v) => onChange(v[0])}
          min={min}
          max={max}
          step={step || 1}
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
        <span className="slider-val">{d}</span>
      </div>
    </div>
  );
}
