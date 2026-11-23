import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { THEMES, applyTheme, getStoredTheme, initTheme, setTheme, useTheme } from "../lib/theme";

/** 每个用例前清空存储并把模块快照重置回默认主题。 */
function resetTheme() {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", "#111214");
  initTheme();
}

describe("lib/theme 主题注册表与状态", () => {
  beforeEach(resetTheme);

  it("无持久化值时默认 lumina", () => {
    expect(getStoredTheme()).toBe("lumina");
  });

  it("读取 localStorage 中的合法主题", () => {
    localStorage.setItem("lumina:theme", "vostok");
    expect(getStoredTheme()).toBe("vostok");
  });

  it("临时 daylight 持久化值平滑迁移到 vostok", () => {
    localStorage.setItem("lumina:theme", "daylight");
    expect(getStoredTheme()).toBe("vostok");
    expect(initTheme()).toBe("vostok");
    expect(document.documentElement.dataset.theme).toBe("vostok");
  });

  it("非法持久化值回落默认主题", () => {
    localStorage.setItem("lumina:theme", "not-a-theme");
    expect(getStoredTheme()).toBe("lumina");
  });

  it("注册表每项都有完整展示元信息", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["lumina", "vostok"]);
    for (const t of THEMES) {
      expect(t.name).toBeTruthy();
      expect(t.sub).toBeTruthy();
      expect(["dark", "light"]).toContain(t.appearance);
      expect(t.themeColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.swatches.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("applyTheme 落到 data-theme、colorScheme 与 meta theme-color", () => {
    applyTheme("vostok");
    expect(document.documentElement.dataset.theme).toBe("vostok");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#110e0b",
    );
    applyTheme("lumina");
    expect(document.documentElement.dataset.theme).toBe("lumina");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#111214",
    );
  });

  it("setTheme 持久化并同步 DOM", () => {
    setTheme("vostok");
    expect(localStorage.getItem("lumina:theme")).toBe("vostok");
    expect(document.documentElement.dataset.theme).toBe("vostok");
  });

  it("useTheme 跟随 setTheme 更新", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe("lumina");
    act(() => setTheme("vostok"));
    expect(result.current).toBe("vostok");
    act(() => setTheme("lumina"));
    expect(result.current).toBe("lumina");
  });
});
