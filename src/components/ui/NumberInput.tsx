import { useEffect, useId, useState, type CSSProperties } from "react";
import { formatNumberForInput } from "../../lib/utils";
import { cn } from "./cn";

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  style?: CSSProperties;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  id,
  className,
  ariaLabel,
  placeholder,
  style,
}: NumberInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  // 上游默认值/元数据里的浮点会带出 float 尾巴（0.00999999999776482582），
  // 显示与回填统一收敛到 6 位有效数字，见 formatNumberForInput。
  const [draft, setDraft] = useState(() => formatNumberForInput(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(formatNumberForInput(value));
  }, [editing, value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setInvalid(true);
      setDraft(formatNumberForInput(value));
      return;
    }
    const clamped = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    // 提交时同样归一：避免把 0.00999999999776482582 这类噪声写回参数/请求体。
    const normalized = Number(formatNumberForInput(clamped));
    setInvalid(false);
    setDraft(formatNumberForInput(clamped));
    onChange(normalized);
  };

  return (
    <input
      id={inputId}
      type="number"
      className={cn("input", invalid && "invalid", className)}
      value={draft}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      style={style}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        commit();
        setEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(String(value));
          setInvalid(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
