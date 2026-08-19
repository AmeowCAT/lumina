import { THEMES, setTheme, useTheme, type ThemeId } from "../../lib/theme";
import { cn } from "./cn";

/**
 * 界面主题选择器:radiogroup 语义 + 色板预览卡。
 * 方向键遵循 radio 组惯例(←/→/↑/↓ 切换选中),roving tabindex 与
 * mode-tabs 的键盘模式一致——只移动选中态,不抢夺焦点。
 */
export function ThemePicker() {
  const theme = useTheme();
  const ids = THEMES.map((t) => t.id);
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
        setTheme(ids[next] as ThemeId);
      }}
    >
      {THEMES.map((t) => {
        const active = theme === t.id;
        return (
          <button
            key={t.id}
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
            <span className="theme-card-desc">{t.desc}</span>
          </button>
        );
      })}
    </div>
  );
}
