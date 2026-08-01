import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SamplingPanel } from "../panels/SamplingPanel";

describe("SamplingPanel option fallbacks", () => {
  it("echoes the current sampler/scheduler even when caps omit them", () => {
    render(
      <SamplingPanel
        samplers={["euler"]}
        schedulers={["karras"]}
        sampleMethod="euler"
        scheduler="discrete"
        steps={20}
        txtCfg={7}
        distilled={undefined}
        showDistilled={false}
        betaAlpha={undefined}
        betaBeta={undefined}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText("调度器")).toHaveTextContent("Discrete");
    expect(screen.getByLabelText("采样器")).toHaveTextContent("Euler");
  });
});

describe("SamplingPanel beta scheduler args", () => {
  it("shows alpha/beta sliders only for the beta scheduler", () => {
    const base = {
      samplers: ["euler"],
      schedulers: ["beta", "karras"],
      sampleMethod: "euler",
      steps: 20,
      txtCfg: 7,
      distilled: undefined,
      showDistilled: false,
      betaAlpha: 0.8,
      betaBeta: 0.5,
      onUpdate: vi.fn(),
      onReset: vi.fn(),
    };
    const { rerender } = render(
      <SamplingPanel {...base} scheduler="beta" />
    );

    expect(screen.getByRole("slider", { name: /Beta α/ })).toHaveAttribute(
      "aria-valuetext",
      "0.80"
    );
    expect(screen.getByRole("slider", { name: /Beta β/ })).toHaveAttribute(
      "aria-valuetext",
      "0.50"
    );

    rerender(<SamplingPanel {...base} scheduler="karras" />);

    expect(screen.queryByRole("slider", { name: /Beta α/ })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Beta β/ })).toBeNull();
  });
});

describe("SamplingPanel 默认（自动）选项", () => {
  it("切换调度器后默认选项仍保留", async () => {
    render(
      <SamplingPanel
        samplers={["euler"]}
        schedulers={["karras"]}
        sampleMethod="euler"
        scheduler="karras"
        steps={20}
        txtCfg={7}
        distilled={undefined}
        showDistilled={false}
        betaAlpha={undefined}
        betaBeta={undefined}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("调度器"));
    expect(await screen.findByRole("option", { name: "默认（自动）" })).toBeTruthy();
  });

  it("当前值为 default 哨兵时显示 默认（自动）", () => {
    render(
      <SamplingPanel
        samplers={["euler"]}
        schedulers={["karras"]}
        sampleMethod="default"
        scheduler="default"
        steps={20}
        txtCfg={7}
        distilled={undefined}
        showDistilled={false}
        betaAlpha={undefined}
        betaBeta={undefined}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText("调度器")).toHaveTextContent("默认（自动）");
    expect(screen.getByLabelText("采样器")).toHaveTextContent("默认（自动）");
  });
});
