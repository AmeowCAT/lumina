import { useRef } from "react";
import { THEMES, setTheme, useTheme, type ThemeId } from "../../lib/theme";
import { cn } from "./cn";

/**
 * 界面主题选择器:radiogroup 语义 + 色板预览卡。
 * 方向键遵循 WAI-ARIA radio 组惯例(←/→/↑/↓):选中与焦点一起移动
 * (roving tabindex 下只改选中不移焦点会让焦点停在已被 tabindex=-1
 * 的旧按钮上,读屏焦点丢失——审查 M2)。
 */
export function ThemePicker() {
  const theme = useTheme();
  const ids = THEMES.map((t) => t.id);
  const btnRefs = useRef<Partial<Record<ThemeId, HTMLButtonElement | null>>>({});
  return (
    <div
      className="theme-picker"
      role="radiogroup"
      aria-label="界面主题"
      onKeyDown={(e) => {
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
        const nextId = ids[next] as ThemeId;
        setTheme(nextId);
        btnRefs.current[nextId]?.focus();
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
            <span className="theme-card-swatches" aria-hidden="true">
              {t.swatches.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            <span className="theme-card-name">{t.name}</span>
            <span className="theme-card-sub">{t.sub}</span>
          </button>
        );
      })}
    </div>
  );
}
