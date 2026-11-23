import { type ReactNode, useId } from "react";
import { Switch as RxSwitch } from "radix-ui";
import { InfoTip } from "./InfoTip";
import { cn } from "./cn";

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
  hintTone,
  hintLabel,
  sublabel,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 收纳于 ⓘ InfoTip 浮层中的完整开关说明 */
  hint?: ReactNode;
  hintTone?: "default" | "accent" | "warn";
  hintLabel?: ReactNode;
  /** 可选极短内联状态锚点 */
  sublabel?: ReactNode;
}) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className={cn("toggle-row", disabled && "opacity-50 cursor-not-allowed")}>
      <span className="inline-flex items-center gap-1.5 min-w-0 flex-wrap">
        <label className="form-label cursor-pointer" htmlFor={inputId}>
          {label}
        </label>
        {sublabel ? <span className="field-anchor">{sublabel}</span> : null}
        {hint ? (
          <InfoTip id={hintId} tone={hintTone} label={hintLabel}>
            {hint}
          </InfoTip>
        ) : null}
      </span>
      <RxSwitch.Root
        id={inputId}
        className="switch-root"
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
      >
        <RxSwitch.Thumb className="switch-thumb" />
      </RxSwitch.Root>
    </div>
  );
}
