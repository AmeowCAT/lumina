import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { HighNoisePanel } from "../panels/HighNoisePanel";

describe("HighNoisePanel beta scheduler args", () => {
  it("shows alpha/beta sliders only for the beta scheduler", () => {
    const base = {
      samplers: ["euler"],
      schedulers: ["beta", "karras"],
      hsp: { scheduler: "beta", guidance: { txt_cfg: 3.5 } },
      fallbackSampleMethod: "euler",
      fallbackScheduler: "discrete",
      moeBoundary: 0.8,
      showDistilled: false,
      betaAlpha: 0.7,
      betaBeta: undefined,
      onUpdate: vi.fn(),
    };
    const { rerender } = render(<HighNoisePanel {...base} />);

    expect(screen.getByRole("slider", { name: /Beta α/ })).toHaveAttribute(
      "aria-valuetext",
      "0.70"
    );
    expect(screen.getByRole("slider", { name: /Beta β/ })).toHaveAttribute(
      "aria-valuetext",
      "0.60"
    );

    rerender(
      <HighNoisePanel
        {...base}
        hsp={{ scheduler: "karras", guidance: { txt_cfg: 3.5 } }}
      />
    );

    expect(screen.queryByRole("slider", { name: /Beta α/ })).toBeNull();
    expect(screen.queryByRole("slider", { name: /Beta β/ })).toBeNull();
  });
});

describe("HighNoisePanel 默认（自动）选项", () => {
  it("切换调度器后默认选项仍保留", async () => {
    render(
      <HighNoisePanel
        samplers={["euler"]}
        schedulers={["karras"]}
        hsp={{ scheduler: "karras", guidance: { txt_cfg: 3.5 } }}
        fallbackSampleMethod="euler"
        fallbackScheduler="discrete"
        moeBoundary={0.8}
        showDistilled={false}
        betaAlpha={undefined}
        betaBeta={undefined}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("调度器"));
    expect(await screen.findByRole("option", { name: "默认（自动）" })).toBeTruthy();
  });
});
