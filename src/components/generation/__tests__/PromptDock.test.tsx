import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

// Tauri IPC 在 jsdom 不存在：家族探测走 mock（唯一被 PromptDock 调用的 api）。
const apiMocks = vi.hoisted(() => ({ detectFamily: vi.fn() }));
vi.mock("../../../api", () => ({ api: apiMocks }));

import { useStore } from "../../../store";
import { PromptDock, estimatePromptTokens } from "../PromptDock";

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
      sizeStep={1}
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
    />,
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

  // 从元数据/上游默认值恢复的 CFG 可能带 float 尾巴，chip 文案同样要收敛。
  it("collapses float noise in the CFG chip", () => {
    renderDock({ txtCfg: 0.30000001192092896 });
    expect(screen.getByRole("button", { name: "CFG 0.3" })).toBeTruthy();
  });

  it("offers width and height sliders from the size chip", async () => {
    const user = userEvent.setup();
    renderDock();

    await user.click(screen.getByRole("button", { name: "512×768" }));

    expect(await screen.findByRole("slider", { name: "宽度" })).toHaveAttribute(
      "aria-valuenow",
      "512",
    );
    expect(screen.getByRole("slider", { name: "高度" })).toHaveAttribute("aria-valuenow", "768");
  });

  it("steps width and height by the configured pixel step", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderDock({ sizeStep: 32 });

    await user.click(screen.getByRole("button", { name: "512×768" }));

    const width = await screen.findByRole("slider", { name: "宽度" });
    width.focus();
    await user.keyboard("{ArrowRight}");
    expect(onUpdate).toHaveBeenCalledWith("width", 544);

    const height = screen.getByRole("slider", { name: "高度" });
    height.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onUpdate).toHaveBeenCalledWith("height", 736);
  });

  it("keeps single-pixel stepping as the default", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderDock();

    await user.click(screen.getByRole("button", { name: "512×768" }));
    const width = await screen.findByRole("slider", { name: "宽度" });
    width.focus();
    await user.keyboard("{ArrowRight}");

    expect(onUpdate).toHaveBeenCalledWith("width", 513);
  });

  it("deep-links from a popover into the full params sheet", async () => {
    const user = userEvent.setup();
    const { onOpenSheet } = renderDock();

    await user.click(screen.getByRole("button", { name: "512×768" }));
    await user.click(await screen.findByRole("button", { name: /尺寸与种子全部设置/ }));

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

    await user.click(screen.getByRole("button", { name: "插入 LingBot JSON 模板" }));
    expect(onInsertLingbot).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认替换当前提示词" }));
    expect(onInsertLingbot).toHaveBeenCalledTimes(1);
  });

  it("inserts immediately when the prompt is empty", async () => {
    const user = userEvent.setup();
    const onInsertLingbot = vi.fn();
    renderDock({ showLingbotTools: true, prompt: "", onInsertLingbot });

    await user.click(screen.getByRole("button", { name: "插入 LingBot JSON 模板" }));
    expect(onInsertLingbot).toHaveBeenCalledTimes(1);
  });
});

/**
 * 提示词 token 计数（审查 F-17）：上限只能来自 FAMILY_CONFIG 的
 * promptTokenLimit（Iris-3B = 300），前端不得写死上限表。
 */
describe("PromptDock 提示词 token 计数", () => {
  afterEach(() => {
    cleanup();
    useStore.setState({ caps: null, mainModel: "", familyOverride: "" });
    apiMocks.detectFamily.mockReset();
  });

  it("按字符数/3.5 向上取整（纯函数）", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abc")).toBe(1);
    expect(estimatePromptTokens("abcdefg")).toBe(2);
  });

  it("没有已知上限的家族只显示估算值", () => {
    renderDock({ prompt: "abcdefg" });
    const counter = screen.getByText("≈2 tokens");
    expect(counter).toBeInTheDocument();
    expect(counter.getAttribute("title")).toContain("按字符数/3.5 粗估");
  });

  it("从家族配置读上限：超限用 warn 色并说明会被内核截断", () => {
    useStore.setState({
      caps: { model: { path: "D:/models/iris-3b.safetensors" } } as never,
      mainModel: "D:/models/iris-3b.safetensors",
      familyOverride: "iris",
    });
    // 1051 字符 → ceil(1051 / 3.5) = 301 tokens，恰好越过 Iris-3B 的 300
    renderDock({ prompt: "x".repeat(1051) });

    const counter = screen.getByText("≈301 / 300 tokens");
    expect(counter).toHaveClass("text-warn");
    expect(counter.getAttribute("title")).toContain("截断");
    expect(counter.getAttribute("title")).toContain("300");
  });

  it("未超限时用 muted 色，且计数与输入框关联", () => {
    useStore.setState({
      caps: { model: { path: "D:/models/iris-3b.safetensors" } } as never,
      mainModel: "D:/models/iris-3b.safetensors",
      familyOverride: "iris",
    });
    // 350 字符 → 100 tokens
    renderDock({ prompt: "y".repeat(350) });

    const counter = screen.getByText("≈100 / 300 tokens");
    expect(counter).toHaveClass("text-muted");
    expect(screen.getByLabelText("正向提示词")).toHaveAttribute(
      "aria-describedby",
      "prompt-token-count",
    );
  });

  it("没有显式覆盖时用 detect_family 的结果取上限", async () => {
    apiMocks.detectFamily.mockResolvedValue("iris");
    useStore.setState({
      caps: { model: { path: "D:/models/unknown-model.safetensors" } } as never,
      mainModel: "D:/models/unknown-model.safetensors",
      familyOverride: "",
    });
    renderDock({ prompt: "" });

    expect(await screen.findByText("≈0 / 300 tokens")).toBeInTheDocument();
    expect(apiMocks.detectFamily).toHaveBeenCalledWith("D:/models/unknown-model.safetensors");
  });
});
