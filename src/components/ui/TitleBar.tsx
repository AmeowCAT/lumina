import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
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
 * 拖动与双击最大化) + 右侧窗口控制钮。
 *
 * 注意:Tauri 的拖拽脚本只在 mousedown 目标元素自身带
 * data-tauri-drag-region 时触发,拖拽区内的装饰子元素必须
 * pointer-events: none(见 styles.css .titlebar-drag *),否则点在
 * 文字/图标上无法拖动。
 */
export function TitleBar() {
  const [win] = useState(tryGetWindow);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [win]);

  // win 为空(非 Tauri 环境)时点击降级为空操作
  const run =
    (fn: (w: NonNullable<typeof win>) => Promise<void>) => () => {
      if (win) fn(win).catch(() => {});
    };

  return (
    <div className="titlebar">
      <div className="titlebar-drag titlebar-brand" data-tauri-drag-region>
        <Logo size={14} />
        <span className="titlebar-title">流光 LUMINA</span>
      </div>
      <div className="titlebar-drag titlebar-spacer" data-tauri-drag-region />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最小化"
          onClick={run((w) => w.minimize())}
        >
          <Minus size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={run((w) => w.toggleMaximize())}
        >
          {maximized ? (
            /* Windows 惯例的还原图标:两个错位方框 */
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3.6 3.6V1.4h7v7H8.4" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1.4" y="3.6" width="7" height="7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <Square size={11} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          aria-label="关闭"
          onClick={run((w) => w.close())}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
