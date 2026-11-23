import { useRef } from "react";
import { Check } from "lucide-react";
import { THEMES, setTheme, useTheme, type ThemeId } from "../../lib/theme";
import { cn } from "./cn";

/**
 * 界面主题选择器:WAI-ARIA radiogroup 语义 + 极简色板预览卡。
 * 方向键遵循 WAI-ARIA radio 组惯例(←/→/↑/↓ 与 Home/End):选中与焦点一起移动
 * (roving tabindex 下只改选中不移焦点会让焦点停在已被 tabindex=-1
 * 的旧按钮上,读屏焦点丢失——审查 M2)。
 */
export function ThemePicker() {
  const theme = useTheme();
  const ids = THEMES.map((t) => t.id);
  const btnRefs = useRef<Partial<Record<ThemeId, HTMLButtonElement | null>>>({});

  const selectAndFocus = (nextId: ThemeId) => {
    setTheme(nextId);
    btnRefs.current[nextId]?.focus();
  };

  return (
    <div
      className="theme-picker"
      role="radiogroup"
      aria-label="界面主题"
      onKeyDown={(e) => {
        if (e.key === "Home") {
          e.preventDefault();
          selectAndFocus(ids[0]);
          return;
        }
        if (e.key === "End") {
          e.preventDefault();
          selectAndFocus(ids[ids.length - 1]);
          return;
        }
        if (
          e.key !== "ArrowLeft" &&
          e.key !== "ArrowRight" &&
          e.key !== "ArrowUp" &&
          e.key !== "ArrowDown"
        )
          return;
        e.preventDefault();
        const idx = ids.indexOf(theme);
        const next =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? (idx + 1) % ids.length
            : (idx - 1 + ids.length) % ids.length;
        selectAndFocus(ids[next] as ThemeId);
      }}
    >
      {THEMES.map((t) => {
        const active = theme === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              btnRefs.current[t.id] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={cn("theme-card", active && "active")}
            onClick={() => setTheme(t.id)}
          >
            <span
              className="flex items-center justify-between gap-2 w-full mb-1"
              aria-hidden="true"
            >
              <span className="theme-card-swatches mb-0">
                {t.swatches.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span
                className={cn(
                  "inline-flex items-center justify-center w-4 h-4 rounded-full border transition-colors shrink-0",
                  active
                    ? "bg-accent border-accent text-accent-ink"
                    : "border-line2 bg-transparent",
                )}
              >
                {active && <Check size={10} strokeWidth={2.75} />}
              </span>
            </span>
            <span className="theme-card-name">{t.name}</span>
            <span className="theme-card-sub">{t.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
