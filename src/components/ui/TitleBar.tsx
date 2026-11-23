import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { THEMES, setTheme, useTheme } from "../../lib/theme";
import { Logo } from "./Logo";

/** 非 Tauri 环境(纯浏览器预览/测试未 mock)下 getCurrentWindow 同步抛异常,
 *  包一层兜底:渲染照常,按钮点击降级为空操作。 */
function tryGetWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * 自绘标题栏(decorations: false 后接管原生标题栏):
 * 左侧品牌 + 中部拖拽区(data-tauri-drag-region,Tauri 内建脚本处理
 * 拖动与双击最大化) + 主题速切钮 + 右侧原生几何窗口控制钮。
 *
 * 注意:Tauri 的拖拽脚本只在 mousedown 目标元素自身带
 * data-tauri-drag-region 时触发,拖拽区内的装饰子元素必须
 * pointer-events: none(见 styles.css .titlebar-drag *),否则点在
 * 文字/图标上无法拖动。
 */
export function TitleBar() {
  const [win] = useState(tryGetWindow);
  const [maximized, setMaximized] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    if (!win) return;
    win
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    const unlisten = win.onResized(() => {
      win
        .isMaximized()
        .then(setMaximized)
        .catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [win]);

  // win 为空(非 Tauri 环境)时点击降级为空操作
  const run = (fn: (w: NonNullable<typeof win>) => Promise<void>) => () => {
    if (win) fn(win).catch(() => {});
  };

  const currentIdx = Math.max(
    0,
    THEMES.findIndex((t) => t.id === theme),
  );
  const nextMeta = THEMES[(currentIdx + 1) % THEMES.length];
  const nextIsVostok = nextMeta.id === "vostok";
  const toggleThemeLabel = `切换至${nextMeta.name}`;

  return (
    <div className="titlebar">
      <div className="titlebar-drag titlebar-brand" data-tauri-drag-region>
        <Logo size={16} />
        <span className="titlebar-title">流光 LUMINA</span>
      </div>
      <div className="titlebar-drag titlebar-spacer" data-tauri-drag-region />
      <button
        type="button"
        className="titlebar-theme-btn"
        aria-label={toggleThemeLabel}
        title={toggleThemeLabel}
        onClick={() => setTheme(nextMeta.id)}
      >
        {nextIsVostok ? (
          /* 构成主义红楔 + 轨道环微标（点击切往东方号 VOSTOK） */
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.25" />
            <polygon points="1.5,2 8.5,5.3 4.8,9" fill="currentColor" />
          </svg>
        ) : (
          /* 精密光学光圈微标（点击切往墨曜 · 暗室） */
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M11.4 5.6A4.5 4.5 0 1 1 8.4 2.6"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
            <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="10.2" cy="3.8" r="1" fill="currentColor" />
          </svg>
        )}
      </button>
      <span className="w-px h-3.5 bg-line self-center shrink-0" aria-hidden="true" />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最小化"
          onClick={run((w) => w.minimize())}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            <path d="M1 5.5H9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={run((w) => w.toggleMaximize())}
        >
          {maximized ? (
            /* Windows 惯例的还原图标:两个错位 1px 方框 */
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <path d="M3 3V1.5h5.5V7H7" stroke="currentColor" strokeWidth="1.15" />
              <rect
                x="1.5"
                y="3"
                width="5.5"
                height="5.5"
                stroke="currentColor"
                strokeWidth="1.15"
              />
            </svg>
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.15" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          aria-label="关闭"
          onClick={run((w) => w.close())}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M1.75 1.75L8.25 8.25M8.25 1.75L1.75 8.25"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
