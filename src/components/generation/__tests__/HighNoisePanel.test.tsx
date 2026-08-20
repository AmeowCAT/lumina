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

// 高噪段有独立的 extra_sample_args（上游 high_noise_extra_sample_args）。
describe("HighNoisePanel lms/extra args", () => {
  const base = {
    samplers: ["euler", "lms"],
    schedulers: ["karras"],
    fallbackSampleMethod: "euler",
    fallbackScheduler: "karras",
    moeBoundary: 0.8,
    showDistilled: false,
    betaAlpha: undefined,
    betaBeta: undefined,
    onUpdate: vi.fn(),
  };

  it("shows the lms controls only when the high-noise sampler is lms", () => {
    const { rerender } = render(
      <HighNoisePanel
        {...base}
        hsp={{ sample_method: "lms", lms_shift: 0, guidance: { txt_cfg: 3.5 } }}
      />
    );

    expect(screen.getByRole("slider", { name: /LMS 阶数 \(高噪\)/ })).toHaveAttribute(
      "aria-valuetext",
      "4"
    );
    expect(
      screen.getByRole("slider", { name: /LMS 历史偏移 \(高噪\)/ })
    ).toHaveAttribute("aria-valuetext", "0");

    rerender(
      <HighNoisePanel
        {...base}
        hsp={{ sample_method: "euler", guidance: { txt_cfg: 3.5 } }}
      />
    );

    expect(screen.queryByRole("slider", { name: /LMS 阶数 \(高噪\)/ })).toBeNull();
  });

  it("edits the high-noise extra_sample_args on its own path", () => {
    const onUpdate = vi.fn();
    render(
      <HighNoisePanel
        {...base}
        hsp={{ sample_method: "euler", guidance: { txt_cfg: 3.5 } }}
        onUpdate={onUpdate}
      />
    );

    fireEvent.change(screen.getByLabelText("额外采样参数 (高噪)"), {
      target: { value: "gamma=4" },
    });

    expect(onUpdate).toHaveBeenCalledWith(
      "high_noise_sample_params.extra_sample_args",
      "gamma=4"
    );
  });
});
