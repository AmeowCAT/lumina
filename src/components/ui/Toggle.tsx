import { type ReactNode, useId } from "react";
import { Switch as RxSwitch } from "radix-ui";

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  return (
    <label className="toggle-row" htmlFor={inputId}>
      <span className="form-label">{label}</span>
      <RxSwitch.Root
        id={inputId}
        className="switch-root"
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      >
        <RxSwitch.Thumb className="switch-thumb" />
      </RxSwitch.Root>
    </label>
  );
}
