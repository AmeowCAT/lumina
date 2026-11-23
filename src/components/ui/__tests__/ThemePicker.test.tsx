import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemePicker } from "../ThemePicker";
import { THEMES, initTheme } from "../../../lib/theme";

describe("ThemePicker 主题选择器", () => {
  beforeEach(() => {
    localStorage.clear();
    initTheme();
  });

  it("以 radiogroup 渲染全部注册主题", () => {
    render(<ThemePicker />);
    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(THEMES.length);
    expect(screen.getByRole("radio", { name: /墨曜 · 暗室/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /东方号 VOSTOK/ })).toBeInTheDocument();
  });

  it("默认选中 lumina，点击东方号 VOSTOK 后切换选中态并持久化", async () => {
    render(<ThemePicker />);
    const lumina = screen.getByRole("radio", { name: /墨曜 · 暗室/ });
    const vostok = screen.getByRole("radio", { name: /东方号 VOSTOK/ });
    expect(lumina).toHaveAttribute("aria-checked", "true");
    expect(vostok).toHaveAttribute("aria-checked", "false");
    await userEvent.click(vostok);
    expect(vostok).toHaveAttribute("aria-checked", "true");
    expect(lumina).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("lumina:theme")).toBe("vostok");
    expect(document.documentElement.dataset.theme).toBe("vostok");
  });

  it("方向键与 Home/End 按 radio 组惯例切换选中并同步焦点", () => {
    render(<ThemePicker />);
    const group = screen.getByRole("radiogroup", { name: "界面主题" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    const vostok = screen.getByRole("radio", { name: /东方号 VOSTOK/ });
    expect(vostok).toHaveAttribute("aria-checked", "true");
    // APG radio 模式:焦点跟随选中一起移动(审查 M2)。
    expect(vostok).toHaveFocus();
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    const lumina = screen.getByRole("radio", { name: /墨曜 · 暗室/ });
    expect(lumina).toHaveAttribute("aria-checked", "true");
    expect(lumina).toHaveFocus();
    fireEvent.keyDown(group, { key: "End" });
    expect(vostok).toHaveAttribute("aria-checked", "true");
    expect(vostok).toHaveFocus();
    fireEvent.keyDown(group, { key: "Home" });
    expect(lumina).toHaveAttribute("aria-checked", "true");
    expect(lumina).toHaveFocus();
  });
});
