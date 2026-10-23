import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  onGenerate: () => void;
  onRandomSeed: () => void;
  onEscape: () => void;
  /** 任一浮层打开时为 true：Esc 交给浮层处理。 */
  escapeActive: boolean;
  /**
   * 后台快捷键（Ctrl/⌘+Enter 提交、Ctrl/⌘+R 换种子）是否必须让位。
   * 与 `escapeActive` 分开：参数面板打开时提交仍合理（用户可能就想提交），
   * 而 Lightbox / 队列抽屉 / 放大对话框下误触提交等于白烧几分钟 GPU（审查 F-03）。
   */
  blockBackgroundShortcuts?: boolean;
}

/**
 * 全局快捷键。
 *
 * 三处与旧实现的差别（审查 F-01 / F-02 / F-03）：
 * 1. 用 `e.code` 而不是 `e.key`——`e.key` 受键盘布局与 CapsLock 影响，
 *    非美式布局/大写锁定时 `Ctrl+R` 拦不住，会落到 WebView2 的刷新上，
 *    而结果只在内存里（刷新 = 丢整批结果）。
 * 2. 认 `metaKey`（macOS 的 Cmd），与 `Ctrl+,` 的口径一致。
 * 3. 尊重 `defaultPrevented`：Radix 的 Select/Popover 在 Esc 上会自己关闭并
 *    `preventDefault()`，旧实现会让同一次按键继续往下关掉参数面板。
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const genRef = useRef(handlers.onGenerate);
  const seedRef = useRef(handlers.onRandomSeed);
  const escRef = useRef(handlers.onEscape);
  genRef.current = handlers.onGenerate;
  seedRef.current = handlers.onRandomSeed;
  escRef.current = handlers.onEscape;
  const escapeActiveRef = useRef(handlers.escapeActive);
  escapeActiveRef.current = handlers.escapeActive;
  const blockedRef = useRef(handlers.blockBackgroundShortcuts ?? false);
  blockedRef.current = handlers.blockBackgroundShortcuts ?? false;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // 已被浮层/输入控件消费的按键不再重复处理。
      if (e.defaultPrevented) return;
      // 输入法组合期间的 Enter/Escape 属于候选词交互。
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      const blocked = blockedRef.current;
      if (mod && !blocked && !e.repeat && (e.code === "Enter" || e.code === "NumpadEnter")) {
        e.preventDefault();
        genRef.current();
        return;
      }
      if (mod && !blocked && !e.repeat && !e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        seedRef.current();
        return;
      }
      if (e.key === "Escape" && escapeActiveRef.current) escRef.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}
