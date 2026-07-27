import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { PromptDock } from "../PromptDock";

function renderDock(overrides: Record<string, unknown> = {}) {
  const onUpdate = vi.fn();
  const onOpenSheet = vi.fn();
  render(
    <PromptDock
      prompt=""
      negative=""
      negativeVisible={false}
      seedRandom={false}
      submitting={false}
      generating={false}
      disabled={false}
      showLingbotTools={false}
      width={512}
      height={768}
      steps={20}
      txtCfg={7}
      limits={undefined}
      onUpdate={onUpdate}
      onToggleNegative={vi.fn()}
      onRandomSeed={vi.fn()}
      onGenerate={vi.fn()}
      onInsertLingbot={vi.fn()}
      onOpenSheet={onOpenSheet}
      {...overrides}
    />
  );
  return { onUpdate, onOpenSheet };
}

describe("PromptDock chip editors", () => {
  it("opens the steps chip popover and edits steps in place", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderDock();

    await user.click(screen.getByRole("button", { name: "步数 20" }));

    const slider = await screen.findByRole("slider", { name: "步数" });
    expect(slider).toHaveAttribute("aria-valuenow", "20");
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(onUpdate).toHaveBeenCalledWith("sample_params.sample_steps", 21);
  });

  it("edits CFG with half-step precision from its chip", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderDock();

    await user.click(screen.getByRole("button", { name: "CFG 7" }));

    const slider = await screen.findByRole("slider", { name: "CFG (文本)" });
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(onUpdate).toHaveBeenCalledWith("sample_params.guidance.txt_cfg", 7.5);
  });

  it("offers width and height sliders from the size chip", async () => {
    const user = userEvent.setup();
    renderDock();

    await user.click(screen.getByRole("button", { name: "512×768" }));

    expect(
      await screen.findByRole("slider", { name: "宽度" })
    ).toHaveAttribute("aria-valuenow", "512");
    expect(screen.getByRole("slider", { name: "高度" })).toHaveAttribute(
      "aria-valuenow",
      "768"
    );
  });

  it("deep-links from a popover into the full params sheet", async () => {
    const user = userEvent.setup();
    const { onOpenSheet } = renderDock();

    await user.click(screen.getByRole("button", { name: "512×768" }));
    await user.click(
      await screen.findByRole("button", { name: /尺寸与种子全部设置/ })
    );

    expect(onOpenSheet).toHaveBeenCalledWith("size");
  });
});

describe("PromptDock LingBot insert", () => {
  it("arms before replacing a non-empty prompt", async () => {
    const user = userEvent.setup();
    const onInsertLingbot = vi.fn();
    renderDock({
      showLingbotTools: true,
      prompt: "existing prompt",
      onInsertLingbot,
    });

    await user.click(
      screen.getByRole("button", { name: "插入 LingBot JSON 模板" })
    );
    expect(onInsertLingbot).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "确认替换当前提示词" })
    );
    expect(onInsertLingbot).toHaveBeenCalledTimes(1);
  });

  it("inserts immediately when the prompt is empty", async () => {
    const user = userEvent.setup();
    const onInsertLingbot = vi.fn();
    renderDock({ showLingbotTools: true, prompt: "", onInsertLingbot });

    await user.click(
      screen.getByRole("button", { name: "插入 LingBot JSON 模板" })
    );
    expect(onInsertLingbot).toHaveBeenCalledTimes(1);
  });
});
