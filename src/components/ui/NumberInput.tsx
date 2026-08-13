import { useEffect, useId, useState, type CSSProperties } from "react";
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
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setInvalid(true);
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    setInvalid(false);
    setDraft(String(clamped));
    onChange(clamped);
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
