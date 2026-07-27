import { type ReactNode, useId } from "react";
import { Switch as RxSwitch } from "radix-ui";

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
      <RxSwitch.Root
        id={inputId}
        className="switch-root"
        checked={checked}
        onCheckedChange={onChange}
      >
        <RxSwitch.Thumb className="switch-thumb" />
      </RxSwitch.Root>
    </label>
  );
}
