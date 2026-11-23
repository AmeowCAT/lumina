import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "./cn";

export interface InfoTipProps {
  children: ReactNode;
  /** 可选 DOM id（供 Slider / Toggle / Input 的 aria-describedby 直接关联） */
  id?: string;
  /** 触发徽章内附带的短标签（如 "说明"、"DGL"、"注意"），不传则仅显示 ⓘ 图标 */
  label?: ReactNode;
  /** 视觉强调级别：default 为安静微标，accent 为强调提示，warn 为风险/前提警示 */
  tone?: "default" | "accent" | "warn";
  /** 是否显示 5px 醒目圆点（tone 为 accent/warn 且无 label 时默认可根据需要开启） */
  dot?: boolean;
  /** 触发按钮的无障碍标签 */
  ariaLabel?: string;
  /** 浮层水平对齐方向：auto（默认，靠近视口右缘时自动右对齐）、left、right */
  align?: "auto" | "left" | "right";
  /** 浮层垂直弹出方向：bottom（默认）或 top */
  side?: "bottom" | "top";
  className?: string;
}

/**
 * 渐进式信息披露微标（Tier 1 `ⓘ` Info Popover）：
 * - 常态下将长句说明收纳为紧凑的 `ⓘ` 微标（或带短词的胶囊），彻底消除静态多行副标签造成的纵向拥挤。
 * - 支持悬停（`:hover`）、键盘聚焦（`:focus-within`）与点击钉住（`data-open="true"`）展开浮层，按 `Esc` 或点击外部关闭。
 * - 说明文本节点始终挂载在 DOM 内（`.info-popover`），确保 `aria-describedby` 读屏关联与单元测试文本检索零回归。
 */
export function InfoTip({
  children,
  id,
  label,
  tone = "default",
  dot,
  ariaLabel,
  align = "auto",
  side = "bottom",
  className,
}: InfoTipProps) {
  const generatedId = useId();
  const popoverId = id || generatedId;
  const [open, setOpen] = useState(false);
  const [autoRight, setAutoRight] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  const syncAutoAlign = () => {
    if (align !== "auto" || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    if (rect.width > 0 && typeof window !== "undefined" && window.innerWidth > 0) {
      setAutoRight(rect.left + 260 > window.innerWidth - 20);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const resolvedAriaLabel =
    ariaLabel ?? (typeof label === "string" && label ? `查看${label}说明` : "查看说明");
  const isRight = align === "right" || (align === "auto" && autoRight);
  const showDot = dot ?? tone === "warn";

  return (
    <span
      ref={rootRef}
      className={cn(
        "info-tip",
        tone === "accent" && "info-tip-accent",
        tone === "warn" && "info-tip-warn",
        isRight && "info-tip-right",
        side === "top" && "info-tip-top",
        className,
      )}
      data-open={open ? "true" : undefined}
      onPointerEnter={syncAutoAlign}
      onFocusCapture={syncAutoAlign}
    >
      <button
        type="button"
        className={cn(
          "info-trigger",
          tone === "accent" && "info-trigger-accent",
          tone === "warn" && "info-trigger-warn",
        )}
        aria-label={resolvedAriaLabel}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          syncAutoAlign();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {showDot ? <span className="info-trigger-dot" aria-hidden="true" /> : null}
        <Info size={11} strokeWidth={2.1} aria-hidden="true" />
        {label ? <span className="info-trigger-label">{label}</span> : null}
      </button>
      <span
        id={popoverId}
        className={cn(
          "info-popover",
          isRight && "info-popover-right",
          side === "top" && "info-popover-top",
        )}
      >
        {children}
      </span>
    </span>
  );
}
