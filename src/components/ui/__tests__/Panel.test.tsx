import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { Panel } from "../Panel";

function renderPanel(props: { collapsed?: boolean; forceOpen?: boolean }) {
  return render(
    <Panel title="尺寸与种子" {...props}>
      <span>面板内容</span>
    </Panel>
  );
}

describe("Panel", () => {
  it("opens once when forceOpen arrives, then lets the user collapse again", () => {
    // 深链：chip 点击 → sheetTarget="size" → forceOpen 变 true。
    const { rerender } = renderPanel({ collapsed: true });

    const head = screen.getByRole("button", { name: "尺寸与种子" });
    expect(head).toHaveAttribute("aria-expanded", "false");

    rerender(<Panel title="尺寸与种子" forceOpen>{<span>面板内容</span>}</Panel>);
    expect(head).toHaveAttribute("aria-expanded", "true");

    // 用户点标题收起：forceOpen 仍为 true，但必须生效。
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");

    // 再点展开，往返正常。
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
  });

  it("stays collapsed while forceOpen stays false", () => {
    renderPanel({ collapsed: true });
    const head = screen.getByRole("button", { name: "尺寸与种子" });
    expect(head).toHaveAttribute("aria-expanded", "false");
  });

  it("re-opens on a later forceOpen edge after a manual collapse", () => {
    const { rerender } = renderPanel({ collapsed: false, forceOpen: true });
    const head = screen.getByRole("button", { name: "尺寸与种子" });

    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");

    // 关掉 Sheet（forceOpen 回落 false）再点另一个 chip（重新变 true），
    // 面板应再次被展开。
    rerender(<Panel title="尺寸与种子">{<span>面板内容</span>}</Panel>);
    rerender(<Panel title="尺寸与种子" forceOpen>{<span>面板内容</span>}</Panel>);
    expect(head).toHaveAttribute("aria-expanded", "true");
  });
});
