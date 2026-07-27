import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * 两段式确认按钮:needsConfirm 为真时第一次点击进入武装态,
 * 超时或再次点击前自动复位;为假时单击直接执行。
 * 用于替代原生 window.confirm,把确认留在按钮原处。
 */
export function TwoTapButton({
  label,
  armedLabel,
  armedTitle,
  needsConfirm,
  onConfirm,
  className,
  idle,
  armed,
  timeout = 3500,
}: {
  label: string;
  armedLabel: string;
  armedTitle?: string;
  needsConfirm: boolean;
  onConfirm: () => void;
  className?: string;
  idle: ReactNode;
  armed: ReactNode;
  timeout?: number;
}) {
  const [isArmed, setIsArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const disarm = () => {
    clearTimeout(timer.current);
    setIsArmed(false);
  };

  return (
    <button
      type="button"
      className={cn(className, isArmed && "armed")}
      aria-label={isArmed ? armedLabel : label}
      title={isArmed ? (armedTitle ?? armedLabel) : label}
      onClick={() => {
        if (!needsConfirm || isArmed) {
          disarm();
          onConfirm();
          return;
        }
        setIsArmed(true);
        timer.current = setTimeout(() => setIsArmed(false), timeout);
      }}
    >
      {isArmed ? armed : idle}
    </button>
  );
}
