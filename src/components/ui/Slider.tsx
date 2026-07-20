import { type ReactNode, useId } from "react";

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
  const inputId = useId();
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
        <label id={labelId} className="form-label" htmlFor={inputId}>
          {label}
          {hint ? (
            <span id={hintId} className="form-sublabel">
              {hint}
            </span>
          ) : null}
        </label>
      ) : null}
      <div className={`slider-row${isSet ? "" : " slider-unset"}`}>
        <input
          id={inputId}
          type="range"
          value={numVal}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          min={min}
          max={max}
          step={step || 1}
          aria-label={label ? undefined : "参数值"}
          aria-labelledby={label ? labelId : undefined}
          aria-describedby={hint ? hintId : undefined}
          aria-valuetext={isSet ? String(d) : "未设置"}
        />
        <span className="slider-val">{d}</span>
      </div>
    </div>
  );
}
