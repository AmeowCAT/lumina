import { type ReactNode, useId } from "react";

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const inputId = useId();
  return (
    <label className="toggle-row" htmlFor={inputId}>
      <span className="form-label">{label}</span>
      <span className="toggle">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-track" />
      </span>
    </label>
  );
}
