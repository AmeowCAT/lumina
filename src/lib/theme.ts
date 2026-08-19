import { useSyncExternalStore } from "react";

/**
 * 界面主题注册表与运行时切换。
 *
 * 主题是纯前端偏好：localStorage 持久化，不落后端 Settings。
 * 应用方式：`documentElement.dataset.theme` 作为 CSS 作用域根
 * （默认主题不设 scoped 规则，`vostok` 由 src/theme-vostok.css 接管），
 * 同步更新 <meta name="theme-color"> 供窗口框架取色。
 * index.html 内联引导脚本在首帧前恢复持久化值，避免暗色闪切（FOUC）。
 */
export type ThemeId = "lumina" | "vostok";

export interface ThemeMeta {
  id: ThemeId;
  /** 中文名 */
  name: string;
  /** 英文副标（等宽遥测字） */
  sub: string;
  desc: string;
  /** <meta name="theme-color"> 值，取主题底色 */
  themeColor: string;
  /** 主题卡上的色板预览（目标主题代表色，硬编码，不随当前主题变化） */
  swatches: string[];
}

export const THEMES: ThemeMeta[] = [
  {
    id: "lumina",
    name: "流光 · 暗房金光",
    sub: "LUMINA DARK",
    desc: "默认主题：象牙黑偏棕 + 琥珀金，玻璃与辉光",
    themeColor: "#0d0b09",
    swatches: ["#0d0b09", "#d9a441", "#f5d78e"],
  },
  {
    id: "vostok",
    name: "东方号 VOSTOK",
    sub: "RED WEDGE IN ORBIT",
    desc: "苏俄构成主义 × 太空时代：深空墨蓝 + 纸白 + 苏红斜切",
    themeColor: "#0d1117",
    swatches: ["#0d1117", "#ce241b", "#ffc679"],
  },
];

const STORAGE_KEY = "lumina:theme";
const DEFAULT_THEME: ThemeId = "lumina";

function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** 读取持久化主题；存储不可用或值非法时回落默认主题。 */
export function getStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 把主题落到 DOM：data-theme 供 CSS 作用域，meta theme-color 供窗口框架。 */
export function applyTheme(id: ThemeId) {
  const meta = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = meta.id;
  const el = document.querySelector('meta[name="theme-color"]');
  if (el) el.setAttribute("content", meta.themeColor);
}

/** 模块级当前值：useTheme 的同步快照源，由 initTheme/setTheme 维护。 */
let current: ThemeId = DEFAULT_THEME;
const listeners = new Set<() => void>();

/** 应用启动时调用一次（main.tsx）：读取持久化值并落到 DOM。 */
export function initTheme(): ThemeId {
  current = getStoredTheme();
  applyTheme(current);
  return current;
}

export function setTheme(id: ThemeId) {
  if (!isThemeId(id) || id === current) return;
  current = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 存储不可用时仅做会话内切换 */
  }
  applyTheme(id);
  listeners.forEach((cb) => cb());
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => DEFAULT_THEME,
  );
}
