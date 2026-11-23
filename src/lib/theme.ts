import { useSyncExternalStore } from "react";

/**
 * 界面主题注册表与运行时切换。
 *
 * 主题是纯前端偏好：localStorage 持久化，不落后端 Settings。
 * 应用方式：`documentElement.dataset.theme` 作为 CSS 作用域根
 * （默认暗室主题 `lumina` 定义在 src/styles.css，`vostok` 由 src/theme-vostok.css 接管），
 * 同步更新 `color-scheme` 与 `<meta name="theme-color">` 供窗口框架取色。
 * index.html 内联引导脚本在首帧前恢复持久化值，避免闪切（FOUC）。
 */
export type ThemeId = "lumina" | "vostok";

export interface ThemeMeta {
  id: ThemeId;
  /** 中文名 */
  name: string;
  /** 英文副标（等宽遥测字） */
  sub: string;
  /** 亮暗外观模式，驱动原生滚动条与表单控件配色 */
  appearance: "dark" | "light";
  /** <meta name="theme-color"> 值，取主题画布底色 */
  themeColor: string;
  /** 主题卡上的色板预览（目标主题代表色，硬编码，不随当前主题变化） */
  swatches: string[];
}

export const THEMES: ThemeMeta[] = [
  {
    id: "lumina",
    name: "墨曜 · 暗室",
    sub: "OBSIDIAN STUDIO",
    appearance: "dark",
    themeColor: "#111214",
    swatches: ["#111214", "#1c1e22", "#f2f3f5"],
  },
  {
    id: "vostok",
    name: "东方号 VOSTOK",
    sub: "RED WEDGE IN ORBIT",
    appearance: "dark",
    themeColor: "#110e0b",
    swatches: ["#110e0b", "#cf3616", "#efeadd"],
  },
];

const STORAGE_KEY = "lumina:theme";
const DEFAULT_THEME: ThemeId = "lumina";

/** 临时主题 ID 的平滑迁移表。 */
const LEGACY_THEME_MAP: Record<string, ThemeId> = {
  daylight: "vostok",
};

function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** 读取持久化主题；兼容旧主题迁移，存储不可用或值非法时回落默认主题。 */
export function getStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(v)) return v;
    if (v && v in LEGACY_THEME_MAP) return LEGACY_THEME_MAP[v];
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 把主题落到 DOM：data-theme 供 CSS 作用域，color-scheme 与 meta theme-color 供窗口框架。 */
export function applyTheme(id: ThemeId) {
  const meta = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.dataset.theme = meta.id;
  document.documentElement.style.colorScheme = meta.appearance;
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
